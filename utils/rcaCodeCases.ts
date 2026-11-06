import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import './env';
import { codeRoot, resolveRef, lookupCode } from './rcaCode';

/**
 * TRAINING CASES FROM THE PLATFORM CODE: how to read a platform failure code together with the place in the code that raises it.
 *   npm run rca:codecases -- <out dir> [codes.json]
 * Takes the failure / reason codes your own runs produced (codes.json: [[CODE, runs], ...], or the built-in list below), finds each in the local read-only copy of the
 * platform code, and writes for every code that has a usable comment next to it:
 *   candidates.json   code, places, redacted snippet, the meaning taken from the comments of the developers
 *   review.xlsx       the same, with a CONFIRM column for the lead
 *   train.jsonl / holdout.jsonl / facts.jsonl   the chat-format cases (same format as rca:dataset), 1 in 4 codes kept out as held-out
 * Short redacted snippets and comment sentences only: never whole files. Everything stays on this PC. The answers are built from the comments, not from a model.
 */
const KNOWN = ['EXECUTION_RUNTIME_UNAVAILABLE', 'CELL_CPU_CAPACITY', 'CELL_MEMORY_CAPACITY', 'ENVIRONMENT_CAPACITY', 'WB_ALL_PROVIDERS_EXHAUSTED', 'PREDECESSOR_NOT_TERMINAL', 'MISSING_BINARY',
  'CUSTOMER_CODE_INCOMPATIBLE_WITH_EXECUTION_ENV', 'HOST_RUNTIME_INCOMPATIBLE', 'STUB_NO_JACOCO_FOUND', 'RETRY_EXHAUSTED', 'PARSER_COMPATIBILITY_MISMATCH', 'WAVE_IDENTITY_MISMATCH',
  'SYSTEM_SHUTDOWN', 'TOOL_TIMEOUT', 'RUNTIME_IMAGE_DRIFT', 'SEQUENTIAL_CAP', 'ESLINT_USE_FLAT_CONFIG'];
const FIX: Record<string, string> = {
  RUNTIME_IMAGE_DRIFT: 'Check that every worker runs the image version of the plan (a rollout during the run is the usual cause), then re-run.',
  WAVE_IDENTITY_MISMATCH: 'Find the tool without a wave in the active execution policy of this tenant, assign it, then trigger a new run.',
  CELL_CPU_CAPACITY: 'Check the CPU capacity of the cell during the run and re-run when capacity is free; if it repeats with no pod running, reset the worker that holds the stale slot.',
  EXECUTION_RUNTIME_UNAVAILABLE: 'Check that an execution runtime that satisfies the tool is available in the cell during the run, then re-run.',
  MISSING_BINARY: 'Install the missing binary in the worker image, then re-run.',
};
const NLC = String.fromCharCode(10);
const SKIP = /(^|\/)(tests?|test_[^/]*|alembic|migrations|node_modules|scripts|diagnostics|docs)(\/|$)/i;

interface Case { code: string; places: { file: string; line: number; snippet: string }[]; meaning: string[]; fix: string }

function commentsAround(root: string, ref: string, file: string, line: number): string[] {
  const text = String(spawnSync('git', ['-C', root, 'show', `${ref}:${file}`], { encoding: 'utf8', maxBuffer: 8_000_000 }).stdout || '').split(NLC);
  const win = text.slice(Math.max(0, line - 14), line + 3); const out: string[] = [];
  for (const raw of win) {
    const t = raw.trim().replace(/^(#+|\/\/+|\/\*+|\*+\/?|"""|''')\s*/, '').replace(/["']{3}$/, '').replace(/^:\s*/, '').trim();
    if (/---|===|^[A-Z_ ]+:?$/.test(t) || t.length < 28 || !/[a-z]{3}/.test(t) || /^(import|from|def |class |return|raise|if |for |const |let )/.test(t) || /[=(){}]/.test(t.slice(0, 12))) continue;
    if (/^(#|\/\/|\/\*|\*|""")/.test(raw.trim()) || /^\s{2,}[A-Za-z][^=()]*[a-z.]$/.test(raw)) out.push(t.replace(/`+/g, ''));
  }
  return [...new Set(out)].slice(0, 4);
}

export function buildCases(root: string, ref: string, codes: string[]): Case[] {
  const out: Case[] = [];
  for (const code of codes) {
    const places = lookupCode(root, code, ref).filter((p) => !SKIP.test(p.file)); if (!places.length) continue;
    const meaning: string[] = []; for (const p of places) meaning.push(...commentsAround(root, ref, p.file, p.line));
    const uniq = [...new Set(meaning)].slice(0, 4); if (uniq.join(' ').length < 70) continue; // no sentence of the developers next to it: not a case
    out.push({ code, places: places.map((p) => ({ file: p.file, line: p.line, snippet: p.snippet })), meaning: uniq, fix: FIX[code] || 'This is a condition of the platform, see the code evidence. Ask the platform team to check it; the repository is not the cause.' });
  }
  return out;
}

function chat(system: string, c: Case, tool: string) {
  const ev = c.places.map((p) => `- ${p.file}:${p.line}${NLC}${p.snippet}`).join(NLC);
  const user = [`TOOL: ${tool} (python <V>)`, 'S3 RESULT: no result: the tool did not run', 'POD ATTEMPTS: none seen', 'SERVICE LINES OF THIS TASK:', `- WARNING wb-orchestrator: the platform reported the reason ${c.code} for the task of ${tool}`,
    'CODE EVIDENCE (read-only look-up in the platform code, short and redacted):', ev, 'STATE OF THE TOOL: NOT TRIGGERED', '(Write <V> exactly where the version belongs; never write a number for it.)', '', `Write the report for ${tool} now.`].join(NLC);
  const answer = {
    oneLine: `${tool} did not run: the platform reported ${c.code}.`,
    whatHappened: [`The platform reported the reason ${c.code} for the task of ${tool}.`, `The code that raises ${c.code} is in ${c.places[0].file}.`, 'No result of this tool was produced.'],
    why: `${c.meaning.join(' ')} This comes from the comments next to ${c.code} in the platform code, so it is a platform condition, not a problem of the repository.`,
    impact: `${tool} is missing from this branch's quality score input.`, fix: c.fix };
  return { user, record: { id: `code-${c.code}`, messages: [{ role: 'system', content: system }, { role: 'user', content: user }, { role: 'assistant', content: JSON.stringify(answer) }] } };
}

/** reads the CONFIRM column of review.xlsx: YES keeps the meaning, EDIT replaces it with the text of the last column, anything else drops the code; writes confirmed/train.jsonl and holdout.jsonl */
async function importReview(dir: string) {
  const cand = JSON.parse(fs.readFileSync(path.join(dir, 'candidates.json'), 'utf8')) as { cases: Case[] };
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path.join(dir, 'review.xlsx')); const ws = wb.getWorksheet('Codes')!; const keep: Case[] = []; let no = 0, open = 0;
  ws.eachRow((r, i) => { if (i === 1) return; const code = r.getCell(1).text.trim(); const d = r.getCell(5).text.trim().toUpperCase(); const note = r.getCell(6).text.trim(); const c = cand.cases.find((x) => x.code === code); if (!c) return;
    if (d === 'YES') keep.push(c); else if (d === 'EDIT' && note) keep.push({ ...c, meaning: [note] }); else if (d === 'NO') no++; else open++; });
  const base = path.resolve(process.cwd(), 'results/rca-dataset/v2/train.jsonl'); const system = JSON.parse(fs.readFileSync(base, 'utf8').split(NLC)[0]).messages[0].content;
  const tools = ['radon', 'cpd', 'pylint', 'checkstyle', 'bandit', 'semgrep']; const recs = keep.map((c, i) => ({ c, r: chat(system, c, tools[i % tools.length]) }));
  const outDir = path.join(dir, 'confirmed'); fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'train.jsonl'), recs.filter((_, i) => i % 4 !== 3).map((x) => JSON.stringify(x.r.record)).join(NLC) + NLC);
  fs.writeFileSync(path.join(outDir, 'holdout.jsonl'), recs.filter((_, i) => i % 4 === 3).map((x) => JSON.stringify(x.r.record)).join(NLC) + NLC);
  fs.writeFileSync(path.join(outDir, 'facts.jsonl'), recs.map((x, i) => JSON.stringify({ id: x.r.record.id, tool: tools[i % tools.length], version: '', system, user: x.r.user })).join(NLC) + NLC);
  console.log(`${keep.length} confirmed (${recs.filter((_, i) => i % 4 !== 3).length} train, ${recs.filter((_, i) => i % 4 === 3).length} held out), ${no} rejected, ${open} not answered yet -> ${outDir}`);
}

async function main() {
  if (process.argv[2] === '--import') { await importReview(process.argv[3]); return; }
  const [out, codesFile] = process.argv.slice(2); if (!out) { console.log('Usage: npm run rca:codecases -- <out dir> [codes.json]'); process.exit(1); }
  const root = codeRoot(); if (!root) { console.log('no local platform code (see npm run code:login / RCA_CODE_REMOTE)'); process.exit(1); }
  const ref = resolveRef(root); const rows: Array<[string, number]> = codesFile ? JSON.parse(fs.readFileSync(codesFile, 'utf8')) : KNOWN.map((c) => [c, 1] as [string, number]);
  const wanted = (codesFile ? rows.map((r) => r[0]).filter((c) => KNOWN.includes(c)) : KNOWN);
  const cases = buildCases(root, ref.ref || 'HEAD', wanted); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'candidates.json'), JSON.stringify({ platform_code: ref.label, cases }, null, 2));
  const base = path.resolve(process.cwd(), 'results/rca-dataset/v2/train.jsonl'); const system = JSON.parse(fs.readFileSync(base, 'utf8').split(NLC)[0]).messages[0].content;
  const tools = ['radon', 'cpd', 'pylint', 'checkstyle', 'bandit', 'semgrep']; const recs = cases.map((c, i) => chat(system, c, tools[i % tools.length]));
  const hold = new Set(cases.map((c, i) => (i % 4 === 3 ? c.code : '')).filter(Boolean));
  fs.writeFileSync(path.join(out, 'train.jsonl'), recs.filter((r, i) => !hold.has(cases[i].code)).map((r) => JSON.stringify(r.record)).join(NLC) + NLC);
  fs.writeFileSync(path.join(out, 'holdout.jsonl'), recs.filter((r, i) => hold.has(cases[i].code)).map((r) => JSON.stringify(r.record)).join(NLC) + NLC);
  fs.writeFileSync(path.join(out, 'facts.jsonl'), recs.map((r, i) => JSON.stringify({ id: r.record.id, tool: tools[i % tools.length], version: '', system, user: r.user })).join(NLC) + NLC);
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Codes'); ws.addRow(['code', 'where (file:line)', 'meaning from the developers comments', 'fix text', 'CONFIRM? (YES / NO / EDIT)', 'edit / note']);
  for (const c of cases) ws.addRow([c.code, c.places.map((p) => `${p.file}:${p.line}`).join(NLC), c.meaning.join(NLC), c.fix, '', '']);
  ws.columns = [{ width: 36 }, { width: 52 }, { width: 80 }, { width: 60 }, { width: 22 }, { width: 40 }]; ws.getRow(1).font = { bold: true }; ws.eachRow((r) => r.eachCell((c) => { c.alignment = { wrapText: true, vertical: 'top' }; }));
  await wb.xlsx.writeFile(path.join(out, 'review.xlsx'));
  console.log(`${cases.length} code case(s) from ${ref.label}: ${recs.length - hold.size} train, ${hold.size} held out. Skipped (no comment next to them): ${wanted.filter((c) => !cases.some((x) => x.code === c)).join(', ') || 'none'}`);
}
if (require.main === module) main().catch((e) => { console.log(e instanceof Error ? e.message : e); process.exit(1); });
