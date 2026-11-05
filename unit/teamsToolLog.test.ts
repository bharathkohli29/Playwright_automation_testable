import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { validatePython } from '../utils/pyValidate';
import { toolSummary } from '../utils/teams';

// the folders of run c9267948 (5 Nov): the tools that triggered
const FOLDERS = ['bandit', 'crosshair', 'git-churn', 'gitleaks', 'jscpd-py', 'pip-audit', 'presidio', 'py-all-defs-uses', 'py-coverage-delta', 'pylint', 'python-perf-dependency', 'radon', 'semgrep-perf-static', 'semgrep-pii', 'semgrep'];
function build() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-')); const bd = path.join(root, 'PY_V312_UV_PIP_MONO'); fs.mkdirSync(bd);
  const inv: Record<string, string[]> = {}; for (const f of FOLDERS) inv[f + '/'] = [];
  const py = validatePython(bd, [], inv)!;
  fs.writeFileSync(path.join(bd, 's3-check.json'), JSON.stringify({ branch: 'PY_V312_UV_PIP_MONO', python: py }));
  return { bd, py };
}
const text = (els: unknown[]) => JSON.stringify(els);

test('every tool appears once in the Tool Trigger Log (no duplicates)', () => {
  const { py } = build(); const names = (py.tools || []).map((r) => r.tool);
  assert.equal(names.length, new Set(names).size, 'a tool is listed twice');
  assert.equal(names.length, py.expected);
});
test('missing tools carry their type and the primary/secondary verdict', () => {
  const { py } = build(); const row = (t: string) => py.tools!.find((r) => r.tool === t)!;
  assert.equal(row('flake8').verdict, 'covered'); assert.equal(row('flake8').kind, 'Secondary'); assert.match(row('flake8').why!, /pylint triggered/);
  assert.equal(row('coverage-py').verdict, 'bug'); assert.match(row('coverage-py').kind!, /^Primary/); assert.equal(row('pymcdc').kind, 'Primary');
  assert.equal(row('detect-secrets').verdict, 'unmapped');
  assert.equal(row('pylint').verdict, 'ok');
});
test('the Teams card shows type, Bug? column, the totals line and the no-bug list; the bug list is unchanged by the display', () => {
  const { bd, py } = build(); const t = text(toolSummary(bd, 90, false));
  assert.match(t, /"Type"/); assert.match(t, /"Bug\?"/);
  assert.match(t, /Of the \d+ not triggered/);
  assert.match(t, /Not triggered, no bug: flake8/);
  assert.match(t, /coverage-py \(Primary[^)]*primary for/);
  assert.equal(py.defects.filter((d) => d.observed === 'NOT_APPLICABLE').map((d) => d.tool).includes('flake8'), false);
});
