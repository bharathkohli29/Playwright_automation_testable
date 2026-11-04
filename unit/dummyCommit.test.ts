import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ownerAndName, classifyGitError, dummyMode, dummyPrEnabled, recordDummyOutcome, tokenFor, ghDummyCommit, ghRepoAccess, ghTokenCanWrite, type DummyResult, type GhRun } from '../utils/dummyCommit';

test('ownerAndName reads owner/name from every form used in builds.json', () => {
  assert.equal(ownerAndName('Nandhini-Testable/Python_Corpus_Tool_Triggering'), 'Nandhini-Testable/Python_Corpus_Tool_Triggering');
  assert.equal(ownerAndName('https://github.com/Nandhini-Testable/Java_Corpus_Tool_Triggering/tree/JV_V21_MAVEN_THINJAR_MONO'), 'Nandhini-Testable/Java_Corpus_Tool_Triggering');
  assert.equal(ownerAndName('https://github.com/testable-platform/CSharp_Corpus_Tool_Triggering.git'), 'testable-platform/CSharp_Corpus_Tool_Triggering');
  assert.equal(ownerAndName('JustAName'), null);
});

test('classifyGitError tells access problems, a moving branch, a missing branch and network problems apart', () => {
  assert.equal(classifyGitError('remote: Permission to a/b.git denied to user. fatal: unable to access ...: The requested URL returned error: 403'), 'no-access');
  assert.equal(classifyGitError('fatal: Authentication failed for https://github.com/a/b.git'), 'no-access');
  assert.equal(classifyGitError('! [rejected] HEAD -> main (fetch first)'), 'rejected');
  assert.equal(classifyGitError('error: failed to push some refs ... non-fast-forward'), 'rejected');
  assert.equal(classifyGitError('fatal: Remote branch X not found in upstream origin'), 'branch-missing');
  assert.equal(classifyGitError('fatal: unable to access ...: Could not resolve host: github.com'), 'network');
  assert.equal(classifyGitError('something else'), 'other');
});

test('DUMMY_MODE and DUMMY_PR settings', () => {
  const keep = { mode: process.env.DUMMY_MODE, pr: process.env.DUMMY_PR };
  try {
    delete process.env.DUMMY_MODE; assert.equal(dummyMode(), 'readme');
    process.env.DUMMY_MODE = 'Empty'; assert.equal(dummyMode(), 'empty');
    process.env.DUMMY_PR = 'yes'; assert.equal(dummyPrEnabled(), true);
    process.env.DUMMY_PR = 'no'; assert.equal(dummyPrEnabled(), false);
  } finally {
    if (keep.mode === undefined) delete process.env.DUMMY_MODE; else process.env.DUMMY_MODE = keep.mode;
    if (keep.pr === undefined) delete process.env.DUMMY_PR; else process.env.DUMMY_PR = keep.pr;
  }
});

test('recordDummyOutcome writes dummy-commit.json and says whether the platform analysed our commit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dummy-'));
  const base: DummyResult = { sha: 'abcdef1234567890', mode: 'readme', repo: 'o/r', branch: 'b', attempts: 1, at: 'x' };
  recordDummyOutcome(dir, { ...base }, 'abcdef1234567890');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'dummy-commit.json'), 'utf8')).matched, true);
  recordDummyOutcome(dir, { ...base }, '1111111111111111');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'dummy-commit.json'), 'utf8')).matched, false);
  recordDummyOutcome(dir, undefined, 'x'); // no dummy commit: nothing happens
});

/** a tiny fake of the parts of GitHub's API the GitHub CLI mode uses */
function fakeGh(opts: { push?: string; raceOnce?: boolean; noBranch?: boolean } = {}) {
  const st: any = { head: 'c0', tree: 't0', readme: { path: 'README.md', sha: 'f0', text: '# hi\n' }, raced: false, n: 0 };
  const ok = (out: string) => ({ status: 0, out, err: '' }); const bad = (err: string) => ({ status: 1, out: '', err });
  const run: GhRun = (args, input) => {
    const a = args.join(' ');
    if (a === 'api repos/o/r --jq .permissions.push') return ok(opts.push ?? 'true');
    if (a.startsWith('api repos/o/r/git/ref/heads/')) return opts.noBranch ? bad('gh: Not Found (HTTP 404)') : ok(st.head);
    if (a.startsWith('api repos/o/r/readme')) return ok(JSON.stringify({ path: st.readme.path, sha: st.readme.sha, content: Buffer.from(st.readme.text).toString('base64') }));
    if (a.startsWith('api -X PUT repos/o/r/contents/')) {
      if (opts.raceOnce && !st.raced) { st.raced = true; st.readme.sha = 'f-other'; return bad('gh: README.md does not match f0 (HTTP 409)'); }
      const b = JSON.parse(input || '{}'); if (b.sha !== st.readme.sha) return bad('gh: does not match (HTTP 409)');
      st.readme.text = Buffer.from(b.content, 'base64').toString(); st.readme.sha = `f${++st.n}`; st.head = `c${++st.n}`;
      return ok(JSON.stringify({ commit: { sha: st.head } }));
    }
    if (a.startsWith('api repos/o/r/git/commits/') && a.endsWith('--jq .tree.sha')) return ok(st.tree);
    if (a.startsWith('api -X POST repos/o/r/git/commits')) { const b = JSON.parse(input || '{}'); if (b.parents[0] !== st.head || b.tree !== st.tree) return bad('HTTP 422'); st.made = `n${++st.n}`; return ok(JSON.stringify({ sha: st.made })); }
    if (a.startsWith('api -X PATCH repos/o/r/git/refs/heads/')) { const b = JSON.parse(input || '{}'); if (b.force) return bad('force is not allowed'); st.head = b.sha; return ok('{}'); }
    return bad(`unexpected call: ${a}`);
  };
  return { st, run };
}

test('GitHub CLI mode, readme: appends the comment line, new commit, checked on GitHub', () => {
  const g = fakeGh(); const r = ghDummyCommit('o/r', 'main', 'readme', g.run);
  assert.equal(r.sha, g.st.head); assert.equal(r.verified, true); assert.equal(r.attempts, 1);
  assert.match(g.st.readme.text, /^# hi\n<!-- dummy PR \d{4}-\d\d-\d\d \d\d:\d\d:\d\d -->\n$/);
});

test('GitHub CLI mode, empty: a commit on the same files, the branch only moves forward', () => {
  const g = fakeGh(); const r = ghDummyCommit('o/r', 'main', 'empty', g.run);
  assert.equal(r.sha, g.st.made); assert.equal(g.st.head, g.st.made); assert.equal(g.st.readme.text, '# hi\n'); assert.equal(r.verified, true);
});

test('GitHub CLI mode: when the branch moved the commit is tried again', () => {
  const g = fakeGh({ raceOnce: true }); const r = ghDummyCommit('o/r', 'main', 'readme', g.run);
  assert.equal(r.attempts, 2); assert.equal(r.verified, true);
});

test('GitHub CLI mode: no write access and a missing branch are told apart', () => {
  assert.throws(() => ghDummyCommit('o/r', 'main', 'readme', fakeGh({ push: 'false' }).run), (e: Error) => classifyGitError(e.message) === 'no-access');
  assert.throws(() => ghDummyCommit('o/r', 'main', 'readme', fakeGh({ noBranch: true }).run), (e: Error) => classifyGitError(e.message) === 'branch-missing');
});

test('tokenFor: the owner\'s token first, then GH_TOKEN, then GITHUB_TOKEN', () => {
  const env = { GH_TOKEN_NANDHINI_TESTABLE: 'a', GH_TOKEN: 'b', GITHUB_TOKEN: 'c' } as NodeJS.ProcessEnv;
  assert.equal(tokenFor('Nandhini-Testable', env), 'a'); assert.equal(tokenFor('testable-platform', env), 'b');
  assert.equal(tokenFor('x', { GITHUB_TOKEN: ' "c" ' } as NodeJS.ProcessEnv), 'c'); assert.equal(tokenFor('x', {} as NodeJS.ProcessEnv), '');
});

test('ghRepoAccess reads write access and the token expiry from the response headers', () => {
  const run: GhRun = () => ({ status: 0, err: '', out: 'HTTP/2.0 200 OK\nGithub-Authentication-Token-Expiration: 2026-12-01 10:00:00 UTC\n\n{"permissions":{"admin":false,"push":true,"pull":true}}' });
  assert.deepEqual(ghRepoAccess('o/r', run), { push: true, expires: '2026-12-01 10:00:00 UTC' });
  assert.equal(ghRepoAccess('o/r', () => ({ status: 1, out: '', err: 'gh: Not Found (HTTP 404)' })).push, false);
});

test('ghTokenCanWrite tells a token that can write from one that gets HTTP 403', () => {
  assert.equal(ghTokenCanWrite('o/r', () => ({ status: 0, out: '{"sha":"x"}', err: '' })).ok, true);
  const r = ghTokenCanWrite('o/r', () => ({ status: 1, out: '', err: 'gh: Resource not accessible by personal access token (HTTP 403)' }));
  assert.equal(r.ok, false); assert.equal(classifyGitError(r.error || ''), 'no-access');
});
