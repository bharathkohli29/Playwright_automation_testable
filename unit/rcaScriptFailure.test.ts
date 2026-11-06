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
