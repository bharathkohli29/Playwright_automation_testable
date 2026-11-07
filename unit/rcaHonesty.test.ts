process.env.RCA_CODE = 'off';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseOf, kindOf } from '../utils/rcaHonesty';
import { buildFactPack } from '../utils/rcaFacts';
import { makeBranch } from './fixtures';

test('caseOf: a red tool becomes a training case with the real prompt and the rule answer; a healthy tool gives none', () => {
  const d = makeBranch();
  assert.equal(caseOf(buildFactPack(d, 'radon'), 'r'), null); // healthy: the model never words it
  const c = caseOf(buildFactPack(d, 'pip-audit'), 'r')!; assert.ok(c); assert.equal(c.kind, 'known-cause'); assert.equal(c.id, 'honesty-r-pip-audit');
  assert.match(c.user, /TOOL: pip-audit/); assert.match(c.user, /Write the report for pip-audit now/);
  for (const k of ['oneLine', 'whatHappened', 'why', 'impact', 'fix']) assert.ok(c.answer[k], k);
  assert.ok((c.answer.whatHappened as string[]).length <= 4);
});

test('the answer never claims anything the facts do not say: no "normal", "usually" and the like', () => {
  const d = makeBranch(); const c = caseOf(buildFactPack(d, 'cosmic-ray'), 'r')!; const text = JSON.stringify(c.answer);
  assert.doesNotMatch(text, /\b(normal|normally|usually|typically|probably|commonly|generally|harmless)\b/i);
});

test('kindOf separates the kinds the set is balanced on', () => {
  const d = makeBranch(); assert.equal(kindOf(buildFactPack(d, 'pip-audit')), 'known-cause');
});
