process.env.RCA_CODE_FETCH = 'off'; process.env.RCA_CODE_BRANCH = '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { act, runAgent, groundConclusion } from '../utils/rcaAgent';
import { buildFactPack } from '../utils/rcaFacts';
import { trailHtml, setTrail, clearTrails } from '../utils/rcaTrail';
import { makeBranch } from './fixtures';

const NL = String.fromCharCode(10);
function repo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-')); const g = (...a: string[]) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  g('init', '-q'); fs.mkdirSync(path.join(d, 'svc')); fs.mkdirSync(path.join(d, 'backend', 'w', 'analyzers', 'python'), { recursive: true });
  fs.writeFileSync(path.join(d, 'svc', 'plan.py'), ['def plan(x):', '    # key = AKIAABCDEFGHIJKLMNOP', '    if x.wave is None:', '        raise PlanError("WAVE_IDENTITY_MISMATCH")', '    return x', ''].join(NL));
  fs.writeFileSync(path.join(d, 'backend', 'w', 'analyzers', 'python', 'cosmic_ray_runner.py'), ['# Runs cosmic-ray.', 'import json', '', 'def run(x):', '    out = x.stdout', '    if not out:', '        return {"status": "empty"}', '    return json.loads(out)', ''].join(NL));
  g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'); return d;
}

test('act: search, read and runner work read-only; a path with .. or an absolute path is refused; secrets are removed', () => {
  const d = repo(); const before = spawnSync('git', ['-C', d, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;
  assert.match(act(d, null, 'search', 'WAVE_IDENTITY_MISMATCH'), /svc\/plan\.py:4/);
  const r = act(d, null, 'read', 'svc/plan.py:4'); assert.match(r, /raise PlanError/); assert.doesNotMatch(r, /AKIAABCDEFGHIJKLMNOP/);
  assert.equal(act(d, null, 'read', '../secret.txt:1'), 'path refused'); assert.equal(act(d, null, 'read', '/etc/passwd:1'), 'path refused'); assert.equal(act(d, null, 'read', 'C:/x/y.py:1'), 'path refused');
  assert.match(act(d, null, 'runner', 'cosmic-ray'), /cosmic_ray_runner[.]py/); assert.match(act(d, null, 'runner', 'nothing-here'), /no analyzer file/);
  assert.match(act(d, null, 'delete', 'x'), /unknown action/); assert.match(act(d, null, 'search', 'ab'), /at least 4/);
  assert.equal(spawnSync('git', ['-C', d, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, before); // nothing was written
});

/** a fake Ollama that answers the scripted replies in order */
function scripted(replies: string[]): Promise<{ url: string; calls: () => number; close: () => void }> {
  let n = 0; const s = http.createServer((req, res) => { req.resume().on('end', () => { if ((req.url || '').endsWith('/api/ps') || (req.url || '').endsWith('/api/generate')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"models":[]}'); return; } const content = replies[Math.min(n, replies.length - 1)]; n++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: { content } })); }); });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, calls: () => n, close: () => s.close() })));
}
const step = (thought: string, action: string, input: string) => JSON.stringify({ thought, action, input });
const fin = (o: object) => step('I know enough', 'finish', JSON.stringify(o));

test('the loop: Thought, Action, Observation, then a conclusion that is kept because its evidence was seen', async () => {
  const d = repo(); const keep = process.env.RCA_CODE_DIR; process.env.RCA_CODE_DIR = d;
  const f = await scripted([step('Find where the code is raised', 'search', 'WAVE_IDENTITY_MISMATCH'), step('Read the place', 'read', 'svc/plan.py:4'),
    fin({ cause: 'The planner raises WAVE_IDENTITY_MISMATCH when x.wave is None.', proof: 'Proven', evidence: 'svc/plan.py:4', owner: 'Platform', next: 'Check the wave of the tool.' })]);
  try {
    const t = (await runAgent(buildFactPack(makeBranch(), 'cosmic-ray'), { host: f.url, model: 'x' }))!;
    assert.deepEqual(t.steps.map((s) => s.action), ['search', 'read', 'finish']); assert.match(t.steps[0].observation, /svc\/plan\.py:4/); assert.match(t.steps[1].observation, /x[.]wave is None/);
    assert.equal(t.conclusion?.proof, 'Proven'); assert.equal(t.conclusion?.evidence, 'svc/plan.py:4'); assert.equal(f.calls(), 3);
    clearTrails(); setTrail(t); const html = trailHtml('cosmic-ray'); assert.match(html, /Thought → Action → Observation/); assert.match(html, /Find where the code is raised/); assert.match(html, /Proof level of the root cause:<\/b> Proven/);
  } finally { f.close(); if (keep === undefined) delete process.env.RCA_CODE_DIR; else process.env.RCA_CODE_DIR = keep; }
});

test('a conclusion with evidence no step showed is downgraded; "this is normal" or invented names drop the conclusion; bad JSON ends the loop', async () => {
  const facts = 'cosmic-ray stopped at once'; const obs = 'svc/plan.py:4: raise PlanError("WAVE_IDENTITY_MISMATCH")';
  const down = groundConclusion(JSON.stringify({ cause: 'The planner raises WAVE_IDENTITY_MISMATCH.', proof: 'Proven', evidence: 'other/file.py:9' }), facts, obs); assert.equal(down.c?.proof, 'Inferred'); assert.equal(down.c?.evidence, '');
  const normal = groundConclusion(JSON.stringify({ cause: 'This is normal for the planner.', proof: 'Inferred', evidence: 'svc/plan.py:4' }), facts, obs); assert.equal(normal.c, null); assert.match(normal.note, /normal/);
  const invented = groundConclusion(JSON.stringify({ cause: 'See /srv/app/made_up_module.py for the fix.', proof: 'Inferred', evidence: '' }), facts, obs); assert.equal(invented.c, null);
  assert.equal(groundConclusion('not json', facts, obs).c, null);
  const keep = process.env.RCA_CODE_DIR; process.env.RCA_CODE_DIR = repo(); const f = await scripted(['this is not json']);
  try { const t = (await runAgent(buildFactPack(makeBranch(), 'cosmic-ray'), { host: f.url, model: 'x' }))!; assert.equal(t.steps.length, 0); assert.match(t.note, /required JSON/); assert.equal(t.conclusion, null); }
  finally { f.close(); if (keep === undefined) delete process.env.RCA_CODE_DIR; else process.env.RCA_CODE_DIR = keep; }
});

test('the agent refuses an Ollama that is not on this PC', async () => {
  const keep = process.env.RCA_CODE_DIR; process.env.RCA_CODE_DIR = repo();
  try { const t = (await runAgent(buildFactPack(makeBranch(), 'cosmic-ray'), { host: 'http://10.255.255.1:11434', model: 'x' }))!; assert.match(t.note, /blocked/); assert.equal(t.steps.length, 0); }
  finally { if (keep === undefined) delete process.env.RCA_CODE_DIR; else process.env.RCA_CODE_DIR = keep; }
});

test('a finish before any read is sent back once; the loop goes on with a read and then finishes', async () => {
  const d = repo(); const keep = process.env.RCA_CODE_DIR; process.env.RCA_CODE_DIR = d;
  const good = fin({ cause: 'The planner raises WAVE_IDENTITY_MISMATCH when x.wave is None.', proof: 'Proven', evidence: 'svc/plan.py:4', owner: 'Platform', next: 'Check the wave.' });
  const f = await scripted([step('look', 'search', 'WAVE_IDENTITY_MISMATCH'), good, step('read the place', 'read', 'svc/plan.py:4'), good]);
  try {
    const t = (await runAgent(buildFactPack(makeBranch(), 'cosmic-ray'), { host: f.url, model: 'x' }))!;
    assert.deepEqual(t.steps.map((s) => s.action), ['search', 'finish', 'read', 'finish']); assert.match(t.steps[1].observation, /not accepted yet: read the place/);
    assert.equal(t.conclusion?.proof, 'Proven'); assert.equal(f.calls(), 4);
  } finally { f.close(); if (keep === undefined) delete process.env.RCA_CODE_DIR; else process.env.RCA_CODE_DIR = keep; }
});

import { overlap } from '../utils/rcaAgent';
test('a cause that only repeats the problem becomes "not established"; what the code showed stays as the mechanism; candidates are kept when grounded', () => {
  const facts = 'ISSUE (as reported): The selected branch is not on this run plan yet. The button stayed disabled.';
  const obs = 'WhiteboxRunPlanCard.tsx:229 listed.length === 0 listBranches(repositoryId, limit 200) mirror sync';
  assert.ok(overlap('The selected branch is not on this run plan', facts) >= 0.6); assert.ok(overlap('The mirror sync did not add the branch to the catalog', facts) < 0.6);
  const circ = groundConclusion(JSON.stringify({ mechanism: '', cause: 'The selected branch is not on this run plan, so the button stays disabled.', proof: 'Proven', evidence: 'WhiteboxRunPlanCard.tsx:229' }), facts, obs);
  assert.match(circ.c?.cause || '', /^Not established/); assert.equal(circ.c?.proof, 'Unknown'); assert.match(circ.c?.mechanism || '', /selected branch is not on this run plan/);
  const real = groundConclusion(JSON.stringify({ mechanism: 'The card shows the message when listed.length === 0.', cause: 'The catalog from listBranches had no entry for the branch (the mirror sync had not added it).', proof: 'Inferred', evidence: 'WhiteboxRunPlanCard.tsx:229', candidates: [{ cause: 'The repository has more than 200 branches', confirm: 'count the branches of the repository in the catalog' }, { cause: 'See /srv/app/fake_module.py', confirm: 'x' }] }), facts, obs);
  assert.match(real.c?.cause || '', /^The catalog from listBranches/); assert.equal(real.c?.proof, 'Inferred'); assert.match(real.c?.mechanism || '', /listed.length === 0/);
  assert.equal(real.c?.candidates?.length, 1); assert.match(real.c?.candidates?.[0].cause || '', /more than 200 branches/); // the candidate with an invented path was dropped
  const notEst = groundConclusion(JSON.stringify({ cause: 'Not established', proof: 'Proven', evidence: '' }), facts, obs); assert.equal(notEst.c?.proof, 'Unknown');
});

import { leadsOf } from '../utils/rcaAgent';
test('leadsOf names the functions and call results worth following next, and skips the ones already followed', () => {
  const obs = ['137: const listed = listPlanBranchesForRunPlan(plan, preferredBranchNames)', '138: const branchKey = `${listed.map((b) => b.name).join(",")}`', '227: {listed.length === 0 ? ('].join(String.fromCharCode(10));
  assert.deepEqual(leadsOf(obs), ['listPlanBranchesForRunPlan', 'listed']);
  assert.deepEqual(leadsOf(obs, new Set(['listed'])), ['listPlanBranchesForRunPlan']);
  assert.deepEqual(leadsOf('return x.map((a) => a)'), []);
});

import { followLead } from '../utils/rcaAgent';
test('followLead finds where a called function is defined and reads it', () => {
  const d = repo(); const NL2 = String.fromCharCode(10); fs.mkdirSync(path.join(d, 'web'), { recursive: true });
  fs.writeFileSync(path.join(d, 'web', 'flow.ts'), ['// helpers', 'export function pickBranches(plan: Plan, wanted: string[]) {', '  const hit = plan.ordered.filter((b) => wanted.includes(b.name));', '  if (hit.length > 0) return hit;', '  return [];', '}', ''].join(NL2));
  spawnSync('git', ['-C', d, 'add', '-A'], { encoding: 'utf8' }); spawnSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'flow'], { encoding: 'utf8' });
  const r = followLead(d, null, 'pickBranches'); assert.match(r, /^web\/flow[.]ts:2/); assert.match(r, /plan[.]ordered[.]filter/); assert.equal(followLead(d, null, 'doesNotExist'), '');
});

test('leadsOf skips plain method names such as has, get and map', () => {
  assert.deepEqual(leadsOf('const ok = selected.has(name) && cache.get(key)'), []);
  assert.deepEqual(leadsOf('const r = await fetchBranchCatalog(repoId)'), ['fetchBranchCatalog', 'r'].filter((x) => x.length >= 4));
});

test('the fix is kept when it names only what the steps showed, and dropped when it names something no step showed', () => {
  const facts = 'ISSUE (as reported): the branch is missing'; const obs = 'listBranches(repositoryId, limit 200) in whitebox-confidence-trigger.ts:306';
  const ok = groundConclusion(JSON.stringify({ cause: 'The catalog from listBranches had no entry for the branch.', proof: 'Inferred', evidence: 'whitebox-confidence-trigger.ts:306', fix: 'Raise the limit of listBranches above 200 or page through the catalog.', workaround: 'Wait for the mirror sync and open the plan again.', verify: 'The branch appears on the plan.' }), facts, obs);
  assert.match(ok.c?.fix || '', /limit of listBranches/); assert.match(ok.c?.workaround || '', /mirror sync/); assert.match(ok.c?.verify || '', /appears on the plan/);
  const bad = groundConclusion(JSON.stringify({ cause: 'The catalog from listBranches had no entry.', proof: 'Inferred', evidence: '', fix: 'Change /srv/app/invented_file.py to return all branches.' }), facts, obs); assert.equal(bad.c?.fix, undefined);
});
