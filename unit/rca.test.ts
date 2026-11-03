import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildFactPack, defectiveTools } from '../utils/rcaFacts';
import { reportFromRules, renderMarkdown, writeReports } from '../utils/rcaReport';

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

test('one file per defective tool plus index.json; the file holds the 7 parts', async () => {
  const d = branch([{ tool: 'gitleaks', task: 'g', phase: 'Failed', exit: 1, lines: ['WRN leaks found: 3'] }, { tool: 'pip-audit', task: 'p', phase: 'Failed', exit: 1, lines: ["Failed to upgrade `pip`"] }]);
  const rows = await writeReports(d);
  assert.deepEqual(rows.map((r) => r.file).sort(), ['RCA_gitleaks.md', 'RCA_pip-audit.md']);
  const md = fs.readFileSync(path.join(d, 'RCA Report', 'RCA_pip-audit.md'), 'utf8');
  for (const h of ['In one sentence', 'What happened', 'Why', 'Evidence', 'Impact', 'Who fixes it', 'What to do', 'Confidence']) assert.match(md, new RegExp(`## ${h}`));
  assert.ok(fs.existsSync(path.join(d, 'RCA Report', 'index.json')));
  assert.doesNotMatch(renderMarkdown(reportFromRules(buildFactPack(d, 'gitleaks')), buildFactPack(d, 'gitleaks')), /pip-audit/); // no other tool leaks into this report
});
