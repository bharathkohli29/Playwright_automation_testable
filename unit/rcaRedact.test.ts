import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../utils/rcaRedact';

const text = [
  "PermissionError: [Errno 13] Permission denied: '/workspaces/cell-001/f6d7cc32-ef7c-4663-b6ec-87626fd4c93c/e407d010-a610-4680-b829-a1f5d15cadbb/runs/42dcd9af-b90a-4885-9b4c-aa4001ce10f2/source/Tool Triggering (Synthetic Data)/pydriller/run.py'",
  'pod wb-exec-3806bf0248f93ff6864ac5147e7e904c-nbv2n on ip-172-31-6-110.us-east-2.compute.internal at 10.1.2.3',
  'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 key AKIAABCDEFGHIJKLMNOP and Bearer abcdefghijklmnop1234',
  'mail bob@corp.com see https://github.com/acme/secret-repo/tree/PY_V312_SECRET',
  'commit c5427b9d5602fc62ffe06c52bcb391903106a8d0 on branch PY_V312_SECRET of acme/secret-repo; run 42dcd9af-b90a-4885-9b4c-aa4001ce10f2 again',
].join('\n');

test('every identifying detail is removed, and the story stays readable', () => {
  const r = redact(text, [{ label: 'branch', value: 'PY_V312_SECRET' }, { label: 'repo', value: 'acme/secret-repo' }]);
  for (const leak of ['f6d7cc32', 'e407d010', '42dcd9af', 'Synthetic Data', 'pydriller/run.py', '3806bf0248', 'ip-172', '10.1.2.3', 'ghp_', 'AKIA', 'abcdefghijklmnop1234', 'bob@corp.com', 'github.com/acme', 'PY_V312_SECRET', 'acme/secret-repo', 'c5427b9d'])
    assert.ok(!r.text.includes(leak), `still contains ${leak}`);
  assert.match(r.text, /Permission denied/); assert.match(r.text, /\/workspaces\/cell-001\/<ID-1>/); assert.match(r.text, /\/source\/<REPO_PATH>/); assert.match(r.text, /wb-exec-<POD-1>/);
});

test('the same value always gets the same tag; the map is only for reading answers back on this PC', () => {
  const r = redact(text); const first = '42dcd9af-b90a-4885-9b4c-aa4001ce10f2';
  const tagOfRun = Object.entries(r.map).find(([, v]) => v === first)![0]; assert.equal(r.text.split(tagOfRun).length - 1, 2); // the run id in the path (line 1) and in the last line: ONE tag for both
  assert.equal(Object.values(r.map).filter((v) => v === first).length, 1);
  assert.equal(r.map['<EMAIL-1>'], 'bob@corp.com');
});

test('a text with nothing to hide stays as it is', () => { const r = redact('Failed to upgrade `pip`: exit code 1'); assert.equal(r.text, 'Failed to upgrade `pip`: exit code 1'); assert.deepEqual(r.map, {}); });
