process.env.RCA_CODE_FETCH = 'off'; process.env.RCA_CODE_BRANCH = ''; // hermetic: temp repos, no network, no branch
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { codesOf, lookupCode, codeEvidence, resolveRef, gitAuthEnv, scrub, gitEnv } from '../utils/rcaCode';
import { buildFactPack } from '../utils/rcaFacts';
import { makeBranch } from './fixtures';

function repo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'code-')); const g = (...a: string[]) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  g('init', '-q'); fs.mkdirSync(path.join(d, 'svc')); fs.mkdirSync(path.join(d, 'tests'));
  fs.writeFileSync(path.join(d, 'svc', 'plan.py'), ['def plan(x):', '    # key = AKIAABCDEFGHIJKLMNOP', '    if x.wave is None:', '        raise PlanError("WAVE_IDENTITY_MISMATCH")', '    return x', ''].join('\n'));
  fs.writeFileSync(path.join(d, 'tests', 'test_plan.py'), 'assert "WAVE_IDENTITY_MISMATCH"\n');
  g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'); return d;
}

test('lookupCode finds where a code is raised, skips tests, removes secrets, and never writes to the checkout', () => {
  const d = repo(); const before = spawnSync('git', ['-C', d, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;
  const r = lookupCode(d, 'WAVE_IDENTITY_MISMATCH'); assert.equal(r.length, 1); assert.equal(r[0].file, 'svc/plan.py'); assert.equal(r[0].line, 4);
  assert.match(r[0].snippet, /raise PlanError/); assert.doesNotMatch(r[0].snippet, /AKIAABCDEFGHIJKLMNOP/);
  assert.equal(spawnSync('git', ['-C', d, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, before);
});

test('codeEvidence is off without RCA_CODE_DIR, and audits (without the code itself) when on', () => {
  const b = makeBranch(); const p = buildFactPack(b, 'cosmic-ray'); const old = process.env.RCA_CODE_DIR; const oldA = process.env.RCA_CODE_AUDIT;
  try {
    delete process.env.RCA_CODE_DIR; assert.deepEqual(codeEvidence(p), []);
    const d = repo(); const audit = path.join(os.tmpdir(), `audit-${Date.now()}.jsonl`); process.env.RCA_CODE_DIR = d; process.env.RCA_CODE_AUDIT = audit;
    const fake = { ...p, observed: 'FAILED', failureJson: ['failure.json: reason WAVE_IDENTITY_MISMATCH'], serviceLines: [], decisive: null } as typeof p;
    assert.deepEqual(codesOf(fake), ['WAVE_IDENTITY_MISMATCH']);
    const refs = codeEvidence(fake); assert.equal(refs.length, 1);
    const log = fs.readFileSync(audit, 'utf8'); assert.match(log, /svc\/plan\.py:4/); assert.doesNotMatch(log, /raise PlanError/);
  } finally { if (old === undefined) delete process.env.RCA_CODE_DIR; else process.env.RCA_CODE_DIR = old; if (oldA === undefined) delete process.env.RCA_CODE_AUDIT; else process.env.RCA_CODE_AUDIT = oldA; }
});

test('RCA_CODE_REF / RCA_CODE_BRANCH read a chosen version of the platform code (a new build does not change what an old run is explained with), without touching the working tree', () => {
  const d = repo(); const g = (...a: string[]) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  const first = g('rev-parse', 'HEAD').stdout.trim();
  fs.writeFileSync(path.join(d, 'svc', 'plan.py'), ['# a new build moved things', 'def plan(x):', '    raise PlanError("WAVE_IDENTITY_MISMATCH")', ''].join('\n'));
  g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'new build');
  const old = lookupCode(d, 'WAVE_IDENTITY_MISMATCH', first); assert.equal(old[0].line, 4); // the old build: line 4
  const now = lookupCode(d, 'WAVE_IDENTITY_MISMATCH', 'HEAD'); assert.equal(now[0].line, 3); assert.match(now[0].snippet, /new build moved things/); // the new build: line 3
  const keep = process.env.RCA_CODE_REF; try { process.env.RCA_CODE_REF = first; const r = resolveRef(d); assert.equal(r.ref, first); assert.match(r.label, new RegExp(first.slice(0, 7))); } finally { if (keep === undefined) delete process.env.RCA_CODE_REF; else process.env.RCA_CODE_REF = keep; }
  assert.equal(g('status', '--porcelain').stdout, '');
});

test('RCA_CODE_TOKEN: git gets it through environment variables only, and it never appears in a printed message', () => {
  const keep = process.env.RCA_CODE_TOKEN;
  try {
    delete process.env.RCA_CODE_TOKEN; assert.deepEqual(gitAuthEnv(), {});
    process.env.RCA_CODE_TOKEN = 'ghp_SECRETSECRETSECRET1234567890'; const e = gitAuthEnv();
    assert.equal(e.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader'); assert.match(e.GIT_CONFIG_VALUE_0, /^AUTHORIZATION: basic /);
    assert.equal(Buffer.from(e.GIT_CONFIG_VALUE_0.replace('AUTHORIZATION: basic ', ''), 'base64').toString(), 'x-access-token:ghp_SECRETSECRETSECRET1234567890');
    const msg = scrub(`fatal: could not read https://x-access-token:ghp_SECRETSECRETSECRET1234567890@github.com ${e.GIT_CONFIG_VALUE_0.split(' ')[2]}`); assert.doesNotMatch(msg, /SECRETSECRET/); assert.match(msg, /<token>/);
  } finally { if (keep === undefined) delete process.env.RCA_CODE_TOKEN; else process.env.RCA_CODE_TOKEN = keep; }
});

test('gitEnv removes the tokens of other features, so git uses RCA_CODE_TOKEN or the person\'s own sign-in only', () => {
  const keep = { gh: process.env.GH_TOKEN, gt: process.env.GITHUB_TOKEN };
  try { process.env.GH_TOKEN = 'ghp_other_feature'; process.env.GITHUB_TOKEN = 'ghp_other_feature2'; const e = gitEnv(); assert.equal(e.GH_TOKEN, undefined); assert.equal(e.GITHUB_TOKEN, undefined); assert.equal(e.GIT_TERMINAL_PROMPT, '0'); }
  finally { if (keep.gh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = keep.gh; if (keep.gt === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = keep.gt; }
});
