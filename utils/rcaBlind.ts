import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as ExcelJS from 'exceljs';
import './env'; // loads .env
import { buildFactPack, defectiveTools } from './rcaFacts';
import { reportFromRules } from './rcaReport';
import { promptFor } from './rcaWriter';

/**
 * Blind comparison of the base models, scored by people:
 *   npm run rca:blind -- build "<branch folder>" ["<branch folder>" ...] [--bakeoff <dir>] [--out <dir>]
 *       takes the reports every model wrote in the bake-off (results/rca-bakeoff/<model>/<folder name>/<tool>.md) plus the rule-written report as a baseline,
 *       and writes blind-scoring.xlsx: for each case the candidates A, B, C ... in a random order with the model names hidden (they are in a very hidden sheet).
 *       A model answer the checks did not accept is left out of its case (that tool got the rule text anyway).
 *   npm run rca:blind -- score "<blind-scoring.xlsx>"
 *       reads the scores of the reviewer sheets (clarity and accuracy, 1 to 5) and prints the mean per model, per reviewer, and how often the reviewers agree.
 */
const SHEETS = ['Reviewer 1', 'Reviewer 2'];
const HEAD = ['Case', 'Tool', 'Candidate', 'One sentence', 'What happened', 'Why', 'Impact', 'What to do', 'Clarity 1-5', 'Accuracy 1-5', 'Note'];
const RULES = 'rules (baseline)';
const order = (a: string[], seed: string) => a.map((x) => ({ x, k: crypto.createHash('sha1').update(`${seed}|${x}`).digest('hex') })).sort((p, q) => (p.k < q.k ? -1 : 1)).map((o) => o.x);

interface Cand { model: string; one: string; what: string; why: string; impact: string; fix: string }
const asCand = (model: string, r: any): Cand => ({ model, one: String(r.oneLine || ''), what: (r.whatHappened || []).join('\n'), why: String(r.why || ''), impact: String(r.impact || ''), fix: String(r.fix || '') });

export async function buildBlind(dirs: string[], bakeoff: string, out: string): Promise<{ cases: number; candidates: number; models: string[] }> {
  const models = fs.readdirSync(bakeoff).filter((m) => fs.statSync(path.join(bakeoff, m)).isDirectory());
  fs.mkdirSync(out, { recursive: true });
  const wb = new ExcelJS.Workbook(); const facts = wb.addWorksheet('Facts'); facts.addRow(['Case', 'Tool', 'State', 'The facts every candidate was written from']);
  const how = wb.addWorksheet('How to score');
  [['Each case has several candidate texts (A, B, C ...) written from the SAME facts. You do not know which model wrote which; one candidate may be the plain rule text.'],
    ['Read the facts of the case in the sheet "Facts" first. Then score every candidate:'], ['  Clarity 1-5: can a QA engineer who is not a Kubernetes expert understand it at once? (1 = confusing, 5 = clear and short)'],
    ['  Accuracy 1-5: does it say only what the facts say, and say it correctly? (1 = wrong or invented, 5 = exactly right). A wrong claim is a 1 or 2 even when it reads well.'],
    ['Work alone, in your own sheet (Reviewer 1 or Reviewer 2). Do not look at the other reviewer. Notes are optional.']].forEach((r) => how.addRow(r)); how.getColumn(1).width = 130;
  const sheets = SHEETS.map((n) => { const ws = wb.addWorksheet(n); ws.addRow(HEAD); return ws; });
  const key = wb.addWorksheet('Key'); key.addRow(['Case', 'Candidate', 'Model']); key.state = 'veryHidden';
  let cases = 0, candidates = 0; const seen = new Set<string>();
  for (const dir of dirs.map((d) => path.resolve(d))) for (const tool of defectiveTools(dir)) {
    const p = buildFactPack(dir, tool); const base = reportFromRules(p); const id = `${(p.runId || path.basename(dir)).slice(0, 8)}-${tool}`; if (seen.has(id)) continue;
    const cands: Cand[] = [];
    for (const m of models) {
      const f = path.join(bakeoff, m, path.basename(dir), `${tool}.md`); if (!fs.existsSync(f)) continue;
      const raw = fs.readFileSync(f, 'utf8'); if (/^<!-- NOT ACCEPTED/.test(raw)) continue; // the checks threw this answer away: it is not a model answer
      try { cands.push(asCand(m, JSON.parse(raw))); } catch { /* unreadable: left out */ }
    }
    if (cands.length < 2) continue; seen.add(id); // a comparison needs at least two model answers
    cands.push(asCand(RULES, base)); cases++;
    const label = `C${String(cases).padStart(2, '0')}`; facts.addRow([label, tool, base.state, promptFor(p, base).facts]);
    order(cands.map((c) => c.model), id).forEach((m, i) => {
      const c = cands.find((x) => x.model === m)!; const letter = String.fromCharCode(65 + i); candidates++; key.addRow([label, letter, m]);
      for (const ws of sheets) { const row = ws.addRow([label, tool, letter, c.one, c.what, c.why, c.impact, c.fix, '', '', '']); for (const col of [9, 10]) row.getCell(col).dataValidation = { type: 'whole', operator: 'between', formulae: [1, 5], allowBlank: true, showErrorMessage: true, errorTitle: 'Score', error: 'A whole number from 1 to 5' }; }
    });
  }
  const widths = [7, 18, 10, 42, 50, 55, 40, 45, 11, 11, 30];
  for (const ws of sheets) { ws.columns.forEach((c, i) => { c.width = widths[i]; c.alignment = { wrapText: true, vertical: 'top' }; }); const h = ws.getRow(1); h.font = { bold: true, color: { argb: 'FFFFFFFF' } }; h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } }; ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 3 }]; }
  [[facts, [7, 18, 26, 130]]].forEach(([ws, w]: any) => { ws.columns.forEach((c: any, i: number) => { c.width = w[i]; c.alignment = { wrapText: true, vertical: 'top' }; }); ws.getRow(1).font = { bold: true }; });
  await wb.xlsx.writeFile(path.join(out, 'blind-scoring.xlsx'));
  return { cases, candidates, models: [...models, RULES] };
}

export interface ModelScore { model: string; n: number; clarity: number; accuracy: number; byReviewer: Record<string, { clarity: number; accuracy: number; n: number }> }
export async function scoreBlind(xlsx: string): Promise<{ models: ModelScore[]; agreement: number; pairs: number; missing: number }> {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(xlsx);
  const key = new Map<string, string>(); wb.getWorksheet('Key')?.eachRow((r, i) => { if (i > 1) key.set(`${r.getCell(1).text}|${r.getCell(2).text}`, r.getCell(3).text); });
  const acc: Record<string, { c: number[]; a: number[]; r: Record<string, { c: number[]; a: number[] }> }> = {}; const pairs = new Map<string, number[][]>(); let missing = 0;
  for (const name of SHEETS) wb.getWorksheet(name)?.eachRow((row, i) => {
    if (i === 1) return; const k = `${row.getCell(1).text}|${row.getCell(3).text}`; const model = key.get(k); const c = Number(row.getCell(9).text), a = Number(row.getCell(10).text);
    if (!model || !(c >= 1 && c <= 5) || !(a >= 1 && a <= 5)) { if (model) missing++; return; }
    const m = (acc[model] ||= { c: [], a: [], r: {} }); m.c.push(c); m.a.push(a); (m.r[name] ||= { c: [], a: [] }).c.push(c); m.r[name].a.push(a);
    (pairs.get(k) || pairs.set(k, []).get(k)!).push([c, a]);
  });
  const mean = (x: number[]) => (x.length ? x.reduce((s, v) => s + v, 0) / x.length : 0);
  const models: ModelScore[] = Object.entries(acc).map(([model, m]) => ({ model, n: m.c.length, clarity: mean(m.c), accuracy: mean(m.a), byReviewer: Object.fromEntries(Object.entries(m.r).map(([r, v]) => [r, { clarity: mean(v.c), accuracy: mean(v.a), n: v.c.length }])) })).sort((x, y) => (y.accuracy + y.clarity) - (x.accuracy + x.clarity));
  const both = [...pairs.values()].filter((v) => v.length >= 2); const agree = both.filter((v) => Math.abs(v[0][0] - v[1][0]) <= 1 && Math.abs(v[0][1] - v[1][1]) <= 1).length;
  return { models, agreement: both.length ? agree / both.length : 0, pairs: both.length, missing };
}

if (require.main === module) {
  (async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    const take = (f: string) => { const i = rest.indexOf(f); return i >= 0 ? rest.splice(i, 2)[1] : ''; };
    const bake = path.resolve(take('--bakeoff') || path.join(__dirname, '..', 'results', 'rca-bakeoff')); const o = take('--out');
    if (cmd === 'build' && rest.length && rest.every((d) => fs.existsSync(d)) && fs.existsSync(bake)) {
      const d = new Date(); const p2 = (x: number) => String(x).padStart(2, '0');
      const out = path.resolve(o || path.join(__dirname, '..', 'results', 'rca-blind', `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`));
      const r = await buildBlind(rest, bake, out);
      console.log(`${r.cases} case(s), ${r.candidates} candidate text(s), compared: ${r.models.join(', ')}\n${path.join(out, 'blind-scoring.xlsx')}\nGive it to two reviewers (one sheet each); then:  npm run rca:blind -- score "${path.join(out, 'blind-scoring.xlsx')}"`);
    } else if (cmd === 'score' && rest[0] && fs.existsSync(rest[0])) {
      const r = await scoreBlind(rest[0]);
      console.log('model'.padEnd(26) + 'scored  clarity  accuracy'); for (const m of r.models) console.log(`${m.model.padEnd(26)}${String(m.n).padStart(6)}  ${m.clarity.toFixed(2).padStart(7)}  ${m.accuracy.toFixed(2).padStart(8)}   ${Object.entries(m.byReviewer).map(([k, v]) => `${k}: ${v.clarity.toFixed(1)}/${v.accuracy.toFixed(1)}`).join('  ')}`);
      console.log(`reviewers agree (within 1 point on both scores) on ${(r.agreement * 100).toFixed(0)}% of ${r.pairs} text(s) scored by both${r.missing ? `; ${r.missing} row(s) not scored yet` : ''}`);
    } else {
      console.log('Usage:\n  npm run rca:blind -- build "<branch folder>" ["<branch folder>" ...] [--bakeoff <dir>] [--out <dir>]\n  npm run rca:blind -- score "<blind-scoring.xlsx>"'); process.exit(1);
    }
  })();
}
