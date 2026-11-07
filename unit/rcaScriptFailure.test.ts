process.env.RCA_CODE = 'off';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { parseFailure, analyseScriptFailure, scriptFailureHtml } from '../utils/rcaScriptFailure';

const MSG = '1 case(s) failed:\n[CS_VNET8_SDKMSBUILD_CPM_MICRO/15] locator.click: Timeout 20000ms exceeded. Call log: \u001b[2m - waiting for locator(\'button[aria-label*="taxonomy" i]:has(svg.lucide-download), button:has(svg.lucide-download)\').first()\u001b[22m \u001b[2m - locator resolved to <button disabled type="button" data-slot="button" aria-label="Taxonomy report download unavailable until export is ready" title="Available after gate evidence loads and the run snapshot is exportable" class="inline-flex items-center">';

test('parseFailure reads the step, the labels, the disabled state and the wait from the failure text', () => {
  const f = parseFailure(MSG); assert.equal(f.branch, 'CS_VNET8_SDKMSBUILD_CPM_MICRO'); assert.equal(f.step, '15'); assert.equal(f.disabled, true); assert.equal(f.timeoutMs, 20000);
  assert.deepEqual(f.labels, ['Taxonomy report download unavailable until export is ready', 'Available after gate evidence loads and the run snapshot is exportable']);
});

test('a disabled control: the analysis names the condition from the page text, uses the run files and the cluster lines, and is honest about what is proven', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-')); fs.mkdirSync(path.join(d, 'eks-live'));
  fs.writeFileSync(path.join(d, 'run-details.json'), JSON.stringify({ run_id: 'e60cb65a-1', status: 'pending', phase: 'executing', total_tasks: 35, completed_tasks: 16, failed_tasks: 6, skipped_tasks: 8 }));
  fs.writeFileSync(path.join(d, 'eks-live', 'services.log'), ['[orch] x info nothing', '[orch] 2026-11-04T10:00:00Z run.snapshot.export_not_ready run_id=e60cb65a'].join('\n'));
  const sf = analyseScriptFailure(d, MSG);
  assert.match(sf.oneLine, /Step 15 failed.*stayed disabled/); assert.match(sf.likely, /until: "Available after gate evidence loads and the run snapshot is exportable"/);
  assert.match(sf.run.join(' '), /35 total, 16 completed, 6 failed, 8 skipped/); assert.match(sf.eks.join(' '), /snapshot\.export_not_ready/);
  assert.match(sf.proof, /Inferred/); assert.match(sf.owner, /Undecided/); assert.match(sf.headline, /failed at step 15/);
  const html = scriptFailureHtml(sf); assert.match(html, /SCRIPT FAILURE: step 15/); assert.match(html, /Evidence from the three sources/);
});

test('a failure without page text still gets an honest, short analysis and no crash', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-')); const sf = analyseScriptFailure(d, '1 case(s) failed:\n[X/9] page.goto: net::ERR_FAILED');
  assert.match(sf.oneLine, /Step 9 failed/); assert.match(sf.proof, /Unknown/); assert.match(sf.run.join(' '), /No run-details/);
});

import { pageMessages } from '../utils/rcaScriptFailure';
import { setTrail, trailHtml } from '../utils/rcaTrail';
import { explainLines } from '../utils/rcaIssue';
const PAGE_TEXT = ['Repository ready', 'JavaScript_Corpus_ToolTriggering', 'Run plan', 'Review scope and what we will classify.', 'BRANCHES TO ANALYZE', 'The selected branch is not on this run plan yet.', 'Static & structural signals', 'Execute run'].join(String.fromCharCode(10));

test('the page itself says why: the message of the page is read from errors/page-text.txt and drives the analysis', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-')); fs.mkdirSync(path.join(d, 'errors')); fs.writeFileSync(path.join(d, 'errors', 'page-text.txt'), PAGE_TEXT);
  assert.deepEqual(pageMessages(d), ['The selected branch is not on this run plan yet.']);
  const msg = '1 case(s) failed:' + String.fromCharCode(10) + '[JS_V21_VITE_NPM_MONO/8] locator.click: Timeout 20000ms exceeded. Call log: - locator resolved to <button disabled type="button">Execute run</button>';
  const sf = analyseScriptFailure(d, msg);
  assert.deepEqual(sf.pageMsgs, ['The selected branch is not on this run plan yet.']);
  assert.match(sf.oneLine, /Step 8 failed: the page says "The selected branch is not on this run plan yet[.]" and the button stayed disabled/);
  assert.match(sf.symptom, /could not go on/); assert.match(sf.likely, /does not let the run go on while/); assert.match(sf.proof, /Inferred/);
  const lines = explainLines(sf, null, 'RCA_The_selected_branch_is_not_on_this_run_plan_yet.pdf');
  assert.equal(lines.length, 6); assert.match(lines[0], /^What happened: /); assert.match(lines[1], /^Why that was the case: /); assert.match(lines[2], /^How sure we are: /); assert.match(lines[3], /^Who should act: /); assert.match(lines[4], /^What to check first: /); assert.match(lines[5], /RCA_The_selected_branch/);
  assert.equal(pageMessages(path.join(d, 'nothing')).length, 0);
});

test('explainLines uses the conclusion of the code analysis when there is one', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-')); const sf = analyseScriptFailure(d, '1 case(s) failed:' + String.fromCharCode(10) + '[X/9] page.goto: net::ERR_FAILED');
  const l = explainLines(sf, { tool: 't', model: 'm', steps: [], note: '', ms: 1, conclusion: { cause: 'The branch was never added to the plan.', proof: 'Proven', evidence: 'a/b.ts:3', owner: 'Platform', next: 'Add the branch to the plan.' } }, 'RCA_X.pdf');
  assert.match(l[1], /The branch was never added to the plan/); assert.match(l[2], /Proven/); assert.match(l[3], /Platform/); assert.match(l[4], /Add the branch to the plan/);
});

import { condOf } from '../utils/rcaScriptFailure';
test('condOf takes the condition that is right in front of the message, not an earlier one', () => {
  const NL = String.fromCharCode(10);
  const snippet = ["<p>", "  {canChooseBranch", "    ? 'Choose one mirrored branch (tip SHA).'", "    : 'Selected branch (tip SHA).'}", "</p>", "{listed.length === 0 ? (", "  <p className=\"mt-2\">", "    The selected branch is not on this run plan yet."].join(NL);
  assert.equal(condOf(snippet), 'listed.length === 0');
  assert.equal(condOf('<button disabled={!allowed || busy} onClick={go}>'), '!allowed || busy');
  assert.equal(condOf('{!ready && (<p>Not ready</p>)}'), '!ready'); assert.equal(condOf('no condition here'), '');
});

test('the Teams explanation says how to solve it when the analysis found a fix, and the report page has a How to solve it part', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-')); const sf = analyseScriptFailure(d, '1 case(s) failed:' + String.fromCharCode(10) + '[X/9] page.goto: net::ERR_FAILED');
  const trail = { tool: 't', model: 'm', steps: [], note: '', ms: 1, conclusion: { cause: 'The mirror had not synced the branch.', proof: 'Inferred', evidence: '', owner: 'Platform', next: 'Check the sync status of the repository.', fix: 'Wait for the mirror sync of the repository before opening the run plan.', workaround: 'Open the run plan again after the sync is done.', verify: 'The branch shows up on the run plan.' } };
  const l = explainLines(sf, trail, 'RCA_X.pdf'); assert.ok(l.some((x) => /^How to solve it: Wait for the mirror sync/.test(x))); assert.ok(l.some((x) => /^Right now: Open the run plan again/.test(x))); assert.ok(l.some((x) => /^What to check first: Check the sync status/.test(x)));
  setTrail(trail); const html = trailHtml('t'); assert.match(html, /How to solve it/); assert.match(html, /Fix:<\/b> Wait for the mirror sync/); assert.match(html, /Right now \(workaround\)/); assert.match(html, /How to check that it is solved/);
});
