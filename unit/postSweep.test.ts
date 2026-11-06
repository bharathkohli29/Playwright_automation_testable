process.env.RCA_CODE = 'off';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findLeftBehind, repoFor } from '../utils/postSweep';
import { writeReports } from '../utils/rcaReport';

const old = (p: string, minutesAgo: number) => { const t = new Date(Date.now() - minutesAgo * 60_000); fs.utimesSync(p, t, t); };
function branch(root: string, run: string, name: string, files: Record<string, string>, ageMin: number) {
  const d = path.join(root, run, name); fs.mkdirSync(d, { recursive: true });
  for (const [f, c] of Object.entries(files)) { fs.writeFileSync(path.join(d, f), c); old(path.join(d, f), ageMin); } return d;
}

test('findLeftBehind: only a started branch with no result, quiet for 20 minutes and not already handed over', () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-')); const run = 'merge-flow_2026-11-05_1000';
  branch(r, run, 'STOPPED', { 'repo-details.json': '{}' }, 90);                                   // started, nothing else: left behind
  branch(r, run, 'DONE', { 'repo-details.json': '{}', 'postprocess.json': '{"state":"done"}' }, 90); // handed over and finished
  branch(r, run, 'FAILED_HANDED', { 'repo-details.json': '{}' }, 90);                              // failed: handed over when it failed (summary says so)
  branch(r, run, 'FRESH', { 'repo-details.json': '{}' }, 2);                                       // still being written: leave it
  branch(r, run, 'NEVER_STARTED', { 'x.txt': 'x' }, 90);                                           // the flow never started in it
  fs.writeFileSync(path.join(r, run, 'summary.json'), JSON.stringify([{ branch: 'FAILED_HANDED', status: 'failed' }]));
  const left = findLeftBehind(r, 48); assert.deepEqual(left.map((l) => l.branch), ['STOPPED']);
  assert.match(left[0].failure, /script stopped before this branch finished/);
  assert.deepEqual(findLeftBehind(r, 1).map((l) => l.branch), []); // older than the window
});

test('a finished branch that was never post-processed is swept without a failure text; a stale "running" state counts as left behind', () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-')); const run = 'merge-flow_2026-11-05_1100';
  branch(r, run, 'PASSED_NO_WORKER', { 'repo-details.json': '{}' }, 90);
  const stale = branch(r, run, 'STALE_RUNNING', { 'repo-details.json': '{}', 'postprocess.json': '{"state":"running"}' }, 90);
  fs.writeFileSync(path.join(r, run, 'summary.json'), JSON.stringify([{ branch: 'PASSED_NO_WORKER', status: 'passed' }])); old(path.join(stale, 'postprocess.json'), 90);
  const left = findLeftBehind(r, 48).sort((a, b) => a.branch.localeCompare(b.branch));
  assert.deepEqual(left.map((l) => [l.branch, l.failure === '']), [['PASSED_NO_WORKER', true], ['STALE_RUNNING', false]]);
});

test('repoFor takes the repo from builds.json, else from the branch prefix', () => {
  assert.equal(repoFor('TS_X', ['https://github.com/Acme/TypeScript_Repo/tree/TS_X']), 'Acme/TypeScript_Repo');
  assert.equal(repoFor('JV_X', []), 'Nandhini-Testable/Java_Corpus_Tool_Triggering');
});

const noBrowser = (() => { try { return !fs.existsSync(require('playwright').chromium.executablePath()); } catch { return true; } })();
test('a branch with NO tool data still gets a report: the script-failure page alone', { skip: noBrowser }, async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nodata-')); const b = path.join(d, 'JV_NODATA'); fs.mkdirSync(b);
  const rows = await writeReports(b, undefined, undefined, { failure: '1 case(s) failed:\n[JV_NODATA/3] page.goto: net::ERR_FAILED' });
  assert.equal(rows.length, 1); assert.equal(rows[0].state, 'SCRIPT FAILURE'); const pdf = path.join(b, 'RCA Report', rows[0].file); assert.ok(fs.existsSync(pdf)); assert.equal(fs.readFileSync(pdf).subarray(0, 5).toString(), '%PDF-');
  assert.deepEqual(await writeReports(b), []); // without a failure text and without data: nothing, as before
});

test('an empty run never wipes the reports that are already there', { skip: noBrowser }, async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-')); const b = path.join(d, 'JV_KEEP'); fs.mkdirSync(path.join(b, 'RCA Report', 'Triggered'), { recursive: true });
  fs.writeFileSync(path.join(b, 'RCA Report', 'Triggered', 'RCA_old.pdf'), 'good report from an earlier run');
  assert.deepEqual(await writeReports(b), []); assert.ok(fs.existsSync(path.join(b, 'RCA Report', 'Triggered', 'RCA_old.pdf')));
});
