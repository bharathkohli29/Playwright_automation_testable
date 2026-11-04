import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import { buildBlind, scoreBlind } from '../utils/rcaBlind';

/** a branch folder "br" with one defective tool (pip-audit, failed pod), and a fake bake-off of three models */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcablind-')); const d = path.join(root, 'br'); const live = path.join(d, 'eks-live'); fs.mkdirSync(path.join(live, 'pods', 'p0'), { recursive: true });
  fs.writeFileSync(path.join(live, 'pods', 'p0', 'console.log'), "Failed to upgrade `pip`");
  fs.writeFileSync(path.join(live, 'tools.json'), JSON.stringify([{ tool: 'pip-audit', task: 't0', pod: 'wb-exec-0', phase: 'Failed', exit_code: 1, reason: 'Error', command: 'pip-audit', console_file: 'pods/p0/console.log' }]));
  fs.writeFileSync(path.join(live, 'services.log'), ''); fs.writeFileSync(path.join(live, 'summary.json'), JSON.stringify({ run_id: 'abcdef12-1', branch: 'PY_X' }));
  fs.writeFileSync(path.join(live, 'tool-status.json'), JSON.stringify({ 'pip-audit': 'FAILED' }));
  fs.writeFileSync(path.join(d, 's3-check.json'), JSON.stringify({ run_id: 'abcdef12-1', branch: 'PY_X', python: { version: '3.12', tools: [], defects: [{ tool: 'pip-audit', tag: '[Runner Execution Defect]', observed: 'FAILED', note: 'failed' }] }, checks: [] }));
  const bake = path.join(root, 'bake');
  const rep = (t: string) => JSON.stringify({ oneLine: `pip-audit ${t}`, whatHappened: ['it stopped'], why: `because ${t}`, impact: 'no result', fix: `fix ${t}` });
  for (const [m, txt] of [['modelAlpha', rep('alpha')], ['modelBeta', rep('beta')], ['modelGamma', `<!-- NOT ACCEPTED: invented path -->\n${rep('gamma')}`]]) { fs.mkdirSync(path.join(bake, m, 'br'), { recursive: true }); fs.writeFileSync(path.join(bake, m, 'br', 'pip-audit.md'), txt); }
  return { d, bake, out: path.join(root, 'out') };
}

test('blind sheet: candidates from the accepted answers plus the rule baseline, model names hidden, scores mapped back per model', async () => {
  const { d, bake, out } = setup();
  const b = await buildBlind([d], bake, out); assert.equal(b.cases, 1); assert.equal(b.candidates, 3); // alpha, beta and the rule text; gamma was not accepted
  const file = path.join(out, 'blind-scoring.xlsx'); const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
  assert.equal(wb.getWorksheet('Key')!.state, 'veryHidden');
  assert.ok(wb.getWorksheet('Facts')!.getCell('D2').text.includes('KNOWN CAUSE') || wb.getWorksheet('Facts')!.getCell('D2').text.includes('TOOL: pip-audit'));
  for (const name of ['Reviewer 1', 'Reviewer 2']) wb.getWorksheet(name)!.eachRow((row) => row.eachCell((c) => assert.doesNotMatch(c.text, /modelAlpha|modelBeta|modelGamma|baseline/))); // blind
  const keyRows: Record<string, string> = {}; wb.getWorksheet('Key')!.eachRow((r, i) => { if (i > 1) keyRows[r.getCell(3).text] = r.getCell(2).text; });
  assert.deepEqual(Object.keys(keyRows).sort(), ['modelAlpha', 'modelBeta', 'rules (baseline)']);
  const fill = (sheet: string, scores: Record<string, [number, number]>) => wb.getWorksheet(sheet)!.eachRow((row, i) => { if (i === 1) return; const model = Object.keys(keyRows).find((m) => keyRows[m] === row.getCell(3).text)!; row.getCell(9).value = scores[model][0]; row.getCell(10).value = scores[model][1]; });
  fill('Reviewer 1', { modelAlpha: [5, 5], modelBeta: [2, 3], 'rules (baseline)': [3, 4] }); fill('Reviewer 2', { modelAlpha: [4, 5], modelBeta: [2, 2], 'rules (baseline)': [3, 5] });
  await wb.xlsx.writeFile(file);
  const s = await scoreBlind(file); assert.equal(s.models[0].model, 'modelAlpha'); assert.equal(s.models[0].n, 2); assert.equal(s.models[0].clarity, 4.5); assert.equal(s.models[0].accuracy, 5);
  assert.equal(s.models.find((m) => m.model === 'modelBeta')!.accuracy, 2.5); assert.equal(s.pairs, 3); assert.equal(s.agreement, 1); assert.equal(s.missing, 0); // all within 1 point
});
