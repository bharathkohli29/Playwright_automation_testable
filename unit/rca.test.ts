process.env.RCA_CODE = 'off'; // the report tests never reach for the platform code or the network
import { matchToolRules } from '../utils/eksRules';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildFactPack, defectiveTools, allTools } from '../utils/rcaFacts';
import { reportFromRules, reportHtml, writeReports, combinedHtml } from '../utils/rcaReport';
import { chromium } from '@playwright/test';

/** the PDF tests need the Chromium that Playwright installs; the GitHub check skips that download, so they are skipped there */
const noBrowser = (() => { try { return fs.existsSync(chromium.executablePath()) ? false : 'no Chromium installed (the check skips the browser download)'; } catch { return 'no Chromium installed'; } })();

/** a branch folder with an eks-live capture: pods = [{tool, task, phase, exit, console lines}] and the service log lines */
function branch(pods: { tool: string; task: string; phase: string; exit: number; lines: string[] }[], services: string[] = [], extra: Record<string, unknown> = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rca-')); const live = path.join(d, 'eks-live'); fs.mkdirSync(path.join(live, 'pods'), { recursive: true });
  const recs = pods.map((p, i) => {
    const pod = `wb-exec-${i}aaa-x${i}`; const rel = path.join('pods', pod, 'console.log'); fs.mkdirSync(path.join(live, 'pods', pod), { recursive: true });
    fs.writeFileSync(path.join(live, rel), p.lines.map((l) => `[pod/${pod}/analyzer] 2026-11-03T10:32:52.5Z ${l}`).join('\n'));
    return { tool: p.tool, task: p.task, pod, phase: p.phase, exit_code: p.exit, reason: p.phase === 'Failed' ? 'Error' : 'Completed', message: '', command: `${p.tool} run`, console_file: rel };
  });
  fs.writeFileSync(path.join(live, 'tools.json'), JSON.stringify(recs));
  fs.writeFileSync(path.join(live, 'services.log'), services.join('\n'));
  fs.writeFileSync(path.join(live, 'tool-status.json'), JSON.stringify(Object.fromEntries(pods.map((p) => [p.tool, p.phase === 'Failed' ? 'FAILED' : 'PASSED']))));
  fs.writeFileSync(path.join(live, 'summary.json'), JSON.stringify({ run_id: 'r1', branch: 'PY_V312_X' }));
  for (const [k, v] of Object.entries(extra)) fs.writeFileSync(path.join(d, k), JSON.stringify(v));
  return d;
}

test('a failed pod is explained by its OWN lines, not by a permission error of another task of the same tool', () => {
  const d = branch(
    [{ tool: 'cosmic-ray', task: 't-fail', phase: 'Failed', exit: 2, lines: ["Usage: cosmic-ray init [OPTIONS] CONFIG_FILE SESSION_FILE", "Error: No such option '--force'."] },
      { tool: 'cosmic-ray', task: 't-ok', phase: 'Succeeded', exit: 0, lines: ['done'] }],
    ['[wb-cpu-worker] {"level":"WARNING","message":"runner_base.cleanup_failed","tool_name":"cosmic-ray","error":"[Errno 13] Permission denied: \'/workspaces/cell-001/a/source\'","task_id":"t-ok"}']);
  const p = buildFactPack(d, 'cosmic-ray');
  assert.equal(p.rule?.id, 'unsupported-cli-option'); assert.equal(p.rule?.scope, 'pod');
  const r = reportFromRules(p);
  assert.match(r.evidence, /No such option '--force'/); assert.match(r.why, /--force/); assert.match(r.impact, /other steps ran/);
});

test('bandit and gitleaks: exit code 1 with findings is expected behaviour, not a defect', () => {
  const d = branch([
    { tool: 'gitleaks', task: 'g', phase: 'Failed', exit: 1, lines: ['10:37AM INF 53 commits scanned.', '10:37AM WRN leaks found: 18'] },
    { tool: 'bandit', task: 'b', phase: 'Failed', exit: 1, lines: ['[json] INFO JSON output written to file: /tmp/x.json'] },
    { tool: 'pip-audit', task: 'p', phase: 'Failed', exit: 1, lines: ["ERROR:pip_audit._cli:Failed to upgrade `pip`: ['/tmp/x/bin/python3.12', '-m', 'pip']"] }]);
  assert.equal(reportFromRules(buildFactPack(d, 'gitleaks')).kind, 'expected');
  assert.match(reportFromRules(buildFactPack(d, 'gitleaks')).why, /18 leak/);
  assert.equal(buildFactPack(d, 'bandit').rule?.id, 'findings-exit-code');
  const pa = reportFromRules(buildFactPack(d, 'pip-audit'));
  assert.equal(pa.kind, 'defect'); assert.match(pa.why, /does not say why pip failed/);
});

test('a tool with no log line gets an honest report; a planning defect is marked as inferred', () => {
  const d = branch([{ tool: 'radon', task: 'r', phase: 'Succeeded', exit: 0, lines: ['ok'] }], [], {
    's3-check.json': { run_id: 'r1', branch: 'PY_V312_X', python: { version: '3.12', defects: [{ tool: 'flake8', tag: '[Planning Defect]', observed: 'NOT_APPLICABLE', note: 'flake8 is expected but was not triggered' }, { tool: 'ghost', tag: '[False Empty Defect]', observed: 'EMPTY', note: 'empty' }] } } });
  assert.deepEqual(defectiveTools(d).sort(), ['flake8', 'ghost']);
  const fl = reportFromRules(buildFactPack(d, 'flake8')); assert.match(fl.why, /inferred/); assert.match(fl.confidence, /Inferred/);
  const gh = reportFromRules(buildFactPack(d, 'ghost')); assert.match(gh.why, /no log lines/i); assert.equal(gh.evidence, '(none)');
});

test('RCA_SPLIT=on: one PDF per tool in Triggered / Not triggered, rebuilt each time; the page holds every part and no other tool', { skip: noBrowser }, async () => {
  process.env.RCA_SPLIT = 'on'; try {
  const d = branch([{ tool: 'gitleaks', task: 'g', phase: 'Failed', exit: 1, lines: ['WRN leaks found: 3'] }, { tool: 'pip-audit', task: 'p', phase: 'Failed', exit: 1, lines: ["Failed to upgrade `pip`"] }]);
  fs.mkdirSync(path.join(d, 'RCA Report'), { recursive: true }); fs.writeFileSync(path.join(d, 'RCA Report', 'RCA_old.md'), 'left by an earlier attempt');
  const rows = await writeReports(d);
  assert.deepEqual(rows.map((r) => r.file).sort(), ['Triggered/RCA_gitleaks.pdf', 'Triggered/RCA_pip-audit.pdf']);
  assert.deepEqual(fs.readdirSync(path.join(d, 'RCA Report')).filter((f) => !/^RCA_Report_.*\.pdf$/.test(f)).sort(), ['Triggered', 'index.json']); // the old file is gone; the one combined report is written as well
  for (const f of rows.map((r) => path.join(d, 'RCA Report', r.file))) { const b = fs.readFileSync(f); assert.equal(b.subarray(0, 5).toString(), '%PDF-'); assert.ok(b.length > 4000); }
  const p = buildFactPack(d, 'pip-audit'); const html = reportHtml(reportFromRules(p), p);
  for (const h of ['What happened', 'Why', 'Evidence', 'Impact', 'Who fixes it', 'What to do', 'Confidence', 'Tool profile']) assert.match(html, new RegExp(h));
  assert.doesNotMatch(html, /gitleaks/); // no other tool leaks into this report
  assert.match(reportHtml({ ...reportFromRules(p), evidence: '<script>x</script>' }, p), /&lt;script&gt;/); // text from logs is escaped
  } finally { delete process.env.RCA_SPLIT; }
});

test('green layout for a triggered tool that is fine, red for the others; not triggered tools go to their own folder; only red ones reach the writer', { skip: noBrowser }, async () => {
  const d = branch([{ tool: 'radon', task: 'r', phase: 'Succeeded', exit: 0, lines: ['done'] }], [], {
    's3-check.json': { run_id: 'r1', branch: 'PY_X', python: { version: '3.12', defects: [{ tool: 'flake8', tag: '[Planning Defect]', observed: 'NOT_APPLICABLE', note: 'flake8 is expected but was not triggered' }],
      tools: [{ tool: 'radon', state: 'NOT_TRIGGERED', note: 'No S3 folder' }, { tool: 'radon', state: 'OUTPUT', note: 'cc for 14 file(s)' }, { tool: 'flake8', state: 'NOT_TRIGGERED', note: 'No S3 folder' }] },
      checks: [{ tool: 'radon', testingType: 'Static', technique: 'Complexity', classifications: [], result: 'PASS', note: 'cc for 14 file(s), 95 block(s)', files: ['radon/a/0/radon.json'] }] },
    's3-folders.json': { 'radon/': ['a/0/radon.json'] } });
  assert.deepEqual(allTools(d).sort(), ['flake8', 'radon']);
  const green = buildFactPack(d, 'radon'); const red = buildFactPack(d, 'flake8');
  assert.equal(green.triggered, true); assert.equal(green.healthy, true); assert.equal(red.triggered, false); assert.equal(red.healthy, false);
  const g = reportFromRules(green); const r = reportFromRules(red);
  assert.equal(g.tone, 'green'); assert.equal(g.state, 'TRIGGERED · RESULT OK'); assert.match(g.evidence, /cc for 14 file/); assert.equal(r.tone, 'red'); assert.equal(r.state, 'NOT TRIGGERED');
  assert.match(reportHtml(g, green), /#047857/); assert.doesNotMatch(reportHtml(g, green), /#b91c1c/); assert.match(reportHtml(r, red), /#b91c1c/); assert.match(reportHtml(r, red), /NOT TRIGGERED/);
  process.env.RCA_SPLIT = 'on'; const asked: string[] = []; let rows: Awaited<ReturnType<typeof writeReports>>; try { rows = await writeReports(d, undefined, async (p) => { asked.push(p.tool); return { report: reportFromRules(p), used: 'rules' }; }); } finally { delete process.env.RCA_SPLIT; }
  assert.deepEqual(asked, ['flake8']); // the green report is written from the facts, the writer is only asked about the red one
  assert.deepEqual(rows.map((x) => x.file).sort(), ['Not triggered/RCA_flake8.pdf', 'Triggered/RCA_radon.pdf']);
});

test('the tool profile: task window, queue wait, pod attempts, timeline order, S3 rows and files, warnings of its task only', () => {
  const ev = (t: string, message: string, o: object = {}, level = 'INFO', task = 'task-1') => `[cell-001-wb-orchestrator] [pod/x/wb] 2026-11-03T10:00:${t}Z ${JSON.stringify({ timestamp: `2026-11-03T10:00:${t}+00:00`, level, service_name: 'wb-orchestrator', message, task_id: task, ...o })}`;
  const d = branch([{ tool: 'radon', task: 'task-1', phase: 'Failed', exit: 1, lines: ['boom'] }], [
    ev('05.000', 'dispatcher.task_published', { queue: 'wb.exec.q1', environment_id: 'worker-python-3-12' }), ev('15.000', 'task.status.started'), ev('16.000', 'consumer.delivery_lease_heartbeat_failed', { delivery_attempt_id: 7 }, 'WARNING'),
    ev('45.000', 'task.status.failed'), ev('50.000', 'consumer.ack'), ev('20.000', 'runner_base.cleanup_failed', { error: 'other task' }, 'WARNING', 'task-OTHER')], {
    's3-check.json': { run_id: 'r1', branch: 'PY_X', python: { version: '3.12', defects: [] }, checks: [{ tool: 'radon', testingType: 'Static', technique: 'Complexity', classifications: ['CC'], result: 'EMPTY', note: 'empty report', files: ['radon/a/0/radon.json'] }] },
    's3-folders.json': { 'radon/': ['a/0/radon.json'] } });
  const f = buildFactPack(d, 'radon').profile;
  assert.equal(f.seconds.queueWait, 10); assert.equal(f.seconds.task, 30); // 10:00:05 -> 10:00:15 waited, 10:00:15 -> 10:00:45 ran
  assert.deepEqual(f.timeline.map((e) => e.label).filter((l) => !l.startsWith('Tool pod')), ['Sent to the worker queue', 'Task started on a worker', 'Task failed', 'Queue message acknowledged']);
  assert.deepEqual(f.warnings.map((w) => w.message), ['consumer.delivery_lease_heartbeat_failed']); // the other task's warning is not here
  assert.equal(f.s3.length, 1); assert.equal(f.s3[0].result, 'EMPTY'); assert.deepEqual(f.s3Files, ['a/0/radon.json']);
  assert.equal(f.attempts[0].exitCode, 1); assert.match(f.identity.map((x) => x.join(' ')).join('|'), /Pod attempts 1/);
  const html = reportHtml(reportFromRules(buildFactPack(d, 'radon')), buildFactPack(d, 'radon'));
  assert.match(html, /Waited in queue/); assert.match(html, /30 s/); assert.match(html, /<h2>Timeline \(IST\)<\/h2>/); assert.match(html, /<h2>S3 result<\/h2>/); assert.doesNotMatch(html, /other task/);
});

test('RUNTIME_IMAGE_DRIFT in a failure.json is a known cause: the plan froze another environment than the worker runs', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-')); const f = path.join(d, 's3-evidence', 'radon', 'id1', '0'); fs.mkdirSync(f, { recursive: true });
  fs.writeFileSync(path.join(f, 'failure.json'), JSON.stringify({ error_code: 'permanent_runner_error', status: 'failed', reason: 'RUNTIME_IMAGE_DRIFT: plan froze environment 5a74d7f2ff7f52b4; this worker is 863dc97044a502f8' }));
  fs.writeFileSync(path.join(d, 's3-check.json'), JSON.stringify({ run_id: 'r-1', branch: 'PY_V312_X', python: { version: '3.12', tools: [], defects: [{ tool: 'radon', tag: '[Runner Execution Defect]', observed: 'FAILED', note: 'failure.json — RUNTIME_IMAGE_DRIFT: plan froze environment 5a74d7f2ff7f52b4; this worker is 863dc97044a502f8' }] }, checks: [] }));
  const p = buildFactPack(d, 'radon'); assert.equal(p.rule?.id, 'runtime-image-drift'); const r = reportFromRules(p);
  assert.match(r.why, /5a74d7f2ff7f52b4/); assert.match(r.why, /863dc97044a502f8/); assert.match(r.owner, /Platform/); assert.match(r.evidence, /RUNTIME_IMAGE_DRIFT/);
});

test('WAVE_IDENTITY_MISMATCH: a run refused in planning because a tool has no wave in the policy is a known cause', () => {
  const t = '"message": "whitebox_run.failed (...)", "failure_reason": "WAVE_IDENTITY_MISMATCH", "error": "Activity task failed", "failing_activity_type": "planning"';
  const r = matchToolRules({ tool: 'any', text: t });
  assert.equal(r?.id, 'wave-identity-mismatch'); assert.match(r?.rootCause || '', /no wave/); assert.match(r?.owner || '', /Platform/);
  assert.equal(matchToolRules({ tool: 'any', text: 'all fine' })?.id === 'wave-identity-mismatch', false);
});

test('RCA_SPLIT=off: ONE overview report: a cover with every tool, then a section per tool with the three sources; no per-tool files', { skip: noBrowser }, async () => {
  process.env.RCA_SPLIT = 'off'; try {
  const d = branch([{ tool: 'gitleaks', task: 'g', phase: 'Failed', exit: 1, lines: ['WRN leaks found: 3'] }, { tool: 'pip-audit', task: 'p', phase: 'Failed', exit: 1, lines: ["Failed to upgrade `pip`"] }]);
  const rows = await writeReports(d);
  const files = fs.readdirSync(path.join(d, 'RCA Report')).sort(); assert.equal(files.length, 2); assert.ok(files.includes('index.json')); const pdf = files.find((f) => f.endsWith('.pdf'))!; assert.match(pdf, /^RCA_Report_/);
  assert.deepEqual([...new Set(rows.map((r) => r.file))], [pdf]); const b = fs.readFileSync(path.join(d, 'RCA Report', pdf)); assert.equal(b.subarray(0, 5).toString(), '%PDF-'); assert.ok(b.length > 6000);
  const items = rows.map((r) => buildFactPack(d, r.tool)).map((p) => ({ r: reportFromRules(p), p })); const html = combinedHtml(items);
  for (const t of ['gitleaks', 'pip-audit', 'ROOT CAUSE ANALYSIS REPORT', 'S3 result', 'EKS logs', 'Platform code', 'All tools']) assert.match(html, new RegExp(t));
  assert.equal((html.match(/class="tool"/g) || []).length, 2);
  } finally { delete process.env.RCA_SPLIT; }
});

test('by default every tool gets its OWN PDF in Triggered / Not triggered, each with the three sources; a script failure is its own PDF; no combined file unless RCA_COMBINED=on', { skip: noBrowser }, async () => {
  delete process.env.RCA_SPLIT; delete process.env.RCA_COMBINED;
  const d = branch([{ tool: 'gitleaks', task: 'g', phase: 'Failed', exit: 1, lines: ['WRN leaks found: 3'] }, { tool: 'pip-audit', task: 'p', phase: 'Failed', exit: 1, lines: ["Failed to upgrade `pip`"] }]);
  const rows = await writeReports(d, undefined, undefined, { failure: `1 case(s) failed:${String.fromCharCode(10)}[X/15] locator.click: Timeout 20000ms exceeded.` });
  assert.deepEqual(rows.map((r) => r.file).sort(), ['Triggered/RCA_gitleaks.pdf', 'Triggered/RCA_pip-audit.pdf']);
  assert.deepEqual(fs.readdirSync(path.join(d, 'RCA Report')).sort(), ['Script_failure.pdf', 'Triggered', 'index.json']); // no combined PDF
  const html = reportHtml(reportFromRules(buildFactPack(d, 'pip-audit')), buildFactPack(d, 'pip-audit')); for (const t of ['S3 result', 'EKS logs', 'Platform code']) assert.match(html, new RegExp(t));
  process.env.RCA_COMBINED = 'on'; try { await writeReports(d); assert.ok(fs.readdirSync(path.join(d, 'RCA Report')).some((f) => /^RCA_Report_.*\.pdf$/.test(f))); } finally { delete process.env.RCA_COMBINED; }
});
