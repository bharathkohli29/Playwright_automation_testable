import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import { exportReview, importReview } from '../utils/rcaDataset';

/** a branch folder with four tools (two fine, two failed) and a Python 3.12 S3 check, so the version placeholder is exercised */
function branch() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rcads-')); const live = path.join(d, 'eks-live'); fs.mkdirSync(live, { recursive: true });
  const pods = [{ tool: 'radon', phase: 'Succeeded', exit: 0, lines: ['done'] }, { tool: 'gitleaks', phase: 'Failed', exit: 1, lines: ['WRN leaks found: 3'] },
    { tool: 'pip-audit', phase: 'Failed', exit: 1, lines: ["Failed to upgrade `pip`"] }, { tool: 'cosmic-ray', phase: 'Failed', exit: 2, lines: ["Error: No such option '--force'."] }];
  const recs = pods.map((p, i) => { const rel = `pods/p${i}/console.log`; fs.mkdirSync(path.join(live, 'pods', `p${i}`), { recursive: true }); fs.writeFileSync(path.join(live, rel), p.lines.join('\n'));
    return { tool: p.tool, task: `t${i}`, pod: `wb-exec-${i}`, phase: p.phase, exit_code: p.exit, reason: p.phase === 'Failed' ? 'Error' : 'Completed', command: `${p.tool} run`, console_file: rel }; });
  fs.writeFileSync(path.join(live, 'tools.json'), JSON.stringify(recs)); fs.writeFileSync(path.join(live, 'services.log'), '');
  fs.writeFileSync(path.join(live, 'tool-status.json'), JSON.stringify(Object.fromEntries(pods.map((p) => [p.tool, p.phase === 'Failed' ? 'FAILED' : 'PASSED']))));
  fs.writeFileSync(path.join(live, 'summary.json'), JSON.stringify({ run_id: 'abcdef12-0000', branch: 'PY_X' }));
  fs.writeFileSync(path.join(d, 's3-check.json'), JSON.stringify({ run_id: 'abcdef12-0000', branch: 'PY_X', python: { version: '3.12', defects: [], tools: [] }, checks: [] }));
  return d;
}
const lines = (f: string) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

test('export writes one reviewable row per tool and the exact prompts; import keeps only what a person approved', async () => {
  const d = branch(); const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rcads-out-'));
  assert.equal(await exportReview([d, d], out, true), 4); // the same run twice is still 4 cases, not 8
  const side = lines(path.join(out, 'facts.jsonl')); assert.deepEqual(side.map((s: any) => s.tool).sort(), ['cosmic-ray', 'gitleaks', 'pip-audit', 'radon']);
  assert.ok(side.every((s: any) => /Write the report for/.test(s.user) && s.system.length > 100 && s.version === '3.12'));

  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path.join(out, 'review.xlsx')); const ws = wb.getWorksheet('Review')!;
  const rowOf = (tool: string) => { let r = 0; ws.eachRow((row, i) => { if (i > 1 && row.getCell(3).text === tool) r = i; }); return ws.getRow(r); };
  assert.equal(rowOf('radon').getCell(4).text, 'GREEN'); assert.equal(rowOf('pip-audit').getCell(4).text, 'RED');
  const DEC = 12, WHY = 15;
  rowOf('radon').getCell(DEC).value = 'OK';
  rowOf('gitleaks').getCell(DEC).value = 'SKIP';
  rowOf('pip-audit').getCell(DEC).value = 'EDIT'; rowOf('pip-audit').getCell(WHY).value = 'pip-audit could not run its pip upgrade, so the dependency audit never started. The log does not say why pip failed.';
  rowOf('cosmic-ray').getCell(DEC).value = 'EDIT'; rowOf('cosmic-ray').getCell(WHY).value = 'cosmic-ray was started with an option the tool does not have; see /etc/cosmic/ray.toml and retry 9999 times.'; // invented path and number
  await wb.xlsx.writeFile(path.join(out, 'review.xlsx'));

  const r = await importReview(path.join(out, 'review.xlsx'));
  assert.equal(r.train + r.holdout, 2); assert.equal(r.skipped, 1); assert.equal(r.rejected.length, 1); assert.match(r.rejected[0], /cosmic-ray.*not in the facts/);
  const all = [...lines(path.join(out, 'train.jsonl')), ...lines(path.join(out, 'holdout.jsonl'))];
  assert.deepEqual(all.map((x: any) => x.id.split('-').slice(1).join('-')).sort(), ['pip-audit', 'radon']);
  const pip = all.find((x: any) => /pip-audit/.test(x.id)); assert.deepEqual(pip.messages.map((m: any) => m.role), ['system', 'user', 'assistant']);
  const ans = JSON.parse(pip.messages[2].content); assert.match(ans.why, /dependency audit never started/); assert.ok(ans.oneLine.length > 10); // the corrected cell won, the other parts are the draft
  assert.doesNotMatch(pip.messages[2].content, /3\.12/); // the version is the placeholder, as in the prompt
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'dataset.json'), 'utf8')).enough, false); // 2 cases are far too few to train on
  const again = await importReview(path.join(out, 'review.xlsx')); assert.equal(again.holdout, r.holdout); // the split is by id, so it never changes between imports
});
