import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PLATFORM_REMOTE, DEFAULT_BRANCH, scrub } from './rcaCode';

/**
 * One-time login of this PC to the platform repo, for the automatic code check of the RCA Report:   npm run code:login
 *   1. asks for the token of the automation GitHub account (read only, this repo only); what you type is hidden
 *   2. checks it against the repo (git ls-remote of the branch qa)
 *   3. only when it works: saves it as RCA_CODE_TOKEN in the git-ignored .env of this repo
 * After this, the clone and the fetch of qa need no sign-in at all. The token is never printed, never put on a command line and never written anywhere else.
 * (GitHub does not accept an account password for git, so the account makes a token once: Settings > Developer settings > Fine-grained tokens, repo
 *  testable-platform/ai-testable-platform, permission Contents: Read.)
 */
const GREEN = '\x1b[32m✔\x1b[0m'; const RED = '\x1b[31m✘\x1b[0m';
const NLC = String.fromCharCode(10);

/** sets KEY=value in the text of a .env file: replaces an existing (or commented-out) line, otherwise appends; every other line is kept as it is */
export function upsertEnv(text: string, key: string, value: string): string {
  const eol = text.includes(String.fromCharCode(13, 10)) ? String.fromCharCode(13, 10) : NLC;
  const lines = text.split(/\r?\n/); const line = `${key}=${value}`; let done = false;
  const out = lines.map((l) => { if (!done && new RegExp(`^\\s*#?\\s*${key}\\s*=`).test(l)) { done = true; return line; } return l; });
  if (!done) { if (out.length && out[out.length - 1] === '') out.splice(out.length - 1, 0, line); else out.push(line); }
  return out.join(eol);
}

/** does this token read the repo? (ls-remote of the branch; nothing is downloaded) */
export function verifyToken(token: string, remote = PLATFORM_REMOTE, branch = DEFAULT_BRANCH): { ok: boolean; sha?: string; why?: string } {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const r = spawnSync('git', ['ls-remote', remote, `refs/heads/${branch}`], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` } });
  const clean = (x: string) => x.split(token).join('<token>').split(basic).join('<token>');
  if (r.status !== 0) { const e = clean(String(r.stderr || '')).trim().split(NLC)[0]; return { ok: false, why: /not found|Authentication failed|403|401|Invalid username or token/i.test(e) ? `GitHub refused it (${e.slice(0, 120)}). The account needs Read access to the repo, and an SSO-enabled org needs the token authorized.` : e.slice(0, 160) || 'git failed' }; }
  const sha = String(r.stdout || '').trim().split(/\s+/)[0]; return sha ? { ok: true, sha: sha.slice(0, 9) } : { ok: false, why: `the repo answered, but has no branch ${branch}` };
}

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { let buf = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { buf += d; }); process.stdin.on('end', () => resolve(buf.trim())); return; }
    process.stdout.write(prompt); let v = ''; process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    const on = (c: string) => {
      for (const ch of c) {
        if (ch === '\r' || ch === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', on); process.stdout.write(NLC); resolve(v.trim()); return; }
        if (ch === '\u0003') { process.stdin.setRawMode(false); process.stdout.write(NLC); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') v = v.slice(0, -1); else v += ch; // nothing is echoed
      }
    };
    process.stdin.on('data', on);
  });
}

async function main() {
  const envFile = path.resolve(process.cwd(), '.env');
  const ign = spawnSync('git', ['check-ignore', '-q', '.env'], { cwd: process.cwd() });
  if (ign.status !== 0) { console.log(`${RED} .env is not git-ignored here, so the token would not be safe in it. Nothing was saved.`); process.exit(1); }
  console.log('Platform code login for the RCA Report. Use the token of the automation GitHub account (read only, repo testable-platform/ai-testable-platform).');
  const token = process.argv[2] === '--stdin' || !process.stdin.isTTY ? await ask('') : await ask('Token (hidden): ');
  if (!token) { console.log(`${RED} no token entered. Nothing was saved.`); process.exit(1); }
  const v = verifyToken(token);
  if (!v.ok) { console.log(`${RED} the token does not work: ${scrub(v.why || '')}. Nothing was saved.`); process.exit(1); }
  const text = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  fs.writeFileSync(envFile, upsertEnv(text, 'RCA_CODE_TOKEN', token));
  console.log(`${GREEN} logged in: the repo answers, ${DEFAULT_BRANCH} is at ${v.sha}. The token is saved in .env as RCA_CODE_TOKEN. From now on the platform code is cloned and fetched automatically.`);
}

if (require.main === module) main().catch((e) => { console.log(`${RED} login failed: ${scrub(e instanceof Error ? e.message : String(e))}`); process.exit(1); });
