import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** DUMMY_PR=yes in .env (or $env:DUMMY_PR="yes") turns the dummy-commit step on. Default: off. */
export const dummyPrEnabled = () => /^(yes|y|true|on|1)$/i.test((process.env.DUMMY_PR || '').trim());

/**
 * DUMMY_MODE: how the new commit is made.
 *   readme (default)  a comment line "<!-- dummy PR <time> -->" at the end of README.md
 *   empty             an empty commit: no file is touched (git commit --allow-empty)
 */
export const dummyMode = (): 'readme' | 'empty' => (/^empty$/i.test((process.env.DUMMY_MODE || '').trim()) ? 'empty' : 'readme');

/**
 * DUMMY_VIA: which tool makes the commit.
 *   gh (default)  the GitHub CLI with the token in .env (GH_TOKEN, or GH_TOKEN_<OWNER> per repo owner). No backup: when it fails, the script says WHY (see diagnoseGh)
 *   git           this PC's git login (clone + push)          auto   the CLI first, git when the CLI fails
 */
export const dummyVia = (): 'auto' | 'gh' | 'git' => { const v = (process.env.DUMMY_VIA || '').trim().toLowerCase(); return v === 'git' || v === 'auto' ? v : 'gh'; };

export interface DummyResult {
  sha: string | null;        // the commit that was pushed (null = nothing pushed, the run goes on with the branch's old commit)
  mode: string;
  via?: 'gh' | 'git';        // which tool made the commit
  repo: string;
  branch: string;
  attempts: number;
  at: string;                // ISO time
  verified?: boolean;        // the branch on GitHub pointed at our commit right after the push
  reason?: string;           // why nothing was pushed
  hint?: string;             // what to do about it
  run_commit?: string;       // filled in later: the commit the platform actually analysed
  matched?: boolean;         // run_commit is our commit
}

const git = (args: string[], cwd?: string, extra: string[] = []) =>
  execFileSync('git', [...extra, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 180_000 }).trim();

/** "owner/name" from "owner/name", "https://github.com/owner/name(.git)" or ".../tree/branch". */
export function ownerAndName(repo: string): string | null {
  const m = /^(?:https?:\/\/github\.com\/)?([^/\s]+\/[^/\s]+?)(?:\.git)?(?:\/.*)?$/i.exec(repo.trim());
  return m ? m[1] : null;
}

/** what a failed git push / clone means, from its message */
export function classifyGitError(msg: string): 'no-access' | 'rejected' | 'branch-missing' | 'network' | 'other' {
  if (/403|HTTP 40[14]|permission (to .* )?denied|denied to|write access|authentication failed|could not read (username|password)|repository not found|invalid credentials|bad credentials|resource not accessible|has no write access/i.test(msg)) return 'no-access';
  if (/non-fast-forward|fetch first|\brejected\b|failed to update ref|stale info|cannot lock ref|tip of your current branch is behind|HTTP (409|422)|does not match|not a fast forward/i.test(msg)) return 'rejected';
  if (/remote branch .* not found|couldn't find remote ref/i.test(msg)) return 'branch-missing';
  if (/could not resolve host|timed out|timeout|connection (reset|refused)|unable to access|network is unreachable/i.test(msg)) return 'network';
  return 'other';
}


// ---------------------------------------------------------------- GitHub CLI mode (token in .env, nothing to sign in)
export interface GhResult { status: number | null; out: string; err: string }
export type GhRun = (args: string[], input?: string) => GhResult;
const clean = (v?: string) => (v || '').trim().replace(/^["']|["']$/g, '');

/** the token for a repo owner: GH_TOKEN_<OWNER> (owner upper-cased, other characters as _), else GH_TOKEN, else GITHUB_TOKEN */
export function tokenFor(owner: string, env: NodeJS.ProcessEnv = process.env): string {
  return clean(env[`GH_TOKEN_${owner.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`]) || clean(env.GH_TOKEN) || clean(env.GITHUB_TOKEN);
}

let ghFound: string | null = null;
/** the gh program: GH_CLI, the PATH, or the folders winget installs it to (a PATH change is not seen by a process that was already running) */
export function findGh(): string | null {
  if (ghFound) return ghFound;
  const pf = process.env.ProgramFiles || 'C:\\Program Files', la = process.env.LOCALAPPDATA || '';
  const cands = [clean(process.env.GH_CLI), 'gh', path.join(pf, 'GitHub CLI', 'gh.exe'), la ? path.join(la, 'Programs', 'GitHub CLI', 'gh.exe') : ''].filter(Boolean);
  for (const c of cands) { try { if (spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true }).status === 0) return (ghFound = c); } catch { /* next */ } }
  return null;
}

/** installs the GitHub CLI with winget when it is missing (Windows, per user); GH_AUTO_INSTALL=off turns it off. Waits until it is done. */
export function installGh(say: (m: string) => void): string | null {
  if (/^(off|no|0|false)$/i.test(clean(process.env.GH_AUTO_INSTALL))) { say('the GitHub CLI is not installed and GH_AUTO_INSTALL=off'); return null; }
  if (process.platform !== 'win32') { say('the GitHub CLI (gh) is not installed: install it from https://cli.github.com'); return null; }
  say('the GitHub CLI is not installed: installing it with winget (about a minute) …');
  const r = spawnSync('winget', ['install', '--id', 'GitHub.cli', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'], { encoding: 'utf8', timeout: 10 * 60_000, windowsHide: true, shell: true });
  const found = findGh();
  say(found ? 'the GitHub CLI is installed' : `the GitHub CLI could not be installed (winget exit ${r.status}); install it from https://cli.github.com`);
  return found;
}

/** runs gh with the token (the token is only given to the gh process, never printed) */
export const realGh = (ghPath: string, token: string): GhRun => (args, input) => {
  const r = spawnSync(ghPath, args, { input, encoding: 'utf8', timeout: 120_000, windowsHide: true, env: { ...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' } });
  const strip = (t: string) => (token ? t.split(token).join('***') : t);
  return { status: r.status, out: strip((r.stdout || '').trim()), err: strip((r.stderr || '').trim()) };
};

const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 240);
const must = (r: GhResult, what: string): string => { if (r.status !== 0) throw new Error(`${what}: ${oneLine(r.err || r.out)}`); return r.out; };

/**
 * The commit through the GitHub API (no download of the branch). readme: appends the comment line to the README (Contents API);
 * empty: a commit with the same files as the branch head (git data API), moved forward only. Retries up to 3 times when the branch moved.
 */
export function ghDummyCommit(slug: string, branch: string, mode: 'readme' | 'empty', run: GhRun): { sha: string; attempts: number; verified: boolean } {
  const perm = run(['api', `repos/${slug}`, '--jq', '.permissions.push']);
  if (perm.status !== 0) throw new Error(`repository ${slug}: ${oneLine(perm.err || perm.out)}`);
  if (perm.out.trim() !== 'true') throw new Error(`HTTP 403: the token has no write access to ${slug}`);
  const refGet = `repos/${slug}/git/ref/heads/${branch}`, refSet = `repos/${slug}/git/refs/heads/${branch}`;
  const h0 = run(['api', refGet, '--jq', '.object.sha']);
  if (h0.status !== 0) throw new Error(/404/.test(h0.err + h0.out) ? `remote branch ${branch} not found in ${slug}` : `branch ${branch}: ${oneLine(h0.err || h0.out)}`);
  let sha = ''; let attempts = 0; let tries = 0;
  for (attempts = 1; attempts <= 3 && !sha; attempts++) {
    tries = attempts;
    const message = `dummy PR ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;
    try {
      if (mode === 'readme') {
        const rd = run(['api', `repos/${slug}/readme?ref=${encodeURIComponent(branch)}`]);
        let file = 'README.md', fileSha: string | undefined, cur = '';
        if (rd.status === 0) { const j = JSON.parse(rd.out); file = j.path || file; fileSha = j.sha; cur = Buffer.from(String(j.content || '').replace(/\s/g, ''), 'base64').toString('utf8'); }
        else if (!/404/.test(rd.err + rd.out)) throw new Error(`readme: ${oneLine(rd.err || rd.out)}`);
        const text = `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}<!-- ${message} -->\n`;
        const body: Record<string, string> = { message, content: Buffer.from(text, 'utf8').toString('base64'), branch };
        if (fileSha) body.sha = fileSha;
        const put = must(run(['api', '-X', 'PUT', `repos/${slug}/contents/${file.split('/').map(encodeURIComponent).join('/')}`, '--input', '-'], JSON.stringify(body)), 'commit');
        sha = String(JSON.parse(put).commit?.sha || '');
      } else {
        const head = must(run(['api', refGet, '--jq', '.object.sha']), 'branch head');
        const tree = must(run(['api', `repos/${slug}/git/commits/${head}`, '--jq', '.tree.sha']), 'head commit');
        const made = JSON.parse(must(run(['api', '-X', 'POST', `repos/${slug}/git/commits`, '--input', '-'], JSON.stringify({ message, tree, parents: [head] })), 'commit'));
        must(run(['api', '-X', 'PATCH', refSet, '--input', '-'], JSON.stringify({ sha: made.sha, force: false })), 'move branch');
        sha = String(made.sha || '');
      }
    } catch (e: any) {
      if (classifyGitError(String(e?.message || e)) === 'rejected' && attempts < 3) { console.log(`  dummy PR: the branch moved, trying again (${attempts}/3) …`); continue; }
      throw e;
    }
  }
  if (!sha) throw new Error('the commit was not created');
  const now = run(['api', refGet, '--jq', '.object.sha']);
  return { sha, attempts: tries, verified: now.status === 0 ? now.out.trim() === sha : false };
}

/**
 * Can the TOKEN write to the repo? (repo's "permissions.push" only says what the ACCOUNT may do; a token without "Contents: Read and write", not
 * covering the repo, or made for another owner gets HTTP 403 on the first write.) Creates one unreferenced blob: invisible on every branch, GitHub removes it later.
 */
export function ghTokenCanWrite(slug: string, run: GhRun): { ok: boolean; error?: string } {
  const r = run(['api', '-X', 'POST', `repos/${slug}/git/blobs`, '--input', '-'], JSON.stringify({ content: 'testable-merge-flow access check', encoding: 'utf-8' }));
  return r.status === 0 ? { ok: true } : { ok: false, error: oneLine(r.err || r.out) };
}


/**
 * Why does the token not work on this repo? Checks, in order: the token is accepted · it can see the repo (right owner, repo ticked, SSO) ·
 * the account has write access · the token may write (Contents: Read and write / "repo" scope). Returns the checks and the ONE cause to fix.
 */
export function diagnoseGh(slug: string, token: string, run: GhRun): { lines: string[]; cause: string } {
  const kind = /^github_pat_/.test(token) ? 'fine-grained' : /^gh[pous]_/.test(token) ? 'classic' : 'unknown-type';
  const lines: string[] = []; const owner = slug.split('/')[0];
  const u = run(['api', '-i', 'user']);
  if (u.status !== 0) {
    lines.push(`✗ the token (${kind}) is not accepted: ${oneLine(u.err || u.out)}`);
    return { lines, cause: /401|bad credentials/i.test(u.err + u.out) ? 'The token is invalid, revoked or expired. Make a new one and replace GH_TOKEN in .env.' : `GitHub refused or could not be reached: ${oneLine(u.err || u.out)}` };
  }
  const login = /"login"\s*:\s*"([^"]+)"/.exec(u.out)?.[1] || '?';
  const scopes = /x-oauth-scopes:\s*([^\r\n]*)/i.exec(u.out)?.[1]?.trim();
  lines.push(`✓ the token (${kind}) is valid and belongs to account ${login}${scopes !== undefined ? `; scopes: ${scopes || 'none'}` : ''}`);
  const r = run(['api', '-i', `repos/${slug}`]);
  if (r.status !== 0) {
    lines.push(`✗ the token cannot see ${slug}: ${oneLine(r.err || r.out)}`);
    if (/saml|sso/i.test(r.err + r.out)) return { lines, cause: `${owner} requires single sign-on: on GitHub open the token > Configure SSO > Authorize ${owner}.` };
    return { lines, cause: kind === 'fine-grained'
      ? `A fine-grained token only sees the repos of ONE owner and only those ticked. Either its Resource owner is not ${owner} (then make a classic token with the "repo" scope), or ${slug} is not in its Repository access list.`
      : `The token has no access to ${slug}: account ${login} must be a collaborator with write access (ask ${owner}), and a classic token needs the "repo" scope.` };
  }
  lines.push(`✓ the token can see ${slug}`);
  if (!/"push"\s*:\s*true/.test(r.out)) { lines.push(`✗ account ${login} has only read access to ${slug}`); return { lines, cause: `Account ${login} has no write access to ${slug}. Ask ${owner} to add ${login} as a collaborator with write access.` }; }
  lines.push(`✓ account ${login} has write access to ${slug}`);
  const w = ghTokenCanWrite(slug, run);
  if (!w.ok) {
    lines.push(`✗ the token is refused when writing: ${w.error}`);
    return { lines, cause: kind === 'fine-grained' ? `The token can see the repo but not write: in its settings set Repository permissions > Contents to "Read and write".`
      : scopes !== undefined && !/\brepo\b/.test(scopes) ? 'The classic token has no "repo" scope: make a new one with "repo" ticked.' : `The token is refused when writing (${w.error}); check its settings and the SSO authorization.` };
  }
  lines.push('✓ the token can write to the repo');
  return { lines, cause: '' };
}

/** what a token can do on one repo, and when it expires (for npm run preflight) */
export function ghRepoAccess(slug: string, run: GhRun): { push: boolean; expires?: string; error?: string } {
  const r = run(['api', '-i', `repos/${slug}`]);
  if (r.status !== 0) return { push: false, error: oneLine(r.err || r.out) };
  const exp = /github-authentication-token-expiration:\s*([^\r\n]+)/i.exec(r.out)?.[1]?.trim();
  return { push: /"push"\s*:\s*true/.test(r.out), expires: exp };
}

const HINT_TOKEN = 'the token cannot write to this repo. In the token settings: Repository access must include this repo, Permissions > Contents must be "Read and write", and the token\'s Resource owner must be the repo\'s owner. If that owner is not in the Resource owner list, make a classic token with the "repo" scope.';
const HINTS: Record<string, string> = {
  'no-access': 'no push access to the repo (the token in .env has no write access or has expired, or this PC\'s git login has none; ask the repo owner for write access). The run goes on with the branch\'s old commit; in the platform use "Analyze latest commit" / "Run again".',
  'rejected': 'the branch kept moving while we pushed (another PC or a protected branch rule). The run goes on with the branch\'s old commit.',
  'branch-missing': 'the branch does not exist on GitHub under that name.',
  'network': 'GitHub could not be reached; the run goes on with the old commit.',
  'other': 'the run goes on with the old commit.',
};

/**
 * Gives the branch a NEW commit and pushes it, so Testable starts a fresh analysis instead of reusing the old one.
 * Needs nothing but the git login this PC already has. Retries up to 3 times when the push is rejected because the branch moved.
 * Checks on GitHub that the branch now points at our commit. Never throws: a problem is logged and returned in `reason` / `hint`.
 */
export function pushDummyCommit(repo: string, branch: string): DummyResult {
  const mode = dummyMode();
  const res: DummyResult = { sha: null, mode, repo, branch, attempts: 0, at: new Date().toISOString() };
  const slug = ownerAndName(repo);
  if (!slug) { res.reason = `"${repo}" has no owner`; res.hint = 'use "owner/repo" or the full link in builds.json'; console.log(`  dummy PR skipped — ${res.reason} (${res.hint})`); return res; }
  const via = dummyVia(); const token = tokenFor(slug.split('/')[0]);
  const say = (m: string) => console.log(`  dummy PR: ${m}`);
  if (via !== 'git') {
    if (!token) {
      if (via === 'gh') { res.reason = 'no-access: no token'; res.hint = 'put GH_TOKEN=<token> (or GH_TOKEN_<OWNER>=<token>) in .env'; say(res.hint); return res; }
      say('no GH_TOKEN in .env, using this PC\'s git login');
    } else {
      let run: GhRun | null = null;
      try {
        const gh = findGh() || installGh(say);
        if (!gh) throw new Error('the GitHub CLI is not available');
        run = realGh(gh, token);
        say(`${mode} commit through the GitHub CLI on ${slug} @ ${branch} …`);
        const r = ghDummyCommit(slug, branch, mode, run);
        res.sha = r.sha; res.attempts = r.attempts; res.verified = r.verified; res.via = 'gh';
        say(`pushed → new commit ${r.sha.slice(0, 8)} on ${slug}@${branch}${r.verified ? ' (checked on GitHub)' : ' (the branch has moved on since: another push landed after ours)'}`);
        return res;
      } catch (e: any) {
        const msg = String(e?.message || e).replace(/\s+/g, ' ').trim().slice(0, 300); const kind = classifyGitError(msg);
        if (via === 'gh' || kind === 'branch-missing') {
          res.reason = `${kind}: ${msg}`; res.hint = HINTS[kind];
          say(`the GitHub CLI failed (${kind}): ${msg}`);
          if (run && (kind === 'no-access' || kind === 'other')) { // find the root cause
            const d = diagnoseGh(slug, token, run);
            for (const l of d.lines) console.log(`      ${l}`);
            if (d.cause) { res.hint = d.cause; console.log(`    ROOT CAUSE: ${d.cause}`); }
          } else console.log(`    → ${res.hint}`);
          return res;
        }
        say(`the GitHub CLI way failed (${kind}: ${msg}); trying this PC's git login (DUMMY_VIA=auto)`);
      }
    }
  }
  res.via = 'git';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dummy-pr-'));
  try {
    console.log(`  dummy PR (${mode}): cloning ${slug} @ ${branch} …`);
    git(['clone', '--depth', '1', '--single-branch', '--branch', branch, `https://github.com/${slug}.git`, dir]);
    let who: string[] = [];
    try { git(['config', 'user.email'], dir); } catch { who = ['-c', 'user.name=testable-merge-flow', '-c', 'user.email=testable-merge-flow@users.noreply.github.com']; }
    for (let attempt = 1; attempt <= 3 && !res.sha; attempt++) {
      res.attempts = attempt;
      const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
      if (mode === 'readme') {
        const readme = ['README.md', 'readme.md', 'Readme.md'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f)) || path.join(dir, 'README.md');
        const cur = fs.existsSync(readme) ? fs.readFileSync(readme, 'utf8') : '';
        fs.writeFileSync(readme, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}<!-- dummy PR ${stamp} -->\n`);
        git(['add', path.basename(readme)], dir);
      }
      git(['commit', ...(mode === 'empty' ? ['--allow-empty'] : []), '-m', `dummy PR ${stamp}`], dir, who);
      try {
        git(['push', 'origin', `HEAD:${branch}`], dir);
        res.sha = git(['rev-parse', 'HEAD'], dir);
      } catch (e: any) {
        const msg = String(e?.stderr || e?.message || e);
        if (classifyGitError(msg) === 'rejected' && attempt < 3) {
          console.log(`  dummy PR: push rejected (the branch moved), trying again (${attempt}/3) …`);
          git(['fetch', '--depth', '1', 'origin', branch], dir);
          git(['reset', '--hard', 'FETCH_HEAD'], dir);
          continue;
        }
        throw e;
      }
    }
    if (res.sha) {
      try { res.verified = git(['ls-remote', 'origin', `refs/heads/${branch}`], dir).split(/\s+/)[0] === res.sha; } catch { res.verified = undefined; }
      console.log(`  dummy PR pushed → new commit ${res.sha.slice(0, 8)} on ${slug}@${branch}${res.verified === false ? ' (the branch has moved on since: another push landed after ours)' : res.verified ? ' (checked on GitHub)' : ''}`);
    }
  } catch (e: any) {
    const msg = String(e?.stderr || e?.message || e).replace(/\s+/g, ' ').trim().slice(0, 300);
    const kind = classifyGitError(msg);
    res.reason = `${kind}: ${msg}`; res.hint = HINTS[kind];
    console.log(`  dummy PR failed (${kind}): ${msg}\n    → ${res.hint}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder, ignore */ }
  }
  return res;
}

/** Compares the commit the platform analysed with the dummy commit and writes the verdict into dummy-commit.json. Never throws. */
export function recordDummyOutcome(branchDir: string, dummy: DummyResult | undefined, runCommit: string | undefined): void {
  try {
    if (!dummy) return;
    dummy.run_commit = runCommit || '';
    dummy.matched = !!(dummy.sha && runCommit && (dummy.sha === runCommit || dummy.sha.startsWith(runCommit) || runCommit.startsWith(dummy.sha)));
    fs.writeFileSync(path.join(branchDir, 'dummy-commit.json'), JSON.stringify(dummy, null, 2));
    if (dummy.sha && !dummy.matched) console.log(`  ⚠ the platform analysed commit ${String(runCommit).slice(0, 8)}, not our dummy commit ${dummy.sha.slice(0, 8)} — this run is on an older commit (the branch may have moved, or the platform had not seen the new commit yet)`);
    else if (dummy.sha) console.log(`  dummy PR check: the platform analysed our commit ${dummy.sha.slice(0, 8)} ✓`);
  } catch { /* optional */ }
}
