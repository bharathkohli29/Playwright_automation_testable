import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import { exportGold, scoreGold, predictedClass, rawEvidence } from '../utils/rcaGold';
import { buildFactPack } from '../utils/rcaFacts';
import { writeReport } from '../utils/rcaWriter';
import { makeBranch } from './fixtures';

/** fills the answers of one person: fn(id, role, headerIndex) returns the values to set (or nothing to leave the row empty) */
async function fill(file: string, fn: (id: string, role: string) => Record<string, string> | void) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file); const ws = wb.getWorksheet('Gold')!; const col: Record<string, number> = {}; ws.getRow(1).eachCell((c, i) => { col[String(c.value)] = i; });
  ws.eachRow((row, i) => { if (i === 1) return; const v = fn(row.getCell(col.id).text, row.getCell(col.role).text); if (v) for (const [h, val] of Object.entries(v)) row.getCell(col[h]).value = val; }); await wb.xlsx.writeFile(file);
}
const YES = { 'CLASS CORRECT? (YES / NO)': 'YES', 'EVIDENCE CORRECT? (YES / NO / NONE)': 'YES', 'OWNER CORRECT? (YES / NO)': 'YES' };

test('the pipeline class of each tool: a rule id, or a class from the S3 state; the raw evidence never shows the pipeline conclusion', () => {
  const d = makeBranch(); assert.equal(predictedClass(buildFactPack(d, 'pip-audit')), 'pip-audit-env-setup-failed'); assert.equal(predictedClass(buildFactPack(d, 'cosmic-ray')), 'unsupported-cli-option'); assert.equal(predictedClass(buildFactPack(d, 'radon')), 'ok');
  const ev = rawEvidence(buildFactPack(d, 'cosmic-ray')); assert.match(ev, /No such option '--force'/); assert.doesNotMatch(ev, /KNOWN CAUSE|unsupported-cli-option/);
});

test('export gives each person a sheet, with a cross-check; score reads the labels and settles agreement, conflicts and accuracy', async () => {
  const d = makeBranch(); const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-'));
  const r = await exportGold([d], out, ['A', 'B', 'C'], { max: 10, crossEvery: 1 }); assert.equal(r.cases, 3); assert.equal(Object.values(r.perPerson).reduce((a, b) => a + b, 0), 6); // 3 cases, each primary + cross-check
  for (const f of ['gold-A.xlsx', 'gold-B.xlsx', 'gold-C.xlsx', 'gold-index.json']) assert.ok(fs.existsSync(path.join(out, f)), f);
  for (const p of ['A', 'B', 'C']) await fill(path.join(out, `gold-${p}.xlsx`), (id, role) => (id.endsWith('cosmic-ray') && role === 'cross-check' ? { ...YES, 'CLASS CORRECT? (YES / NO)': 'NO', 'right class (if NO)': 'other', 'OWNER CORRECT? (YES / NO)': 'NO', 'right owner (if NO)': 'nobody' } : { ...YES }));
  const s = await scoreGold(out);
  assert.equal(s.labelled, 2); assert.equal(s.conflicts.length, 1); assert.match(s.conflicts[0].id, /cosmic-ray/); assert.equal(s.classAcc, 1); assert.deepEqual(s.gates, { cause: true, evidence: true, owner: true });
  assert.ok(fs.existsSync(path.join(out, 'gold-final.json')));
});

test('one reviewer: a wrong class is a miss, a NO without the right class is invalid, and unlabelled rows are counted', async () => {
  const d = makeBranch(); const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-')); await exportGold([d], out, ['A'], { max: 10 });
  await fill(path.join(out, 'gold-A.xlsx'), (id) => (id.endsWith('pip-audit') ? { ...YES, 'CLASS CORRECT? (YES / NO)': 'NO', 'right class (if NO)': 'other' } : id.endsWith('radon') ? { ...YES } : id.endsWith('cosmic-ray') ? { 'CLASS CORRECT? (YES / NO)': 'NO', 'EVIDENCE CORRECT? (YES / NO / NONE)': 'YES', 'OWNER CORRECT? (YES / NO)': 'YES' } : undefined));
  const s = await scoreGold(out);
  assert.equal(s.labelled, 2); assert.equal(s.invalid.length, 1); assert.match(s.invalid[0], /cosmic-ray.*NO needs the right class/); assert.equal(s.classAcc, 0.5); assert.deepEqual(s.misses.map((m) => `${m.pipeline}>${m.gold}`), ['pip-audit-env-setup-failed>other']); assert.equal(s.gates.cause, false);
});

test('the local-only rule: the model writer refuses an Ollama that is not on this PC', async () => {
  const d = makeBranch(); const w = await writeReport(buildFactPack(d, 'pip-audit'), { host: 'http://10.255.255.1:11434', timeoutSec: 2 });
  assert.equal(w.used, 'rules'); assert.match(w.note || '', /blocked: the Ollama address .* is not on this PC/);
});

test('a tool that RAN although the matrix excludes it is explained by the S3 result alone, with no capture and no log line', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nocap-'));
  fs.writeFileSync(path.join(d, 's3-check.json'), JSON.stringify({ run_id: 'abcdef12-1', branch: 'CS_X', csharp: { version: 'net45', tools: [], defects: [{ tool: 'coverlet', tag: '[Planning Defect]', observed: 'RAN_BUT_EXCLUDED', note: 'coverlet ran on net45 although it must be excluded (no execution image)' }] }, checks: [] }));
  const p = buildFactPack(d, 'coverlet'); assert.equal(p.captured, false); assert.equal(p.rule?.id, 'ran-but-excluded'); assert.equal(p.rule?.scope, 's3'); assert.equal(predictedClass(p), 'ran-but-excluded');
  const { reportFromRules } = await import('../utils/rcaReport'); const r = reportFromRules(p); assert.match(r.confidence, /matched in the S3 result/); assert.equal(r.state, 'TRIGGERED · NOT EXPECTED FOR THIS VERSION');
});

test('rescore: accuracy before the fixes (the class stored in the sheet) and after (the class the pipeline gives now), without re-exporting', async () => {
  const d = makeBranch(); const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rescore-')); await exportGold([d], out, ['A'], { max: 10 });
  const idxFile = path.join(out, 'gold-index.json'); const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8')); const final: Record<string, unknown> = {};
  for (const c of idx.cases) { final[c.id] = { cls: c.cls, owner: c.owner, evidenceOk: 'YES' }; if (c.tool === 'pip-audit') c.cls = 'failed-cause-unknown'; } // as if an older pipeline had said "unknown" for pip-audit
  fs.writeFileSync(idxFile, JSON.stringify(idx)); fs.writeFileSync(path.join(out, 'gold-final.json'), JSON.stringify(final));
  const { rescoreGold } = await import('../utils/rcaGold'); const r = await rescoreGold(out, [d]);
  assert.equal(r.n, 3); assert.equal(r.before, 2); assert.equal(r.after, 3); assert.equal(r.changed.length, 1); assert.deepEqual([r.changed[0].was, r.changed[0].now, r.changed[0].gold], ['failed-cause-unknown', 'pip-audit-env-setup-failed', 'pip-audit-env-setup-failed']);
});
