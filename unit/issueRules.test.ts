process.env.RCA_CODE = 'off';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchIssueRule, applyRule, ISSUE_RULES } from '../utils/issueRules';
import { groundConclusion } from '../utils/rcaAgent';

test('a known problem is matched by its text, and every rule says where it was read and gives a fix, a workaround and a check', () => {
  const r = matchIssueRule('The selected branch is not on this run plan yet. The script reached step 8.'); assert.equal(r?.id, 'branch-not-on-run-plan'); assert.equal(matchIssueRule('something else entirely'), null);
  for (const x of ISSUE_RULES) { assert.ok(x.source.length > 20 && x.mechanism && x.fix && x.workaround && x.verify && x.next); assert.ok(x.candidates.length >= 2 && x.candidates.every((c) => c.cause && c.confirm)); }
});

test('applyRule keeps what the model established and fills what it could not', () => {
  const rule = matchIssueRule('The selected branch is not on this run plan yet')!;
  const none = applyRule(null, rule); assert.match(none.cause, /^Not established/); assert.equal(none.proof, 'Unknown'); assert.equal(none.candidates?.length, 3); assert.match(none.fix || '', /page through it/); assert.match(none.rule || '', /branch-not-on-run-plan/);
  const weak = applyRule({ cause: 'Not established', proof: 'Unknown', evidence: '', owner: '', next: '' }, rule); assert.match(weak.cause, /^Not established without the cluster/);
  const good = applyRule({ cause: 'The mirror sync had not added the branch (seen in the log).', proof: 'Proven', evidence: 'a.py:1', owner: 'Platform', next: 'x' }, rule);
  assert.match(good.cause, /^The mirror sync had not added the branch/); assert.equal(good.proof, 'Proven'); assert.equal(good.owner, 'Platform'); assert.match(good.fix || '', /Platform: read the catalog/);
});

test('the "check first" text and each candidate\'s confirm text are grounded: an invented endpoint or query is dropped', () => {
  const facts = 'ISSUE (as reported): the branch is missing'; const obs = 'listBranches(repositoryId, limit 200) in whitebox-confidence-trigger.ts:306';
  const g = groundConclusion(JSON.stringify({ cause: 'The catalog from listBranches had no entry for the branch.', proof: 'Inferred', evidence: '', next: 'Call GET /api/v1/run-plans/{runPlanId}/branches', candidates: [{ cause: 'The catalog was cut at 200 entries', confirm: 'Run SELECT * FROM /srv/db/run_plans.sql' }] }), facts, obs);
  assert.equal(g.c?.next, ''); assert.equal(g.c?.candidates?.[0].confirm, 'the logs of the service that serves it');
});
