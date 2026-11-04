import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as ExcelJS from 'exceljs';
import './env'; // loads .env
import { allTools, buildFactPack, FactPack } from './rcaFacts';
import { reportFromRules } from './rcaReport';

/**
 * The GOLD SET: cases whose correct answer was agreed by people, used to measure how right the EKS and S3 checking really is.
 *   npm run rca:gold -- export "<branch folder>" ["<branch folder>" ...] --people "Sakthi,Bharathkumar,Visvantha" [--out <dir>] [--max 60] [--cross-every 5]
 *       one sheet per person (gold-<name>.xlsx): about a third of the cases each, plus every 5th case also goes to the next person (the cross-check).
 *       Each row shows the facts and what the pipeline said (cause class, evidence line, owner); the person says YES or NO and fixes the cause class or owner.
 *   npm run rca:gold -- score "<dir>"
 *       reads every sheet, lists cases where two people disagree (settled by the person who knows that side best), and prints the accuracy:
 *       cause class, evidence line, owner, per class, and the misses. Writes gold-final.json for the cross-check of other models (rcaCross).
 * Gates (the team lead agrees them): cause 90% or more, evidence line 100%, owner 90% or more.
 */
export const CLASSES: [string, string][] = [
  ['ok', 'Triggered, result fine'], ['findings-exit-code', 'Exit code 1 only because the tool found something'], ['workspace-permission-denied', 'Cannot write in the checked-out repository (/workspaces)'],
  ['unsupported-cli-option', 'Runner used an option the tool does not have'], ['pip-audit-env-setup-failed', 'pip-audit could not set up its environment'],
  ['runtime-unavailable-unplaceable', 'Planning could not place the tool: no runtime'], ['tool-readiness-blocked', 'Worker start-up check refused the tool'],
  ['planning-skipped-startup-readiness', 'Planning skipped the tool: readiness check'], ['cell-cpu-capacity', 'Admission rejected: no CPU capacity'], ['ran-but-excluded', 'Ran although the matrix excludes it'], ['runtime-image-drift', 'Worker runs another environment than the plan froze'],
  ['oom-killed', 'Pod out of memory'], ['image-pull', 'Image could not be pulled'], ['evicted', 'Pod evicted'], ['empty-report', 'Tool wrote an empty report'], ['timeout', 'Timed out'],
  ['pod-completed-no-output', 'Pod completed but no result reached S3'], ['language-contamination', 'Tool of another language was planned'], ['false-empty', 'Empty report, 0 files scanned'],
  ['not-triggered-inferred', 'Never ran; no log line says why'], ['failed-cause-unknown', 'Failed; the logs do not show why'], ['empty-cause-unknown', 'Empty result; the logs do not show why'], ['other', 'None of these (write it in the note)'],
];
const safe = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 60);
const hash = (s: string, salt = '') => parseInt(crypto.createHash('sha1').update(salt + s).digest('hex').slice(0, 8), 16);

/** the cause class the pipeline gives: the rule that matched, or a class derived from the S3 state when no rule matched */
export function predictedClass(p: FactPack): string {
  if (p.rule) return p.rule.id;
  if (p.healthy) return 'ok';
  if (/Language Contamination/.test(p.classification)) return 'language-contamination';
  if (/False Empty/.test(p.classification)) return 'false-empty';
  if (!p.triggered) return 'not-triggered-inferred';
  if (p.s3State === 'EMPTY') return 'empty-cause-unknown';
  return 'failed-cause-unknown';
}

/** the evidence a person (or another AI) looks at: only the raw facts, never the pipeline's conclusion */
export function rawEvidence(p: FactPack): string {
  const L: string[] = [`TOOL: ${p.tool} (${[p.language, p.version].filter(Boolean).join(' ')})`];
  if (p.classification) L.push(`S3 RESULT: ${p.classification} ${p.observed}: ${p.s3Note}`);
  if (p.attempts.length) { L.push('POD ATTEMPTS:'); p.attempts.forEach((a, i) => L.push(`${i + 1}. ${a.phase}, exit code ${a.exitCode ?? '?'}, command "${a.command}"`)); } else L.push(p.captured ? 'POD ATTEMPTS: none seen' : 'POD ATTEMPTS: none (there is no live capture of this run)');
  if (p.decisive?.lines.length) L.push('LOG LINES OF THE FAILED POD:', ...p.decisive.lines.map((l) => `- ${l}`));
  const sv = p.serviceLines.filter((s) => s.sameTask || !p.decisive); if (sv.length) L.push('SERVICE LINES OF THIS TASK:', ...sv.map((s) => `- ${s.text}`));
  if (p.failureJson.length) L.push('FAILURE.JSON:', ...p.failureJson.map((l) => `- ${l}`));
  L.push(`STATE: ${reportFromRules(p).state}`);
  return L.join('\n');
}

export interface GoldCase { id: string; branch: string; tool: string; language: string; layout: string; cls: string; evidence: string; owner: string; facts: string; assigned: { person: string; role: 'primary' | 'cross-check' }[] }
const HEAD = ['id', 'role', 'branch', 'tool', 'language', 'layout (pipeline)', 'CLASS (pipeline)', 'EVIDENCE LINE (pipeline)', 'OWNER (pipeline)', 'facts the pipeline saw',
  'CLASS CORRECT? (YES / NO)', 'right class (if NO)', 'EVIDENCE CORRECT? (YES / NO / NONE)', 'OWNER CORRECT? (YES / NO)', 'right owner (if NO)', 'reviewer', 'note'];
const COL = Object.fromEntries(HEAD.map((h, i) => [h, i + 1]));

function collect(dirs: string[], max: number): GoldCase[] {
  const seen = new Set<string>(); const shape = new Set<string>(); const all: { c: GoldCase; cap: boolean }[] = [];
  for (const dir of dirs.map((d) => path.resolve(d))) for (const tool of allTools(dir)) {
    const p = buildFactPack(dir, tool); const id = `${(p.runId || path.basename(dir)).slice(0, 8)}-${safe(tool)}`; if (seen.has(id)) continue; seen.add(id);
    const cls = predictedClass(p); const k = [p.language, tool, cls].join('|'); if (shape.has(k)) continue; shape.add(k); const base = reportFromRules(p);
    all.push({ cap: p.captured, c: { id, branch: p.branch, tool, language: p.language, layout: base.tone === 'green' ? 'GREEN' : 'RED', cls, evidence: base.evidence, owner: base.owner, facts: rawEvidence(p), assigned: [] } });
  }
  const byLang = new Map<string, GoldCase[]>(); for (const x of [...all].sort((a, b) => Number(b.cap) - Number(a.cap) || hash(a.c.id) - hash(b.c.id))) { const l = byLang.get(x.c.language) || []; l.push(x.c); byLang.set(x.c.language, l); }
  const out: GoldCase[] = []; for (let i = 0; out.length < max; i++) { let any = false; for (const l of byLang.values()) if (l[i] && out.length < max) { out.push(l[i]); any = true; } if (!any) break; }
  return out;
}

export async function exportGold(dirs: string[], out: string, people: string[], opts: { max?: number; crossEvery?: number; sortByClass?: boolean } = {}): Promise<{ cases: number; perPerson: Record<string, number> }> {
  fs.mkdirSync(out, { recursive: true }); const cases = collect(dirs, opts.max ?? 60); const n = people.length; const every = opts.crossEvery ?? 5;
  for (const c of cases) { const first = hash(c.id) % n; c.assigned.push({ person: people[first], role: 'primary' }); if (n > 1 && hash(c.id, 'x') % every === 0) c.assigned.push({ person: people[(first + 1) % n], role: 'cross-check' }); }
  if (opts.sortByClass ?? n === 1) cases.sort((a, b) => a.cls.localeCompare(b.cls) || a.tool.localeCompare(b.tool)); // one person labels everything: similar cases side by side go much faster
  const perPerson: Record<string, number> = {};
  for (const person of people) {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Gold'); ws.addRow(HEAD); const cl = wb.addWorksheet('Classes'); cl.addRow(['class', 'meaning']); CLASSES.forEach((c) => cl.addRow(c)); cl.columns.forEach((c, i) => { c.width = [38, 70][i]; });
    const how = wb.addWorksheet('How to label'); [['Read "facts the pipeline saw" (column J). It is the raw evidence: log lines, the S3 result, the pod attempts.'], ['CLASS CORRECT?: YES when the pipeline\'s class is the true cause class. NO when it is wrong: then pick the right class in the next column (list in sheet "Classes"; use "other" and a note if none fits).'],
      ['EVIDENCE CORRECT?: YES when the evidence line the pipeline quotes really proves the cause. NO when it quotes the wrong line. NONE when the pipeline quotes nothing and nothing should be quoted.'], ['OWNER CORRECT?: YES when the owner (platform / repository / nobody) is right. NO: write the right owner.'],
      ['Rows marked "cross-check" are also labelled by someone else: do them alone, do not ask. Different answers are settled afterwards by the person who knows that side best (EKS: Bharathkumar, S3: Visvantha).'], ['Use only what the facts say. If you cannot tell, say NO and write "other" with a note: that is a useful answer.']].forEach((r) => how.addRow(r)); how.getColumn(1).width = 150;
    for (const c of cases) { const a = c.assigned.find((x) => x.person === person); if (!a) continue;
      const row = ws.addRow([c.id, a.role, c.branch, c.tool, c.language, c.layout, c.cls, c.evidence, c.owner, c.facts, '', '', '', '', '', person, '']);
      for (const h of ['CLASS CORRECT? (YES / NO)', 'OWNER CORRECT? (YES / NO)']) row.getCell(COL[h]).dataValidation = { type: 'list', allowBlank: true, formulae: ['"YES,NO"'] };
      row.getCell(COL['EVIDENCE CORRECT? (YES / NO / NONE)']).dataValidation = { type: 'list', allowBlank: true, formulae: ['"YES,NO,NONE"'] };
      row.getCell(COL['right class (if NO)']).dataValidation = { type: 'list', allowBlank: true, formulae: [`Classes!$A$2:$A$${CLASSES.length + 1}`] }; perPerson[person] = (perPerson[person] || 0) + 1; }
    const widths = [18, 11, 20, 20, 11, 9, 28, 45, 30, 80, 14, 28, 16, 14, 24, 14, 30]; ws.columns.forEach((c, i) => { c.width = widths[i]; c.alignment = { wrapText: true, vertical: 'top' }; });
    const h = ws.getRow(1); h.font = { bold: true, color: { argb: 'FFFFFFFF' } }; h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } }; ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 4 }];
    await wb.xlsx.writeFile(path.join(out, `gold-${safe(person)}.xlsx`)); perPerson[person] = perPerson[person] || 0;
  }
  fs.writeFileSync(path.join(out, 'gold-index.json'), JSON.stringify({ people, cases }, null, 1));
  return { cases: cases.length, perPerson };
}

export interface GoldFinal { cls: string; owner: string; evidenceOk: string }
export interface GoldScore { labelled: number; unlabelled: number; invalid: string[]; conflicts: { id: string; details: string }[]; classAcc: number; evidenceAcc: number; ownerAcc: number; perClass: Record<string, { n: number; right: number }>; misses: { id: string; pipeline: string; gold: string }[]; final: Record<string, GoldFinal>; gates: { cause: boolean; evidence: boolean; owner: boolean } }

export async function scoreGold(dir: string): Promise<GoldScore> {
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'gold-index.json'), 'utf8')) as { people: string[]; cases: GoldCase[] }; const byId = new Map(index.cases.map((c) => [c.id, c]));
  const labels = new Map<string, { by: string; cls: string; ev: string; owner: string; ownerOk: string }[]>(); const invalid: string[] = [];
  for (const person of index.people) {
    const f = path.join(dir, `gold-${safe(person)}.xlsx`); if (!fs.existsSync(f)) continue; const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(f); const ws = wb.getWorksheet('Gold'); if (!ws) continue;
    ws.eachRow((row, i) => { if (i === 1) return; const g = (h: string) => String(row.getCell(COL[h]).text ?? '').trim(); const id = g('id'); const c = byId.get(id); const dec = g('CLASS CORRECT? (YES / NO)').toUpperCase(); if (!c || !dec) return;
      const cls = dec === 'YES' ? c.cls : g('right class (if NO)'); const ownerOk = g('OWNER CORRECT? (YES / NO)').toUpperCase(); const ev = g('EVIDENCE CORRECT? (YES / NO / NONE)').toUpperCase();
      if (dec !== 'YES' && dec !== 'NO') return void invalid.push(`${id} (${person}): CLASS CORRECT? must be YES or NO`); if (!cls) return void invalid.push(`${id} (${person}): NO needs the right class`);
      if (!ownerOk || !ev) return void invalid.push(`${id} (${person}): fill EVIDENCE and OWNER too`); if (ownerOk === 'NO' && !g('right owner (if NO)')) return void invalid.push(`${id} (${person}): OWNER NO needs the right owner`);
      (labels.get(id) || labels.set(id, []).get(id)!).push({ by: person, cls, ev, owner: ownerOk === 'YES' ? c.owner : g('right owner (if NO)'), ownerOk }); });
  }
  const final: Record<string, GoldFinal> = {}; const conflicts: GoldScore['conflicts'] = []; const perClass: GoldScore['perClass'] = {}; const misses: GoldScore['misses'] = [];
  let classRight = 0, evN = 0, evRight = 0, ownN = 0, ownRight = 0;
  for (const [id, ls] of labels) {
    const c = byId.get(id)!; const same = ls.every((l) => l.cls === ls[0].cls && l.ev === ls[0].ev && l.ownerOk === ls[0].ownerOk);
    if (!same) { conflicts.push({ id, details: ls.map((l) => `${l.by}: class ${l.cls}, evidence ${l.ev}, owner ${l.ownerOk}`).join(' | ') }); continue; }
    const l = ls[0]; final[id] = { cls: l.cls, owner: l.owner, evidenceOk: l.ev }; const right = l.cls === c.cls; if (right) classRight++; else misses.push({ id, pipeline: c.cls, gold: l.cls });
    const pc = (perClass[l.cls] ||= { n: 0, right: 0 }); pc.n++; if (right) pc.right++; if (l.ev !== 'NONE') { evN++; if (l.ev === 'YES') evRight++; } ownN++; if (l.ownerOk === 'YES') ownRight++;
  }
  const labelled = Object.keys(final).length; const r = (a: number, b: number) => (b ? a / b : 0);
  const res: GoldScore = { labelled, unlabelled: index.cases.length - labels.size, invalid, conflicts, classAcc: r(classRight, labelled), evidenceAcc: r(evRight, evN), ownerAcc: r(ownRight, ownN), perClass, misses, final, gates: { cause: false, evidence: false, owner: false } };
  res.gates = { cause: labelled > 0 && res.classAcc >= 0.9, evidence: evN > 0 && res.evidenceAcc >= 1, owner: ownN > 0 && res.ownerAcc >= 0.9 };
  fs.writeFileSync(path.join(dir, 'gold-final.json'), JSON.stringify(final, null, 1)); return res;
}

/**
 * After fixes: what would the pipeline say NOW for the cases people already labelled? Rebuilds the pipeline class from the same branch folders (nothing is re-exported,
 * no label is lost) and compares it with gold-final.json: accuracy before the fixes (the class stored when the sheet was made) and after.
 */
export async function rescoreGold(dir: string, branchDirs: string[]): Promise<{ n: number; before: number; after: number; changed: { id: string; was: string; now: string; gold: string }[] }> {
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'gold-index.json'), 'utf8')) as { cases: GoldCase[] }; const final = JSON.parse(fs.readFileSync(path.join(dir, 'gold-final.json'), 'utf8')) as Record<string, GoldFinal>;
  const now = new Map<string, string>(); for (const d of branchDirs.map((x) => path.resolve(x))) for (const tool of allTools(d)) { const p = buildFactPack(d, tool); const id = `${(p.runId || path.basename(d)).slice(0, 8)}-${safe(tool)}`; if (!now.has(id)) now.set(id, predictedClass(p)); }
  const cases = index.cases.filter((c) => final[c.id] && now.has(c.id)); const changed: { id: string; was: string; now: string; gold: string }[] = [];
  for (const c of cases) if (now.get(c.id) !== c.cls) changed.push({ id: c.id, was: c.cls, now: now.get(c.id)!, gold: final[c.id].cls });
  return { n: cases.length, before: cases.filter((c) => c.cls === final[c.id].cls).length, after: cases.filter((c) => now.get(c.id) === final[c.id].cls).length, changed };
}

if (require.main === module) {
  (async () => {
    const [cmd, ...rest] = process.argv.slice(2); const take = (f: string) => { const i = rest.indexOf(f); return i >= 0 ? String(rest.splice(i, 2)[1]) : ''; };
    const people = take('--people'); const outArg = take('--out'); const max = Number(take('--max')) || 60; const every = Number(take('--cross-every')) || 5;
    if (cmd === 'export' && rest.length && people && rest.every((d) => fs.existsSync(d))) {
      const d = new Date(); const p2 = (x: number) => String(x).padStart(2, '0'); const out = path.resolve(outArg || path.join(__dirname, '..', 'results', 'rca-gold', `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`));
      const r = await exportGold(rest, out, people.split(',').map((s) => s.trim()).filter(Boolean), { max, crossEvery: every });
      console.log(`${r.cases} case(s) in ${out}\n` + Object.entries(r.perPerson).map(([k, v]) => `  gold-${safe(k)}.xlsx   ${v} row(s)`).join('\n') + `\nEach person fills their own sheet alone; then:  npm run rca:gold -- score "${out}"`);
    } else if (cmd === 'score' && rest[0] && fs.existsSync(path.join(rest[0], 'gold-index.json'))) {
      const s = await scoreGold(rest[0]); const pc = (x: number) => `${(x * 100).toFixed(0)}%`; const ok = (b: boolean) => (b ? 'PASS' : 'not yet');
      console.log(`labelled ${s.labelled} · not labelled yet ${s.unlabelled} · conflicts ${s.conflicts.length} · invalid rows ${s.invalid.length}`);
      console.log(`cause class correct  ${pc(s.classAcc).padStart(5)}   gate 90%   ${ok(s.gates.cause)}\nevidence line correct ${pc(s.evidenceAcc).padStart(4)}   gate 100%  ${ok(s.gates.evidence)}\nowner correct        ${pc(s.ownerAcc).padStart(5)}   gate 90%   ${ok(s.gates.owner)}`);
      for (const [k, v] of Object.entries(s.perClass).sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(36)} ${v.right}/${v.n}`);
      for (const m of s.misses.slice(0, 15)) console.log(`  MISS ${m.id}: pipeline said ${m.pipeline}, people said ${m.gold}`); for (const c of s.conflicts.slice(0, 15)) console.log(`  CONFLICT ${c.id}: ${c.details}`); for (const x of s.invalid.slice(0, 15)) console.log(`  INVALID ${x}`);
    } else if (cmd === 'rescore' && rest.length > 1 && fs.existsSync(path.join(rest[0], 'gold-final.json'))) {
      const r = await rescoreGold(rest[0], rest.slice(1)); const pc = (x: number) => `${r.n ? Math.round((100 * x) / r.n) : 0}%`;
      console.log(`labelled cases found again: ${r.n}\ncause class correct BEFORE the fixes ${pc(r.before)} (${r.before}/${r.n})   AFTER ${pc(r.after)} (${r.after}/${r.n})`);
      for (const c of r.changed) console.log(`  changed ${c.id}: ${c.was} -> ${c.now}   (people said ${c.gold}) ${c.now === c.gold ? 'now right' : c.was === c.gold ? 'WAS right, now wrong' : 'still wrong'}`);
    } else { console.log('Usage:\n  npm run rca:gold -- rescore "<dir>" "<branch folder>" [...]   (after fixes: accuracy before and after)\n  npm run rca:gold -- export "<branch folder>" [...] --people "A,B,C" [--out <dir>] [--max 60] [--cross-every 5]\n  npm run rca:gold -- score "<dir>"'); process.exit(1); }
  })();
}
