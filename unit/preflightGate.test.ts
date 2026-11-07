process.env.RCA_CODE = 'off';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modeOf, printPreflight } from '../utils/preflight';
import type { Check } from '../utils/preflight';

test('the pre-flight is a GATE by default; PREFLIGHT=warn only reports; PREFLIGHT=off skips it', () => {
  const keep = process.env.PREFLIGHT;
  try {
    delete process.env.PREFLIGHT; assert.equal(modeOf(), 'gate');
    process.env.PREFLIGHT = 'strict'; assert.equal(modeOf(), 'gate');
    process.env.PREFLIGHT = 'warn'; assert.equal(modeOf(), 'warn');
    process.env.PREFLIGHT = 'off'; assert.equal(modeOf(), 'off');
  } finally { if (keep === undefined) delete process.env.PREFLIGHT; else process.env.PREFLIGHT = keep; }
});

test('the verdict names the checks that are not green and says the platform is not opened', () => {
  const lines: string[] = []; const orig = console.log; console.log = (m?: unknown) => { lines.push(String(m ?? '')); };
  const cs: Check[] = [{ name: 'A', level: 'OK', message: 'fine' }, { name: 'AWS S3 keys', level: 'FAIL', message: 'expired' }, { name: 'QA EKS cluster', level: 'WARN', message: 'not reachable' }];
  const keep = process.env.PREFLIGHT;
  try {
    delete process.env.PREFLIGHT; printPreflight(cs); const gate = lines.join('\n');
    assert.match(gate, /NOT READY: 2 check\(s\) are not green \(AWS S3 keys, QA EKS cluster\)/); assert.match(gate, /will NOT open the platform/);
    lines.length = 0; printPreflight([cs[0]]); assert.match(lines.join('\n'), /ALL CHECKS GREEN/);
    lines.length = 0; process.env.PREFLIGHT = 'warn'; printPreflight(cs); assert.match(lines.join('\n'), /PREFLIGHT=warn, the run carries on/);
  } finally { console.log = orig; if (keep === undefined) delete process.env.PREFLIGHT; else process.env.PREFLIGHT = keep; }
});
