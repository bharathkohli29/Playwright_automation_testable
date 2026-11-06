import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertEnv, verifyToken } from '../utils/codeLogin';

test('upsertEnv replaces a commented or existing line, appends otherwise, keeps every other line and the line endings', () => {
  assert.equal(upsertEnv('A=1\n# RCA_CODE_TOKEN=\nB=2\n', 'RCA_CODE_TOKEN', 'x'), 'A=1\nRCA_CODE_TOKEN=x\nB=2\n');
  assert.equal(upsertEnv('A=1\nRCA_CODE_TOKEN=old\n', 'RCA_CODE_TOKEN', 'new'), 'A=1\nRCA_CODE_TOKEN=new\n');
  assert.equal(upsertEnv('A=1\n', 'RCA_CODE_TOKEN', 'x'), 'A=1\nRCA_CODE_TOKEN=x\n');
  assert.equal(upsertEnv('A=1\r\nB=2\r\n', 'RCA_CODE_TOKEN', 'x'), 'A=1\r\nB=2\r\nRCA_CODE_TOKEN=x\r\n');
  assert.equal(upsertEnv('', 'K', 'v'), `K=v${String.fromCharCode(10)}`);
});

test('verifyToken refuses a token the remote does not accept, and never shows the token', () => {
  const r = verifyToken('ghp_NOTAREALTOKEN1234567890', 'https://127.0.0.1:9/none.git', 'qa');
  assert.equal(r.ok, false); assert.doesNotMatch(String(r.why), /NOTAREALTOKEN/);
});
