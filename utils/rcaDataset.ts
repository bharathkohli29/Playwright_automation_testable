import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as ExcelJS from 'exceljs';
import './env'; // loads .env
import { allTools, buildFactPack } from './rcaFacts';
import { reportFromRules } from './rcaReport';
import { promptFor, rcaModelEnabled, ungrounded, writeReport } from './rcaWriter';

/**
 * Training data for the RCA writer, made from YOUR runs only (nothing from any earlier model or data set):
 *
 *   npm run rca:dataset -- export "<branch folder>" ["<branch folder>" ...] [--rules-only] [--out <dir>]
 *       one row per tool: the facts the model sees, the draft report (model-worded when RCA_MODEL is on, else by rules), and empty columns for a person.
 *       Writes <dir>/review.xlsx and <dir>/facts.jsonl (the exact prompts; keep it next to the sheet).
 *   npm run rca:dataset -- import "<dir>/review.xlsx"
 *       reads the DECISION column (OK = the draft is right, EDIT = use the corrected cells, SKIP = leave it out) and writes
 *       <dir>/train.jsonl and <dir>/holdout.jsonl (chat format; every fifth case, chosen by its id, is held out and must never be trained on), dataset.json and rejected.txt.
 * A corrected answer that contains a path, option, version or number that is not in the facts is rejected (the same rule the writer is held to).
 */
const FIELDS = ['oneLine', 'whatHappened', 'why', 'impact', 'fix'] as const;
type Fields = { oneLine: string; whatHappened: string[]; why: string; impact: string; fix: string };
const safe = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 60);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HEAD = ['id', 'branch', 'tool', 'layout', 'state', 'facts the model sees', 'draft: one sentence', 'draft: what happened', 'draft: why', 'draft: impact', 'draft: what to do',
  'DECISION (OK / EDIT / SKIP)', 'corrected: one sentence', 'corrected: what happened (one sentence per line)', 'corrected: why', 'corrected: impact', 'corrected: what to do', 'reviewer', 'note'];
const COL = Object.fromEntries(HEAD.map((h, i) => [h, i + 1]));
const holdout = (id: string) => parseInt(crypto.createHash('sha1').update(id).digest('hex').slice(0, 6), 16) % 5 === 0;

export async function exportReview(dirs: string[], out: string, rulesOnly: boolean): Promise<number> {
  fs.mkdirSync(out, { recursive: true });
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Review'); ws.addRow(HEAD);
  const how = wb.addWorksheet('How to review');
  [['Read the facts (column F) and the draft (G to K).'], ['DECISION: OK when the draft is right and clear, EDIT when you fix it, SKIP when the case is not usable.'],
    ['EDIT: fill only the corrected cells you want to change; an empty corrected cell keeps the draft text.'], ['Use only what the facts say: no new file names, paths, options, versions or numbers.'],
    ['Write short plain sentences for a QA engineer who is not a Kubernetes expert. No contractions.'], ['Rows without a DECISION are ignored. Keep review.xlsx and facts.jsonl in the same folder.']].forEach((r) => how.addRow(r)); how.getColumn(1).width = 120;
  const side = fs.createWriteStream(path.join(out, 'facts.jsonl')); let n = 0; const seen = new Set<string>(); // the same run in two folders (or twice) is one case: the first folder given wins
  for (const dir of dirs.map((d) => path.resolve(d))) for (const tool of allTools(dir)) {
    const p = buildFactPack(dir, tool); const id = `${(p.runId || path.basename(dir)).slice(0, 8)}-${safe(tool)}`;
    if (seen.has(id)) continue; seen.add(id);
    const base = reportFromRules(p);
    const draft = rulesOnly || !rcaModelEnabled() || base.tone === 'green' ? base : (await writeReport(p)).report;
    const pr = promptFor(p, base);
    const d: Fields = { oneLine: draft.oneLine, whatHappened: draft.whatHappened, why: draft.why, impact: draft.impact, fix: draft.fix };
    side.write(JSON.stringify({ id, tool, version: p.version, system: pr.system, user: pr.user, draft: d }) + '\n');
    const row = ws.addRow([id, p.branch, tool, base.tone === 'green' ? 'GREEN' : 'RED', draft.state, pr.facts, d.oneLine, d.whatHappened.join('\n'), d.why, d.impact, d.fix, '', '', '', '', '', '', '', '']);
    row.getCell(COL['DECISION (OK / EDIT / SKIP)']).dataValidation = { type: 'list', allowBlank: true, formulae: ['"OK,EDIT,SKIP"'] };
    row.getCell(COL.layout).font = { bold: true, color: { argb: base.tone === 'green' ? 'FF047857' : 'FFB91C1C' } };
    n++;
  }
  await new Promise((r) => side.end(r));
  const widths = [16, 20, 20, 8, 26, 70, 40, 50, 55, 40, 45, 16, 40, 50, 55, 40, 45, 14, 30];
  ws.columns.forEach((c, i) => { c.width = widths[i]; c.alignment = { wrapText: true, vertical: 'top' }; });
  const h = ws.getRow(1); h.font = { bold: true, color: { argb: 'FFFFFFFF' } }; h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } }; ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 3 }];
  await wb.xlsx.writeFile(path.join(out, 'review.xlsx'));
  return n;
}

export async function importReview(xlsx: string): Promise<{ train: number; holdout: number; skipped: number; rejected: string[]; undecided: number }> {
  const dir = path.dirname(path.resolve(xlsx));
  const facts = new Map<string, any>(fs.readFileSync(path.join(dir, 'facts.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { const j = JSON.parse(l); return [j.id, j]; }));
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(xlsx); const ws = wb.getWorksheet('Review'); if (!ws) throw new Error('the sheet "Review" is missing');
  const train: string[] = []; const hold: string[] = []; const rejected: string[] = []; let skipped = 0, undecided = 0;
  ws.eachRow((row, i) => {
    if (i === 1) return; const get = (h: string) => String(row.getCell(COL[h]).text ?? '').trim();
    const id = get('id'); const dec = get('DECISION (OK / EDIT / SKIP)').toUpperCase(); const f = facts.get(id);
    if (!dec) { undecided++; return; } if (dec === 'SKIP') { skipped++; return; }
    if (!f) { rejected.push(`${id}: not in facts.jsonl`); return; }
    if (dec !== 'OK' && dec !== 'EDIT') { rejected.push(`${id}: DECISION must be OK, EDIT or SKIP (found "${dec}")`); return; }
    const t: Fields = { ...f.draft };
    if (dec === 'EDIT') {
      const o = get('corrected: one sentence'), w = get('corrected: what happened (one sentence per line)'), y = get('corrected: why'), im = get('corrected: impact'), fx = get('corrected: what to do');
      if (o) t.oneLine = o; if (w) t.whatHappened = w.split(/\r?\n/).map((x) => x.trim()).filter(Boolean); if (y) t.why = y; if (im) t.impact = im; if (fx) t.fix = fx;
    }
    const text = [t.oneLine, ...t.whatHappened, t.why, t.impact, t.fix].join(' ');
    if (!FIELDS.every((k) => (k === 'whatHappened' ? t.whatHappened.length : String(t[k]).trim()))) { rejected.push(`${id}: a part is empty`); return; }
    if (!text.toLowerCase().includes(String(f.tool).toLowerCase().split(/[-_]/)[0])) { rejected.push(`${id}: the text does not name the tool`); return; }
    const bad = ungrounded(text, `${f.user}\n${f.version}\n${[f.draft.oneLine, ...f.draft.whatHappened, f.draft.why, f.draft.impact, f.draft.fix].join('\n')}`);
    if (bad.length) { rejected.push(`${id}: not in the facts: ${bad.slice(0, 5).join(', ')}`); return; }
    const ver = f.version ? new RegExp('(?<![\\w.])' + esc(f.version) + '(?![\\w])', 'g') : null; // the model never writes the version: <V>
    const target = JSON.stringify({ oneLine: t.oneLine, whatHappened: t.whatHappened, why: t.why, impact: t.impact, fix: t.fix }); const answer = ver ? target.replace(ver, '<V>') : target;
    (holdout(id) ? hold : train).push(JSON.stringify({ id, messages: [{ role: 'system', content: f.system }, { role: 'user', content: f.user }, { role: 'assistant', content: answer }] }));
  });
  fs.writeFileSync(path.join(dir, 'train.jsonl'), train.join('\n') + (train.length ? '\n' : '')); fs.writeFileSync(path.join(dir, 'holdout.jsonl'), hold.join('\n') + (hold.length ? '\n' : ''));
  fs.writeFileSync(path.join(dir, 'rejected.txt'), rejected.join('\n') + (rejected.length ? '\n' : ''));
  fs.writeFileSync(path.join(dir, 'dataset.json'), JSON.stringify({ at: new Date().toISOString(), train: train.length, holdout: hold.length, skipped, rejected: rejected.length, undecided, enough: train.length >= 150 }, null, 2));
  return { train: train.length, holdout: hold.length, skipped, rejected, undecided };
}

if (require.main === module) {
  (async () => {
    const [cmd, ...rest] = process.argv.slice(2); const ri = rest.indexOf('--out'); const oa = ri >= 0 ? rest.splice(ri, 2)[1] : '';
    const ro = rest.indexOf('--rules-only'); const rulesOnly = ro >= 0; if (ro >= 0) rest.splice(ro, 1);
    if (cmd === 'export' && rest.length && rest.every((d) => fs.existsSync(d))) {
      const d = new Date(); const p2 = (x: number) => String(x).padStart(2, '0');
      const out = path.resolve(oa || path.join(__dirname, '..', 'results', 'rca-dataset', `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`));
      const n = await exportReview(rest, out, rulesOnly);
      console.log(`${n} tool(s) exported to ${path.join(out, 'review.xlsx')} (+ facts.jsonl). Give the sheet to two reviewers; then:  npm run rca:dataset -- import "${path.join(out, 'review.xlsx')}"`);
    } else if (cmd === 'import' && rest[0] && fs.existsSync(rest[0])) {
      const r = await importReview(rest[0]);
      console.log(`train ${r.train} · holdout ${r.holdout} · skipped ${r.skipped} · rejected ${r.rejected.length} · not decided ${r.undecided}`);
      for (const x of r.rejected.slice(0, 15)) console.log(`  rejected: ${x}`);
      console.log(r.train < 150 ? `  only ${r.train} training case(s): too few to fine-tune (aim for 150 or more); keep collecting runs and reviews.` : '  enough cases to try a fine-tune; score it on holdout.jsonl before using it.');
    } else {
      console.log('Usage:\n  npm run rca:dataset -- export "<branch folder>" ["<branch folder>" ...] [--rules-only] [--out <dir>]\n  npm run rca:dataset -- import "<dir>/review.xlsx"');
      process.exit(1);
    }
  })();
}
