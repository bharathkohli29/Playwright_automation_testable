import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bugRule, pyVersion } from '../utils/pyValidate';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';

// the folders that existed in run 2 of PY_V312_UV_PIP_MONO (4 Nov 2026)
const RUN2 = ['radon', 'jscpd-py', 'git-churn', 'semgrep', 'semgrep-perf-static', 'presidio', 'semgrep-pii', 'gitleaks', 'pip-audit', 'py-all-defs-uses', 'py-coverage-delta', 'pylint', 'bandit', 'python-perf-dependency', 'crosshair'];
const v312 = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'PY_V312_')); const bd = path.join(d, 'PY_V312_X'); fs.mkdirSync(bd); return pyVersion(bd)!; };

test('primary and secondary both missing → bug for the primary', () => {
  const r = bugRule(v312(), RUN2);
  for (const t of ['coverage-py', 'complexipy', 'cosmic-ray', 'pymcdc']) assert.ok(r.needed.has(t), t);
});
test('secondary-only tools whose primary ran are not bugs', () => {
  const r = bugRule(v312(), RUN2);
  assert.ok(!r.needed.has('flake8')); assert.ok(!r.needed.has('safety'));
  assert.ok(r.mapped.has('flake8') && r.mapped.has('safety'));
});
test('pydriller: covered by git_churn for Code Churn, but still a bug for Reporting Validation', () => {
  const r = bugRule(v312(), RUN2);
  assert.match(r.needed.get('pydriller')!, /Reporting Validation/);
  assert.doesNotMatch(r.needed.get('pydriller')!, /Code Churn/);
});
test('combined primary (radon + lizard): both must trigger, so a missing lizard is a bug', () => {
  const r = bugRule(v312(), RUN2);
  assert.match(r.needed.get('lizard')!, /Maintainability|Cyclomatic/);
  assert.ok(!r.needed.has('radon'));
});
test('a secondary that ran covers a missing primary', () => {
  const r = bugRule(v312(), [...RUN2, 'cognitive-ast']);
  assert.ok(!r.needed.has('complexipy'));
});
test('retired tool (testmon) is never a bug; unmapped tools are not judged by this rule', () => {
  const r = bugRule(v312(), RUN2);
  assert.ok(!r.needed.has('testmon'));
  assert.ok(!r.mapped.has('detect-secrets') && !r.mapped.has('pip-outdated'));
});
