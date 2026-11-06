import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import { redact } from './rcaRedact';

/**
 * TRAINING SET FROM THE GOLDEN SHEET (the lead's reviewed whole-run RCA cases):
 *   npm run rca:golden -- "<Golden_Sheet.xlsx>" "<local platform checkout>" <out dir> [--base <dataset dir with train.jsonl>] [--holdout-base <dataset dir with holdout.jsonl + facts.jsonl>]
 * For every case: the prompt holds the symptom, the evidence in the run files and SHORT redacted snippets of the code trail, read at the commit the sheet names
 * (git show, read only, local); the answer is built from the sheet (root cause, reasoning steps, golden wording with its proof level, fix). Every 5th case is held out.
 * Written: train.jsonl (golden cases + the base cases), holdout.jsonl, facts.jsonl (same format as rca:dataset, so rca:eval can score it).
 */
const NLC = String.fromCharCode(10);
const REF = /([A-Za-z0-9_./-]+\.(?:py|ts|tsx|js|cs|java|go|sql|ya?ml))\s+L(\d+)(?:\s*[-–]\s*L?(\d+))?/g;
const git = (root: string, args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16_000_000 });

export interface Place { file: string; from: number; to: number; kw?: string[] }
const FILE_ONLY = /([A-Za-z0-9_./-]+\.(?:py|ts|tsx|js|cs|java|go|sql|ya?ml))(?!\s+L\d)/g;
/** the places named in a code trail: "path/file.py L293-294 ..." (a bare file name is found by its name at that commit) */
export function placesOf(trail: string): Place[] {
  const out: Place[] = []; const seen = new Set<string>();
  for (const m of trail.matchAll(REF)) { const from = Number(m[2]); const to = m[3] ? Number(m[3]) : from; const k = `${m[1]}:${from}`; if (!seen.has(k)) { seen.add(k); out.push({ file: m[1], from, to }); } }
  // files named without a line number: the lines are found by the keywords the trail itself uses (CODES, snake_case words)
  const stems = new Set([...trail.matchAll(FILE_ONLY)].map((m) => path.posix.basename(m[1]).replace(/\.[a-z]+$/, '')));
  const kw = [...new Set((trail.match(/\b[A-Z][A-Z0-9_]{5,}\b|\b[a-z]+_[a-z_]{3,}\b/g) || []).filter((w) => !/\.(py|ts|js)$/.test(w) && !stems.has(w)))].slice(0, 8);
  for (const m of trail.matchAll(FILE_ONLY)) { if (out.length >= 3) break; if (!out.some((o) => o.file === m[1])) out.push({ file: m[1], from: 0, to: 0, kw }); }
  // function references like baseline_repo.resolve_coverage_baseline: the file is found by its name, the lines by the function name
  for (const m of trail.matchAll(/\b([a-z][a-z0-9_]{3,})\.([a-z][a-z0-9_]{5,})\b/g)) { if (out.length >= 3) break; if (!/^(py|ts|js|json|md)$/.test(m[2]) && !out.some((o) => o.file.endsWith(`${m[1]}.py`))) out.push({ file: `${m[1]}.py`, from: 0, to: 0, kw: [m[2]] }); }
  return out.slice(0, 3);
}
export function commitOf(header: string): string | null { return /origin\/qa\s+([0-9a-f]{7,40})/i.exec(header)?.[1] || null; }

export function snippetAt(root: string, commit: string, p: Place, names: string[]): { file: string; text: string } | null {
  let file = p.file;
  let r = git(root, ['show', `${commit}:${file}`]);
  if (r.status !== 0) { const base = path.posix.basename(file); const hits = names.filter((n) => n.endsWith(`/${base}`) || n === base); if (hits.length !== 1) return null; file = hits[0]; r = git(root, ['show', `${commit}:${file}`]); if (r.status !== 0) return null; }
  const lines = String(r.stdout).split(NLC);
  if (p.from === 0) { // keyword look-up
    const hit = lines.findIndex((l) => (p.kw || []).some((k) => l.toLowerCase().includes(k.toLowerCase())));
    const top = lines.findIndex((l) => l.trim().length > 20 && /^(#|"""|''')/.test(l.trim())); // no keyword line: the opening comment or docstring of the file
    const at = hit >= 0 ? hit : top; if (at < 0) return null; p = { ...p, from: at + 1, to: at + 1 };
  }
  const from = Math.max(1, p.from - 1); const to = Math.min(lines.length, Math.max(p.to, p.from) + 2, from + 7);
  return { file, text: redact(lines.slice(from - 1, to).map((l, i) => `L${from + i}: ${l.replace(/\s+$/, '')}`).join(NLC)).text };
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
export function steps(text: string): string[] {
  const parts = text.split(/\s*\b\d\.\s+/).map((x) => x.trim()).filter(Boolean); if (parts.length <= 4) return parts.map((x) => cut(x, 300));
  return [...parts.slice(0, 3), parts.slice(3).join(' ')].map((x) => cut(x, 300));
}

async function main() {
  const args = process.argv.slice(2); const flag = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args.splice(i, 2)[1] : ''; };
  const base = flag('--base'); const hbase = flag('--holdout-base'); const [xlsx, root, out] = args;
  if (!xlsx || !root || !out) { console.log('Usage: npm run rca:golden -- "<Golden_Sheet.xlsx>" "<platform checkout>" <out dir> [--base <dir>] [--holdout-base <dir>]'); process.exit(1); }
  const recs: Array<{ id: string; user: string; record: unknown }> = []; let withCode = 0, noSnip = 0;
  let system = ''; let commit = '';
  for (const xlsxFile of xlsx.split('|')) {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(xlsxFile); const ws = wb.worksheets.find((w) => /golden|cases/i.test(w.name)) || wb.worksheets[2]; const col: Record<string, number> = {};
    ws.getRow(1).eachCell((c, i) => { col[c.text.replace(/\s*\(.*$/, '').trim()] = i; }); const trailHeader = Object.keys(col).find((k) => /^Code trail/i.test(k)); const headerFull = ws.getRow(1).getCell(col[trailHeader || '']).text;
    commit = commitOf(headerFull) || ''; if (!commit) { console.log('the Code trail column header does not name an origin/qa commit'); process.exit(1); }
    system = JSON.parse(fs.readFileSync(path.join(base || 'results/rca-dataset/v2', 'train.jsonl'), 'utf8').split(NLC)[0]).messages[0].content;
    const names = git(root, ['ls-tree', '-r', '--name-only', commit]).stdout.split(NLC).filter(Boolean); if (!names.length) { console.log(`commit ${commit} is not in ${root}`); process.exit(1); }
    const cell = (r: ExcelJS.Row, k: string) => r.getCell(col[k]).text.replace(/\s+/g, ' ').trim();
    ws.eachRow((r, i) => {
      if (i === 1 || !cell(r, 'ID')) return; const id = cell(r, 'ID'); const trail = r.getCell(col[trailHeader!]).text;
      const snips = placesOf(trail).map((p) => snippetAt(root, commit, p, names)).filter((x): x is { file: string; text: string } => !!x); if (snips.length) withCode++; else noSnip++;
      const user = [`RUN: whole-run analysis (${cell(r, 'Area')})`, `SYMPTOM (what the user sees): ${cell(r, 'Symptom')}`, `EVIDENCE IN THE RUN FILES: ${cell(r, 'Evidence in the run files')}`,
        ...(snips.length ? [`CODE EVIDENCE (read-only look-up in the platform code at ${commit}, short and redacted):`, ...snips.map((s) => `- ${s.file}${NLC}${s.text}`)] : ['CODE EVIDENCE: none available for this case']),
        '(Name the root cause, say how sure you are (Proven / Inferred / Unknown) and who fixes it. Use only the facts above.)', '', 'Write the report for this run now.'].join(NLC);
      const rc = cell(r, 'Root cause'); const answer = { oneLine: cut(rc, 220), whatHappened: steps(cell(r, 'Reasoning steps')), why: cut(`${cell(r, 'Golden answer')} Proof level: ${cell(r, 'Proof level')}.`, 700), impact: cut(`What the user sees: ${cell(r, 'Symptom')}`, 400), fix: cut(cell(r, 'Fix'), 400) };
      recs.push({ id: `golden-${id}`, user, record: { id: `golden-${id}`, messages: [{ role: 'system', content: system }, { role: 'user', content: user }, { role: 'assistant', content: JSON.stringify(answer) }] } });
    });
  }
  fs.mkdirSync(out, { recursive: true }); const isHold = (i: number) => i % 5 === 4; const L = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join(NLC) + NLC;
  const baseTrain = base ? fs.readFileSync(path.join(base, 'train.jsonl'), 'utf8').split(NLC).filter(Boolean).map((l) => JSON.parse(l)) : [];
  const baseHold = hbase ? fs.readFileSync(path.join(hbase, 'holdout.jsonl'), 'utf8').split(NLC).filter(Boolean).map((l) => JSON.parse(l)) : [];
  const baseFacts = hbase ? fs.readFileSync(path.join(hbase, 'facts.jsonl'), 'utf8').split(NLC).filter(Boolean).map((l) => JSON.parse(l)) : [];
  fs.writeFileSync(path.join(out, 'train.jsonl'), L([...baseTrain, ...recs.filter((_, i) => !isHold(i)).map((x) => x.record)]));
  fs.writeFileSync(path.join(out, 'holdout.jsonl'), L([...baseHold, ...recs.filter((_, i) => isHold(i)).map((x) => x.record)]));
  fs.writeFileSync(path.join(out, 'facts.jsonl'), L([...baseFacts, ...recs.map((x) => ({ id: x.id, tool: 'run', version: '', system, user: x.user }))]));
  console.log(`${recs.length} golden case(s) at ${commit}: ${withCode} with code snippets, ${noSnip} without; ${recs.filter((_, i) => !isHold(i)).length} train + ${baseTrain.length} base train; ${recs.filter((_, i) => isHold(i)).length} golden held out + ${baseHold.length} base held out`);
}
if (require.main === module) main().catch((e) => { console.log(e instanceof Error ? e.message : e); process.exit(1); });
