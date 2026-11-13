import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bugRule, pyVersion } from '../utils/pyValidate';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';

// the folders that existed in run 2 of PY_V312_UV_PIP_MONO (4 Nov 2026)
const RUN2 = ['radon', 'jscpd-py', 'git-churn', 'semgrep', 'semgrep-perf-static', 'presidio', 'semgrep-pii', 'gitleaks', 'pip-audit', 'py-all-defs-uses', 'py-coverage-delta', 'pylint', 'bandit', 'python-perf-dependency', 'crosshair'];
const ver = (label: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `PY_V${label}_`)); const bd = path.join(d, `PY_V${label}_X`); fs.mkdirSync(bd); return pyVersion(bd)!; };
const v312 = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'PY_V312_')); const bd = path.join(d, 'PY_V312_X'); fs.mkdirSync(bd); return pyVersion(bd)!; };

// Python mapping of 12 Nov 2026 (platform tool bindings): PRIMARY-role tools = primary of a row, SECONDARY-role tools = secondary; several primaries = combined
test('primary and secondary both missing → bug for the primary', () => {
  const r = bugRule(v312(), RUN2);
  for (const t of ['coverage-py', 'complexipy', 'cosmic-ray', 'pymcdc']) assert.ok(r.needed.has(t), t);
});
test('secondary-only tools whose primary ran are not bugs (flake8, safety, lizard, vulture)', () => {
  const r = bugRule(v312(), RUN2);
  for (const t of ['flake8', 'safety', 'lizard', 'vulture']) { assert.ok(!r.needed.has(t), t); assert.ok(r.mapped.has(t), t); }
});
test('pydriller has a row of its own (Change Impact Analysis): git-churn does not cover it', () => {
  const r = bugRule(v312(), RUN2);
  assert.match(r.needed.get('pydriller')!, /Change Impact Analysis/);
});
test('radon is the primary and lizard its secondary: a missing lizard is no bug while radon ran, a missing radon is no bug while lizard ran', () => {
  const a = bugRule(v312(), RUN2);
  assert.ok(!a.needed.has('lizard') && !a.needed.has('radon'));
  const b = bugRule(v312(), [...RUN2.filter((x) => x !== 'radon'), 'lizard']);
  assert.ok(!b.needed.has('radon') && !b.needed.has('lizard'));
  const c = bugRule(v312(), RUN2.filter((x) => x !== 'radon'));
  assert.match(c.needed.get('radon')!, /Cyclomatic Complexity/); assert.match(c.needed.get('lizard')!, /Cyclomatic Complexity/);
});
test('complexipy has no secondary: missing is a bug (nothing can cover it)', () => {
  const r = bugRule(v312(), [...RUN2.filter((x) => x !== 'complexipy'), 'radon', 'lizard']);
  assert.match(r.needed.get('complexipy')!, /Refactoring Guidance|Cognitive Complexity/);
});
test('SAST: bandit + semgrep are both primary, so a missing one is a bug', () => {
  const r = bugRule(v312(), RUN2.filter((x) => x !== 'bandit'));
  assert.match(r.needed.get('bandit')!, /Static Vulnerabilities/);
});
test('swapped groups: detect-secrets (primary of Pre-Commit Secret Prevention) is a bug when missing; pip-outdated is covered by its secondary pip-audit; gitleaks present', () => {
  const r = bugRule(v312(), RUN2);
  assert.ok(!r.needed.has('pip-outdated'), 'pip-audit (its secondary) triggered');
  assert.match(r.needed.get('detect-secrets')!, /Secret Detection/);
  assert.ok(!r.needed.has('gitleaks'));
});
test('pip-outdated is a bug when both it and pip-audit are missing', () => {
  const r = bugRule(v312(), RUN2.filter((f) => f !== 'pip-audit'));
  assert.match(r.needed.get('pip-outdated')!, /Outdated Dependency Detection/);
});
test('retired tools (testmon) are never a bug', () => {
  const r = bugRule(v312(), RUN2);
  assert.ok(!r.needed.has('testmon'));
});
test('Python 3.13: pylint, bandit and complexipy (3.8-3.12) are N/A, so they never make a bug; coverage-py (3.9-3.13) still does', () => {
  const r = bugRule(ver('313'), []);
  for (const t of ['pylint', 'bandit', 'complexipy', 'python-perf-dependency']) assert.ok(!r.needed.has(t), t);
  assert.ok(r.needed.has('coverage-py'));
});
test('Python 3.8: coverage-py, crosshair, cosmic-ray (3.9+) and pymcdc (3.10+) are N/A; vulture (3.8+) is expected', () => {
  const r = bugRule(ver('38'), []);
  for (const t of ['coverage-py', 'crosshair', 'cosmic-ray', 'pymcdc']) assert.ok(!r.needed.has(t), t);
  assert.ok(r.needed.has('radon') && r.needed.has('pylint'));
});

// Teams card: a row ticks when the tool or its primary/secondary pair ran; when neither ran, both names go in the same cell
test('pairs: the counterpart of each tool (primary <-> secondary of its metric rows) and whether it ran', () => {
  const r = bugRule(v312(), RUN2);
  const lz = r.info('lizard', false); assert.deepEqual(lz.pair, ['radon']); assert.equal(lz.pairRan, true);
  const po = r.info('pip-outdated', false); assert.deepEqual(po.pair, ['pip-audit']); assert.equal(po.pairRan, true);
  const fk = r.info('flake8', false); assert.deepEqual(fk.pair, ['pylint']); assert.equal(fk.pairRan, true);
  const pd = r.info('pydriller', false); assert.deepEqual(pd.pair, ['git-churn']); assert.equal(pd.pairRan, true); // git-churn ran: Code Churn default row pairs them
  const cp = r.info('coverage-py', false); assert.deepEqual(cp.pair, []); assert.equal(cp.pairRan, false);      // combined primaries are not pairs
  const gl = r.info('gitleaks', true); assert.deepEqual(gl.pair, []);
});
