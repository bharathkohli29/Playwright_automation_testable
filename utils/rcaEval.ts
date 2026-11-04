import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import './env'; // loads .env
import { ungrounded } from './rcaWriter';

/**
 * Held-out test of the RCA writer: every source answers the SAME cases it never trained on, and every answer gets the same checks the pipeline uses.
 *   npm run rca:eval -- score  <dir> [--file <name>=<generations.jsonl>] [--ollama <name>=<model>] ...
 *   npm run rca:eval -- sheet  <dir> [same sources]      -> <dir>/validate-blind.xlsx  (names hidden; score it with  npm run rca:blind -- score ...)
 * <dir> is a dataset folder with holdout.jsonl (the reviewed answers) and facts.jsonl. A --file source is a JSONL of {id, answer} (rca-train/generate.py writes them);
 * an --ollama source is asked here, with the prompts of the holdout file and a JSON schema, like the pipeline does.
 * Per answer: valid JSON, all five parts, names the tool, nothing in it (path, option, version, number) that is not in the facts. "Accepted" = all of these.
 * Also printed: word overlap with the reviewed answer (a rough guide only: the wording of a good answer may differ).
 */
const PARTS = ['oneLine', 'whatHappened', 'why', 'impact', 'fix'] as const;
const SCHEMA = { type: 'object', required: [...PARTS], properties: { oneLine: { type: 'string' }, whatHappened: { type: 'array', items: { type: 'string' } }, why: { type: 'string' }, impact: { type: 'string' }, fix: { type: 'string' } } };
interface Row { id: string; messages: { role: string; content: string }[] }
interface Gen { id: string; answer: string; seconds?: number }
interface Check { id: string; valid: boolean; complete: boolean; names: boolean; bad: string[]; accepted: boolean; f1: number; words: number; seconds: number; parsed?: any }

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9<>_./-]+/g, ' ').split(' ').filter(Boolean);
function f1(a: string, b: string): number { const x = words(a), y = words(b); if (!x.length || !y.length) return 0; const m = new Map<string, number>(); y.forEach((w) => m.set(w, (m.get(w) || 0) + 1)); let hit = 0; x.forEach((w) => { if ((m.get(w) || 0) > 0) { hit++; m.set(w, m.get(w)! - 1); } }); const p = hit / x.length, r = hit / y.length; return p + r ? (2 * p * r) / (p + r) : 0; }
const flat = (j: any) => [j.oneLine, ...(Array.isArray(j.whatHappened) ? j.whatHappened : []), j.why, j.impact, j.fix].filter((x) => typeof x === 'string').join(' ');

export function parseAnswer(raw: string): { json: any | null; clean: boolean } {
  const t = raw.trim(); try { return { json: JSON.parse(t), clean: true }; } catch { /* maybe wrapped in text or a code fence */ }
  const m = /\{[\s\S]*\}/.exec(t); if (m) { try { return { json: JSON.parse(m[0]), clean: false }; } catch { /* not recoverable */ } }
  return { json: null, clean: false };
}

export function checkAnswer(row: Row, g: Gen, gold: any, version = ''): Check {
  const user = row.messages[1].content; const tool = (/^TOOL: ([^\s(]+)/m.exec(user) || [])[1] || '';
  const { json, clean } = parseAnswer(g.answer); const valid = !!json && clean;
  const complete = !!json && PARTS.every((k) => (k === 'whatHappened' ? Array.isArray(json[k]) && json[k].length > 0 && json[k].every((x: unknown) => typeof x === 'string') : typeof json[k] === 'string' && json[k].trim().length > 5));
  const text = json ? flat(json) : ''; const names = !!text && text.toLowerCase().includes(tool.toLowerCase().split(/[-_]/)[0]);
  // like the pipeline: the real version is in the facts the checks compare with
  const bad = text ? ungrounded(text, user + String.fromCharCode(10) + version) : [];
  const placeholder = /<[^>\s]{0,3}V>/i.test(text.replace(/<V>/g, ''));
  return { id: row.id, valid, complete, names, bad, accepted: valid && complete && names && bad.length === 0 && !placeholder, f1: text && gold ? f1(text, flat(gold)) : 0, words: words(text).length, seconds: g.seconds || 0, parsed: json };
}

async function askOllama(model: string, row: Row): Promise<Gen> {
  const t0 = Date.now(); const host = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
  const res = await fetch(`${host}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({ model, stream: false, think: false, format: SCHEMA, options: { temperature: 0.1, num_ctx: 4096, num_predict: 900 }, messages: row.messages.slice(0, 2) }) });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status} for ${model}`); const j: any = await res.json();
  return { id: row.id, answer: String(j?.message?.content || ''), seconds: (Date.now() - t0) / 1000 };
}

async function load(dir: string, srcs: { name: string; kind: 'file' | 'ollama'; ref: string }[]) {
  const rows: Row[] = fs.readFileSync(path.join(dir, 'holdout.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const gens: Record<string, Gen[]> = {};
  for (const s of srcs) {
    if (s.kind === 'file') gens[s.name] = fs.readFileSync(s.ref, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    else { gens[s.name] = []; for (const r of rows) gens[s.name].push(await askOllama(s.ref, r).catch((e) => ({ id: r.id, answer: `ERROR ${e.message}`, seconds: 0 }))); }
  }
  return { rows, gens };
}

export function scoreAll(rows: Row[], gens: Record<string, Gen[]>, versions: Record<string, string> = {}) {
  const out: Record<string, Check[]> = {};
  for (const [name, list] of Object.entries(gens)) out[name] = rows.map((r) => checkAnswer(r, list.find((g) => g.id === r.id) || { id: r.id, answer: '' }, JSON.parse(r.messages[2].content), versions[r.id] || ''));
  return out;
}

export async function buildSheet(dir: string, rows: Row[], checks: Record<string, Check[]>): Promise<string> {
  const side = new Map<string, any>(fs.readFileSync(path.join(dir, 'facts.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { const j = JSON.parse(l); return [j.id, j]; }));
  const wb = new ExcelJS.Workbook(); const facts = wb.addWorksheet('Facts'); facts.addRow(['Case', 'Tool', 'State', 'The facts every candidate was written from']);
  const how = wb.addWorksheet('How to score');
  [['Each case has candidate texts (A, B, C ...) written from the SAME facts. You do not know which is which: one may be a reviewed reference text, one a trained model, one an untrained model.'], ['Read the facts of the case in the sheet "Facts" first. Then score every candidate:'],
    ['  Clarity 1-5: can a QA engineer who is not a Kubernetes expert understand it at once? (1 = confusing, 5 = clear and short)'], ['  Accuracy 1-5: does it say only what the facts say, and say it correctly? A wrong or invented claim is a 1 or 2 even when it reads well.'],
    ['Work alone, in your own sheet (Reviewer 1 or Reviewer 2).']].forEach((r) => how.addRow(r)); how.getColumn(1).width = 130;
  const HEAD = ['Case', 'Tool', 'Candidate', 'One sentence', 'What happened', 'Why', 'Impact', 'What to do', 'Clarity 1-5', 'Accuracy 1-5', 'Note'];
  const sheets = ['Reviewer 1', 'Reviewer 2'].map((n) => { const ws = wb.addWorksheet(n); ws.addRow(HEAD); return ws; });
  const key = wb.addWorksheet('Key'); key.addRow(['Case', 'Candidate', 'Model']); key.state = 'veryHidden';
  let n = 0;
  for (const r of rows) {
    const s = side.get(r.id); const ver = String(s?.version || ''); const sub = (t: string) => (ver ? t.split('<V>').join(ver) : t);
    const cands: { model: string; j: any }[] = [{ model: 'reviewed reference', j: JSON.parse(r.messages[2].content) }];
    for (const [name, list] of Object.entries(checks)) { const c = list.find((x) => x.id === r.id); if (c?.parsed) cands.push({ model: name, j: c.parsed }); }
    if (cands.length < 2) continue; n++; const label = `C${String(n).padStart(2, '0')}`;
    const order = cands.map((c) => c.model).sort((a, b) => (require('crypto').createHash('sha1').update(r.id + a).digest('hex') < require('crypto').createHash('sha1').update(r.id + b).digest('hex') ? -1 : 1));
    facts.addRow([label, s?.tool || '', '', sub(r.messages[1].content.replace(/\n\(Write <V>[^\n]*\)|\n\(No language version[^\n]*\)/g, '').replace(/\n\nWrite the report for .*$/s, ''))]);
    order.forEach((m, i) => { const j = cands.find((c) => c.model === m)!.j; const letter = String.fromCharCode(65 + i); key.addRow([label, letter, m]);
      for (const ws of sheets) { const row = ws.addRow([label, s?.tool || '', letter, sub(String(j.oneLine || '')), sub((Array.isArray(j.whatHappened) ? j.whatHappened : []).join('\n')), sub(String(j.why || '')), sub(String(j.impact || '')), sub(String(j.fix || '')), '', '', '']); for (const col of [9, 10]) row.getCell(col).dataValidation = { type: 'whole', operator: 'between', formulae: [1, 5], allowBlank: true, showErrorMessage: true, errorTitle: 'Score', error: 'A whole number from 1 to 5' }; } });
  }
  const widths = [7, 18, 10, 42, 50, 55, 40, 45, 11, 11, 30];
  for (const ws of sheets) { ws.columns.forEach((c, i) => { c.width = widths[i]; c.alignment = { wrapText: true, vertical: 'top' }; }); const h = ws.getRow(1); h.font = { bold: true, color: { argb: 'FFFFFFFF' } }; h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } }; ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 3 }]; }
  facts.columns.forEach((c, i) => { c.width = [7, 18, 4, 130][i]; c.alignment = { wrapText: true, vertical: 'top' }; }); facts.getRow(1).font = { bold: true };
  const file = path.join(dir, 'validate-blind.xlsx'); await wb.xlsx.writeFile(file); return file;
}

if (require.main === module) {
  (async () => {
    const [cmd, dirArg, ...rest] = process.argv.slice(2); const dir = path.resolve(dirArg || '');
    const srcs: { name: string; kind: 'file' | 'ollama'; ref: string }[] = [];
    for (let i = 0; i < rest.length; i++) if (rest[i] === '--file' || rest[i] === '--ollama') { const [name, ...ref] = String(rest[++i]).split('='); srcs.push({ name, kind: rest[i - 1] === '--file' ? 'file' : 'ollama', ref: ref.join('=') }); }
    if (!['score', 'sheet'].includes(cmd) || !fs.existsSync(path.join(dir, 'holdout.jsonl')) || !srcs.length) { console.log('Usage:\n  npm run rca:eval -- score <dir> [--file name=gen.jsonl] [--ollama name=model] ...\n  npm run rca:eval -- sheet <dir> [same sources]'); process.exit(1); }
    const { rows, gens } = await load(dir, srcs); const versions: Record<string, string> = {};
    for (const l of fs.readFileSync(path.join(dir, 'facts.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean)) { const j = JSON.parse(l); versions[j.id] = String(j.version || ''); }
    const checks = scoreAll(rows, gens, versions);
    console.log(`held-out cases: ${rows.length}\n` + 'source'.padEnd(28) + 'valid  complete  accepted  overlap  words  sec/answer');
    const pct = (a: Check[], f: (c: Check) => boolean) => `${a.filter(f).length}/${a.length}`.padStart(5);
    for (const [name, a] of Object.entries(checks)) console.log(name.padEnd(28) + `${pct(a, (c) => c.valid)}  ${pct(a, (c) => c.complete).padStart(8)}  ${pct(a, (c) => c.accepted).padStart(8)}  ${(a.reduce((s, c) => s + c.f1, 0) / a.length).toFixed(2).padStart(7)}  ${String(Math.round(a.reduce((s, c) => s + c.words, 0) / a.length)).padStart(5)}  ${(a.reduce((s, c) => s + c.seconds, 0) / a.length).toFixed(1).padStart(9)}`);
    for (const [name, a] of Object.entries(checks)) for (const c of a.filter((x) => !x.accepted)) console.log(`  ${name}: ${c.id} not accepted: ${!c.valid ? (c.parsed ? 'JSON not clean (text around it)' : 'not valid JSON') : !c.complete ? 'a part is missing' : !c.names ? 'does not name the tool' : `not in the facts: ${c.bad.slice(0, 4).join(', ')}`}`);
    fs.writeFileSync(path.join(dir, 'eval-results.json'), JSON.stringify(Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.map(({ parsed, ...rest }) => rest)])), null, 2));
    if (cmd === 'sheet') console.log(`\nblind sheet: ${await buildSheet(dir, rows, checks)}\nthen: npm run rca:blind -- score "<that file>"`);
  })();
}
