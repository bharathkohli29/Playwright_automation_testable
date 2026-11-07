process.env.RCA_CODE = 'off';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { issueName, issueFile, keywordsOf, folderEvidence, issueHtml } from '../utils/rcaIssue';

test('the report is named RCA_<Name_of_the_issue>.pdf from the first words of the problem', () => {
  assert.equal(issueFile('Run stuck at 1/18 tasks forever, nothing starts'), 'RCA_Run_stuck_at_1_18_tasks_forever_nothing_starts.pdf');
  assert.equal(issueName('taxonomy download button is disabled'), 'Taxonomy_download_button_is_disabled');
  assert.equal(issueName('Tasks are rejected again and again with CELL_CPU_CAPACITY and the tools never start'), 'Tasks_are_rejected_again_and_again_with_CELL_CPU_CAPACITY_and'); // an error code is never cut in half
  assert.equal(issueName('   '), 'Issue'); assert.equal(issueName('///'), 'Issue');
  assert.ok(issueName('word '.repeat(40)).length <= 70);
  assert.equal(issueName('first line only\nsecond line ignored'), 'First_line_only');
});

test('keywordsOf takes run ids, error codes and the meaningful words of the problem', () => {
  const k = keywordsOf('Tasks rejected with CELL_CPU_CAPACITY for run e60cb65a-f68c-45fc-b412-44dd70435ba3 and the worker never frees capacity');
  assert.ok(k.includes('e60cb65a-f68c-45fc-b412-44dd70435ba3')); assert.ok(k.includes('CELL_CPU_CAPACITY')); assert.ok(k.includes('capacity')); assert.ok(!k.includes('the'));
});

test('folderEvidence reads the run record and the lines of an earlier capture that match the problem', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'iss-')); fs.mkdirSync(path.join(d, 'eks-live'));
  fs.writeFileSync(path.join(d, 'run-details.json'), JSON.stringify({ run_id: 'e60cb65a-1', status: 'pending', phase: 'executing', total_tasks: 35, completed_tasks: 16, failed_tasks: 6, skipped_tasks: 8 }));
  fs.writeFileSync(path.join(d, 'eks-live', 'services.log'), ['[o] {"message": "nothing special"}', '[o] {"message": "dispatch.admission_rejected_task reason=CELL_CPU_CAPACITY"}'].join(String.fromCharCode(10)));
  const e = folderEvidence(d, 'rejected with CELL_CPU_CAPACITY');
  assert.match(e[0], /status pending, phase executing, tasks 35 total/); assert.ok(e.some((x) => /captured earlier: dispatch.admission_rejected_task/.test(x))); assert.ok(!e.some((x) => /nothing special/.test(x)));
});

test('issueHtml shows what was reported, the three sources, the conclusion and says so when the cluster was not reached', () => {
  const html = issueHtml('Run stuck waiting for capacity', { pods: [], events: [], logs: [], note: 'the cluster could not be reached (timeout)', reached: false }, ['run e60cb65a: status pending'], [], null, 'origin/qa at abc');
  for (const t of ['ROOT CAUSE ANALYSIS: Run stuck waiting for capacity', 'The problem, as reported', 'EKS cluster', 'Platform code', 'could not be reached', 'The cause could not be established', 'Who fixes it', 'What would confirm it']) assert.match(html, new RegExp(t));
});

import { screenshotHtml, folderShots } from '../utils/rcaScreenshot';
test('screenshots are embedded in the report itself; a missing, oversized or unknown file is handled', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-')); const png = path.join(d, 'errors', 'failure.png'); fs.mkdirSync(path.dirname(png));
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  assert.deepEqual(folderShots(d), [png]); assert.deepEqual(folderShots(path.join(d, 'none')), []);
  const html = screenshotHtml([png, path.join(d, 'missing.png')]); assert.match(html, /Screenshot of the issue/); assert.match(html, /src="data:image\/png;base64,iVBOR/); assert.match(html, /failure[.]png/); assert.equal((html.match(/<img /g) || []).length, 1);
  const txt = path.join(d, 'x.txt'); fs.writeFileSync(txt, 'x'); assert.match(screenshotHtml([txt]), /not a picture type/); assert.equal(screenshotHtml([]), '');
  const big = path.join(d, 'big.png'); fs.writeFileSync(big, Buffer.alloc(9 * 1024 * 1024)); assert.match(screenshotHtml([big]), /left out \(limit 8 MB\)/);
  const page = issueHtml('Button disabled', { pods: [], events: [], logs: [], note: 'n', reached: false }, [], [], null, 'v', [png]); assert.match(page, /Screenshot of the issue/);
});
