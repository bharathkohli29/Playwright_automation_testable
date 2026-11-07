process.env.RCA_CODE = 'off';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipInCidrs, requestText } from '../utils/eksIpNotice';

test('ipInCidrs: single addresses, blocks, the open block and bad input', () => {
  assert.equal(ipInCidrs('203.0.113.7', ['203.0.113.7/32']), true);
  assert.equal(ipInCidrs('203.0.113.8', ['203.0.113.7/32']), false);
  assert.equal(ipInCidrs('203.0.113.8', ['203.0.113.0/24', '10.0.0.0/8']), true);
  assert.equal(ipInCidrs('198.51.100.9', ['203.0.113.0/24']), false);
  assert.equal(ipInCidrs('198.51.100.9', ['0.0.0.0/0']), true);
  assert.equal(ipInCidrs('203.0.113.7', ['203.0.113.7']), true); // a block without a slash is one address
  assert.equal(ipInCidrs('not-an-ip', ['0.0.0.0/0']), false); assert.equal(ipInCidrs('203.0.113.7', []), false); assert.equal(ipInCidrs('203.0.113.7', ['garbage/99']), false);
});

test('the request text names the IP as a /32, the cluster and the purpose', () => {
  const t = requestText({ ip: '203.0.113.7', cidrs: [], allowed: false, note: '' });
  assert.match(t, /203\.0\.113\.7\/32/); assert.match(t, /allow-list/); assert.match(t, /QA EKS cluster/);
});
