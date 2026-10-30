import * as fs from 'fs';
import * as path from 'path';
import { S3Reader } from './awsS3';
import { s3Root } from './env';
import { Language, TechniqueTool, parseLanguages, toolsFor } from './techniqueTools';
import { mergeTaxonomy } from './mergeTaxonomy';
import { validatePython, summaryLine } from './pyValidate';
import { writeBugReports } from './bugReport';
import { validateJavaScript, jsSummaryLine } from './jsValidate';
import { validateCSharp, csSummaryLine } from './csValidate';
import { validateJava, javaSummaryLine } from './javaValidate';
import { validateTypeScript, tsSummaryLine } from './tsValidate';
import { analyseFile, detectLanguages, verdict, Verdict } from './s3Check';

function branchLanguages(bd: string): { languages: Language[]; source: string; ignored: string[] } {
  if (process.env.LANGUAGE) return { ...parseLanguages(process.env.LANGUAGE.split(',')), source: 'LANGUAGE env' };
  const f = path.join(bd, 'repo-details.json');
  if (fs.existsSync(f)) {
    const r = parseLanguages(JSON.parse(fs.readFileSync(f, 'utf8')).languages || []);
    if (r.languages.length) return { ...r, source: 'coverage preview' };
  }
  // no "Repository details" was read (e.g. the site said "This commit is already analyzed" and skipped the preview):
  // our test branches are named <LANG>_<version>_… — JS_ / TS_ / PY_ / CS_ — so the prefix tells the language
  const pre = path.basename(bd).split('_')[0].toUpperCase();
  const byPrefix: Record<string, string[]> = { JS: ['JavaScript'], TS: ['TypeScript'], PY: ['Python'], CS: ['C#'], JV: ['Java'] };
  if (byPrefix[pre]) {
    const r = parseLanguages(byPrefix[pre]);
    if (r.languages.length) return { ...r, source: `branch name prefix "${pre}_" (no repo-details.json)` };
  }
  return { languages: ['javascript'], source: 'default (no repo-details.json, branch name has no JS_/TS_/PY_/CS_/JV_ prefix)', ignored: [] };
}

interface ToolJson { key: string; empty: boolean; note: string; langs: Language[] }
interface ToolScan { found?: string; tried: string[]; jsons: ToolJson[]; otherFiles: number }

/** True when AWS keys / profile are configured in .env. */
export const hasAwsCredentials = () => !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_WEB_IDENTITY_TOKEN_FILE);

/**
 * S3 evidence for ONE branch folder (needs run-details.json in it): reads the tool folders of that run,
 * writes s3-check.json / s3-folders.json / s3-evidence/ and rebuilds the taxonomy report with the S3 columns.
 */
export async function checkBranchS3(bd: string, s3: S3Reader = new S3Reader(), repo?: string): Promise<void> {
  const r = JSON.parse(fs.readFileSync(path.join(bd, 'run-details.json'), 'utf8'));
  const base = `${s3Root}${r.tenant_id}/${r.project_id}/${r.repository_id}/${r.branch_id}/${r.branch_name}/${r.commit_sha}/${r.run_id}/`;
  await s3.check(base);
  const { languages, source, ignored } = branchLanguages(bd);
  console.log(`\n  ${r.branch_name}  run ${r.run_id}\n  Languages (${source}): ${languages.join(', ')}${ignored.length ? `   [no tool map yet for: ${ignored.join(', ')}]` : ''}`);

  // every tool folder that really exists for this run (so wrong / guessed folder names can be corrected)
  const top = await s3.list(base);
  const inventory: Record<string, string[]> = {};
  for (const f of top.folders) { const w = await s3.walk(f); inventory[f.slice(base.length)] = w.files.map((k) => k.slice(f.length)); }
  fs.writeFileSync(path.join(bd, 's3-folders.json'), JSON.stringify(inventory, null, 2));
  // short excerpt of every json / xml in the run (s3-files.json) — to review what each tool really wrote
  const heads: Record<string, string> = {};
  let nHeads = 0; let headFails = 0;
  for (const [folder, files] of Object.entries(inventory)) {
    for (const f of files) {
      if (!/\.(json|xml|txt)$/i.test(f) || nHeads >= 200) continue;
      try { heads[`${folder}${f}`] = await s3.readHead(`${base}${folder}${f}`); nHeads++; }
      catch (e: any) {
        headFails++;
        if (headFails <= 2) console.log(`  S3 read problem (${folder}${f}): ${e?.name || ''} ${String(e?.message || e).slice(0, 140)}`);
        if (/ExpiredToken|InvalidToken|InvalidAccessKeyId/i.test(`${e?.name} ${e?.message}`)) throw new Error('AWS keys expired while reading the S3 evidence — copy fresh keys from the AWS portal (QA-S3-Readonly → Access keys) into .env and run the "S3 evidence" test again (S3_FORCE=1 if it was already checked).');
        if (headFails >= 5) throw new Error(`S3 reads keep failing (${headFails} files) — last: ${String(e?.message || e).slice(0, 140)}`);
      }
    }
  }
  fs.writeFileSync(path.join(bd, 's3-files.json'), JSON.stringify(heads, null, 2));
  console.log(`  Tool folders in S3 (${Object.keys(inventory).length}):`);
  for (const [k, v] of Object.entries(inventory)) console.log(`    ${k}  (${v.length} files)  ${v.slice(0, 4).join(', ')}`);

  const normName = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const folderByName = new Map(Object.keys(inventory).map((f) => [normName(f), f.replace(/\/$/, '')]));
  const cache = new Map<string, ToolScan>();
  const scan = async (candidates: string[]): Promise<ToolScan> => {
    const key = candidates.join('|');
    if (cache.has(key)) return cache.get(key)!;
    const out: ToolScan = { tried: candidates, jsons: [], otherFiles: 0 };
    for (const tool of candidates) {
      const real = folderByName.get(normName(tool)); // same name as in the tool list, ignoring case, spaces, - and _
      if (!real) continue;
      const walked = await s3.walk(`${base}${real}/`);
      if (!walked.exists) continue;
      out.found = tool;
      const jsonKeys = walked.files.filter((k) => /\.(json|xml)$/i.test(k)).slice(0, 50);
      out.otherFiles = walked.files.length - jsonKeys.length;
      for (const k of jsonKeys) {
        try {
          const text = await s3.readText(k);
          const dest = path.join(bd, 's3-evidence', k.slice(base.length));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, text);
          out.jsons.push({ key: k.slice(base.length), ...analyseFile(k, text), langs: detectLanguages(text) });
        } catch (e) { out.jsons.push({ key: k.slice(base.length), empty: true, note: `could not read: ${e instanceof Error ? e.message : e}`, langs: [] }); }
      }
      break;
    }
    cache.set(key, out);
    return out;
  };

  type Ev = { res: Verdict; note: string; shown: { key: string }[]; found?: string };
  /** One tool (or its fallback list): the folder in S3 → verdict, comment and the files that belong to this language. */
  const evalTools = async (m: TechniqueTool, lang: Language, candidates: string[]): Promise<Ev> => {
    const sc = await scan(candidates);
    if (!sc.found) return { res: 'FAIL', note: `not triggered — no folder ${candidates.join(' / ')} in this run`, shown: [] };
    if (!sc.jsons.length) return { res: 'FAIL', found: sc.found, note: `not triggered — ${sc.found}/ has no json/xml file (${sc.otherFiles} other files: ${(inventory[sc.found + '/'] || []).slice(0, 4).join(', ')})`, shown: [] };
    // does another language of this branch use the same folder for this technique? then the file names inside decide
    const same = (x: TechniqueTool) => x.testingType === m.testingType && x.technique === m.technique;
    const shared = languages.some((o) => o !== lang && toolsFor(o).some((x) => same(x) && x.tools.includes(sc.found!)));
    // a file that names no language belongs to the language whose OWN folder this is, unless it is another language's own (primary) folder
    const ownedByOther = languages.some((o) => o !== lang && toolsFor(o).some((x) => same(x) && x.tools[0] === sc.found));
    const own = candidates[0] === sc.found || !ownedByOther;
    const mine = shared ? sc.jsons.filter((j) => (j.langs.length ? j.langs.includes(lang) : own)) : sc.jsons;
    if (!mine.length) {
      const others = [...new Set(sc.jsons.flatMap((j) => j.langs))];
      return { res: 'FAIL', found: sc.found, shown: [], note: `not triggered for ${lang} — ${sc.found}/ only has ${others.length ? others.join(', ') + ' files' : 'files that name no language'} (no ${lang} folder of its own)` };
    }
    // a failure.json (status=failed / [permanent_runner_error]) with no data file beside it is a FAIL, not just EMPTY
    const isFailure = (j: { key: string; note: string }) => /failure\.json$/i.test(j.key) || /^status=failed|\[permanent_runner_error\]/i.test(j.note);
    const base = verdict(mine);
    const res: Verdict = base === 'EMPTY' && mine.some(isFailure) ? 'FAIL' : base;
    const what = (arr: typeof mine) => { const parts = [...new Set(arr.map((j) => `${j.key.split('/').pop()}: ${j.note}`))]; return parts.length === 1 && arr.length === 1 ? arr[0].note : parts.join('; '); };
    const note = res === 'PASS' ? `triggered — ${what(mine.filter((j) => !j.empty))}${shared ? ` (${lang} files)` : ''}${mine.some((j) => j.empty) ? ` | also: ${what(mine.filter((j) => j.empty))}` : ''}` : `triggered but empty — ${what(mine)}`;
    return { res, note, shown: mine, found: sc.found };
  };

  const rows: any[] = [];
  for (const lang of languages) {
    type Item = { m: TechniqueTool; classes?: string[]; parts: string[]; sec: string[] };
    const items: Item[] = toolsFor(lang).flatMap((t) => [
      ...(t.rowsOnly ? [] : [{ m: t, parts: [t.tools[0]], sec: t.tools.slice(1) } as Item]),
      ...(t.rows || []).map((r) => ({ m: t, classes: r.classes, parts: r.primary, sec: r.secondary || [] }) as Item), // classifications with their own tool(s)
    ]);
    for (const { m, classes, parts, sec } of items) {
      let ev: Ev | undefined; let label = ''; let secondary = false; let prefix = '';
      let pri = parts.join(' + ') || '(N/A)';
      if (m.tryFirst) { // e.g. ts-path-coverage: looked up first; only when its folder is missing the per-row tools below are used
        const f = await evalTools(m, lang, [m.tryFirst]);
        if (f.found) { ev = f; label = f.found; pri = m.tryFirst; } else prefix = `${m.tryFirst} not triggered — falling back to ${parts.join(' + ') || sec.join(' / ')}: `;
      }
      if (ev) { /* tryFirst folder used */ }
      else if (parts.length === 0) { // primary tool is N/A for these classifications → only the secondary is checked
        ev = await evalTools(m, lang, sec); label = ev.found || sec[0] || '(none)'; secondary = !!ev.found;
        prefix = `primary tool N/A for ${(classes || []).map((c) => `“${c}”`).join(', ')} — only ${sec.join(' / ')} is checked: `;
      } else if (parts.length === 1) { // one primary tool; the secondary only when the primary folder is missing
        ev = await evalTools(m, lang, [parts[0], ...sec]); label = ev.found || parts[0]; secondary = !!ev.found && ev.found !== parts[0];
      } else { // combined tool (e.g. npm audit + npm ls): every folder is checked and shown together
        const evs = await Promise.all(parts.map((p) => evalTools(m, lang, [p])));
        if (evs.some((e) => e.found)) {
          const v = (x: Verdict) => evs.some((e) => e.res === x);
          ev = { res: v('PASS') ? 'PASS' : v('EMPTY') ? 'EMPTY' : 'FAIL', shown: evs.flatMap((e) => e.shown), note: evs.map((e, k) => `${parts[k]}: ${e.note}`).join('  +  ') };
          label = parts.join(' + ');
        } else if (sec.length) { ev = await evalTools(m, lang, sec); label = ev.found || sec[0]; secondary = !!ev.found; }
        else { ev = { res: 'FAIL', shown: [], note: `not triggered — no folder ${parts.join(' / ')} in this run` }; label = parts.join(' + '); }
      }
      const note = prefix + ev.note;
      rows.push({ language: lang, testingType: m.testingType, technique: m.technique, tool: label, classifications: classes, primary: pri, secondary, result: ev.res, note, files: ev.shown.map((j) => j.key) });
      console.log(`   ${ev.res.padEnd(5)} [${lang}] ${m.testingType} › ${m.technique}${classes ? ' › ' + classes.join(', ') : ''}  [${label}]  ${note}`);
    }
  }
  // save an exact copy of EVERY file of EVERY tool folder in the run (any type, no per-folder limit) — mapping to techniques is separate
  let saved = 0; let failed = 0;
  for (const f of top.folders) {
    try {
      const w = await s3.walk(f, 8, 1000);
      for (const k of w.files) {
        const dest = path.join(bd, 's3-evidence', k.slice(base.length));
        if (fs.existsSync(dest)) continue;
        try { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, await s3.readBytes(k)); saved++; } catch { failed++; }
      }
    } catch { failed++; }
  }
  console.log(`  Saved ${saved} more file(s) so s3-evidence has every file of the run${failed ? ` (${failed} could not be read)` : ''}`);
  // Python branch: judge every tool against the Python-version matrix and what its file must hold (never fails the run)
  let python: any = null;
  try {
    python = validatePython(bd, rows, inventory);
    if (python) console.log(`  Python tool validation: ${summaryLine(python)}`);
  } catch (e) { console.log(`  Python tool validation skipped: ${e instanceof Error ? e.message : e}`); }
  // JavaScript branch: the same judging with the Node version matrix (never fails the run)
  let javascript: any = null;
  try {
    javascript = validateJavaScript(bd, rows, inventory);
    if (javascript) console.log(`  JavaScript tool validation: ${jsSummaryLine(javascript)}`);
  } catch (e) { console.log(`  JavaScript tool validation skipped: ${e instanceof Error ? e.message : e}`); }
  // C# branch: the same judging with the .NET version matrix (never fails the run)
  let typescript: any = null;
  try { typescript = validateTypeScript(bd, rows, inventory); if (typescript) console.log(`  TypeScript tool validation: ${tsSummaryLine(typescript)}`); } catch (e) { console.log(`  TypeScript tool validation skipped: ${e instanceof Error ? e.message : e}`); }
  let java: any = null;
  try { java = validateJava(bd, rows, inventory); if (java) console.log(`  Java tool validation: ${javaSummaryLine(java)}`); } catch (e) { console.log(`  Java tool validation skipped: ${e instanceof Error ? e.message : e}`); }
  let csharp: any = null;
  try {
    csharp = validateCSharp(bd, rows, inventory);
    if (csharp) console.log(`  C# tool validation: ${csSummaryLine(csharp)}`);
  } catch (e) { console.log(`  C# tool validation skipped: ${e instanceof Error ? e.message : e}`); }
  fs.writeFileSync(path.join(bd, 's3-check.json'), JSON.stringify({ repo: repo || '', branch: r.branch_name, run_id: r.run_id, commit_sha: r.commit_sha, languages, s3_path: base, python, javascript, typescript, csharp, java, checks: rows }, null, 2));
  const c = (v: Verdict) => rows.filter((x) => x.result === v).length;
  mergeTaxonomy(bd); // taxonomy report + UI value + S3 tool / comment columns
  // bug drafts (PDF + screenshot + Jira text) for the platform defects of a Python branch — saved in <branch>/bugs, never filed, never fails the run
  try {
    const made = await writeBugReports(bd, repo);
    if (made.length) console.log(`  Bug drafts: ${made.length} platform defect(s) → ${bd}\\bugs  (${made.join(', ')})`);
  } catch (e) { console.log(`  Bug drafts skipped: ${e instanceof Error ? e.message : e}`); }
  console.log(`  → ${bd}\\s3-check.json   (PASS ${c('PASS')}, EMPTY ${c('EMPTY')}, FAIL ${c('FAIL')}${c('NA') ? `, N/A ${c('NA')}` : ''})`);
}
