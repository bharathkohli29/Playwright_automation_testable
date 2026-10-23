import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** DUMMY_PR=yes in .env (or $env:DUMMY_PR="yes") turns the dummy-commit step on. Default: off. */
export const dummyPrEnabled = () => /^(yes|y|true|on|1)$/i.test((process.env.DUMMY_PR || '').trim());

const git = (args: string[], cwd?: string, extra: string[] = []) =>
  execFileSync('git', [...extra, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 180_000 }).trim();

/** "owner/name" from "owner/name", "https://github.com/owner/name(.git)" or ".../tree/branch". */
function ownerAndName(repo: string): string | null {
  const m = /^(?:https?:\/\/github\.com\/)?([^/\s]+\/[^/\s]+?)(?:\.git)?(?:\/.*)?$/i.exec(repo.trim());
  return m ? m[1] : null;
}

/**
 * Adds a comment line ("dummy PR <date time>") at the END of README.md on the branch and pushes it, so the branch gets a NEW commit
 * and Testable starts a fresh analysis instead of reusing the old one. Never throws — a problem is logged and the run goes on with the old commit.
 * Returns the new commit sha, or null when nothing was pushed.
 */
export function pushDummyCommit(repo: string, branch: string): string | null {
  const slug = ownerAndName(repo);
  if (!slug) { console.log(`  dummy PR skipped — "${repo}" has no owner (use "owner/repo" or the full link in builds.json)`); return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dummy-pr-'));
  try {
    console.log(`  dummy PR: cloning ${slug} @ ${branch} …`);
    git(['clone', '--depth', '1', '--single-branch', '--branch', branch, `https://github.com/${slug}.git`, dir]);
    const readme = ['README.md', 'readme.md', 'Readme.md'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f)) || path.join(dir, 'README.md');
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const cur = fs.existsSync(readme) ? fs.readFileSync(readme, 'utf8') : '';
    fs.writeFileSync(readme, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}<!-- dummy PR ${stamp} -->\n`);
    git(['add', path.basename(readme)], dir);
    let who: string[] = [];
    try { git(['config', 'user.email'], dir); } catch { who = ['-c', 'user.name=testable-merge-flow', '-c', 'user.email=testable-merge-flow@users.noreply.github.com']; }
    git(['commit', '-m', `dummy PR ${stamp}`], dir, who);
    git(['push', 'origin', `HEAD:${branch}`], dir);
    const sha = git(['rev-parse', 'HEAD'], dir);
    console.log(`  dummy PR pushed → new commit ${sha.slice(0, 8)} on ${slug}@${branch}`);
    return sha;
  } catch (e: any) {
    const msg = String(e?.stderr || e?.message || e).replace(/\s+/g, ' ').trim().slice(0, 300);
    console.log(`  dummy PR failed (the run continues on the old commit): ${msg}`);
    return null;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder, ignore */ }
  }
}
