import { spawn, spawnSync } from 'child_process';
import { eksAutoEnabled } from './eksAnalyze';

/**
 * Keeps the QA EKS sign-in alive with as little work for the person as possible.
 *   signed in already            -> nothing happens
 *   expired / never signed in    -> runs  aws sso login --profile qa-eks-ro --no-browser , takes the sign-in link it prints,
 *                                   opens that link in a PRIVATE Chrome (or Edge) window, and waits for the sign-in to finish.
 * The person types the account's email and password (and any MFA) in that window. This code never knows, stores or types them.
 * Never throws and never stops a run: no answer within EKS_LOGIN_WAIT_MIN minutes (default 4) = the run carries on without the cluster logs.
 * Used by: npm run eks:setup, and the first step of every test round (tests/auth.setup.ts) when EKS_AUTO is on.
 */
const clean = (s?: string) => (s || '').trim().replace(/^["']|["']$/g, '');
const PROFILE = () => clean(process.env.EKS_AWS_PROFILE) || 'qa-eks-ro';
const REGION = () => clean(process.env.EKS_REGION) || 'us-east-2';
const AWS = () => clean(process.env.EKS_AWS_CLI) || 'aws';
const WIN = process.platform === 'win32';

export function eksSignedIn(): boolean {
  const r = spawnSync(AWS(), ['sts', 'get-caller-identity', '--profile', PROFILE(), '--region', REGION(), '--output', 'json'], { encoding: 'utf8', shell: WIN, timeout: 30_000, env: { ...process.env, AWS_PAGER: '' } });
  return r.status === 0;
}

/** opens the link in a private window: Chrome, then Edge; returns false when neither could be started (the link is then only printed) */
function openPrivate(url: string): boolean {
  try {
    if (WIN) {
      const q = url.replace(/'/g, "''");
      for (const [exe, flag] of [['chrome', '--incognito'], ['msedge', '--inprivate']]) {
        const r = spawnSync('powershell', ['-NoProfile', '-Command', `Start-Process ${exe} -ArgumentList '${flag}','"${q}"' -ErrorAction Stop`], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
        if (r.status === 0) return true;
      }
      return false;
    }
    const cmds: [string, string[]][] = process.platform === 'darwin' ? [['open', ['-na', 'Google Chrome', '--args', '--incognito', url]]] : [['google-chrome', ['--incognito', url]], ['chromium', ['--incognito', url]]];
    for (const [c, a] of cmds) { const r = spawnSync(c, a, { timeout: 10_000, stdio: 'ignore' }); if (r.status === 0) return true; }
  } catch { /* fall through */ }
  return false;
}

/** resolves true when the profile is signed in afterwards */
export async function ensureEksSignedIn(opts: { force?: boolean; log?: (m: string) => void } = {}): Promise<boolean> {
  const say = opts.log || ((m: string) => console.log(`  QA EKS sign-in: ${m}`));
  try {
    if (!opts.force && !eksAutoEnabled()) return false;
    if (eksSignedIn()) { say('already signed in'); return true; }
    const waitMs = (Number(process.env.EKS_LOGIN_WAIT_MIN) || 4) * 60_000;
    say(`not signed in — starting the sign-in for profile ${PROFILE()}`);
    return await new Promise<boolean>((resolve) => {
      let opened = false; let done = false;
      const child = spawn(AWS(), ['sso', 'login', '--profile', PROFILE(), '--no-browser'], { shell: WIN, windowsHide: true, env: { ...process.env, AWS_PAGER: '' } });
      const finish = (ok: boolean, why: string) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch { /* ignore */ } say(why); resolve(ok); };
      const timer = setTimeout(() => finish(eksSignedIn(), `no sign-in within ${waitMs / 60_000} min — the run goes on without the cluster logs`), waitMs);
      const onText = (d: Buffer) => {
        const txt = d.toString('utf8');
        const m = /(https:\/\/[^\s]*(?:oidc|device|authorize|awsapps)[^\s]*)/i.exec(txt);
        if (m && !opened) {
          opened = true; const url = m[1];
          const ok = openPrivate(url);
          say(ok ? 'a private browser window was opened: sign in there with the QA account (email, password, any MFA). Waiting …' : `could not open a private window. Open this link in a private window yourself and sign in:\n${url}`);
        }
      };
      child.stdout?.on('data', onText); child.stderr?.on('data', onText);
      child.on('error', (e) => finish(false, `aws CLI could not be started (${e.message})`));
      child.on('close', () => finish(eksSignedIn(), eksSignedIn() ? 'signed in — cluster logs will be captured' : 'sign-in did not complete — the run goes on without the cluster logs'));
    });
  } catch (e) { console.log(`  QA EKS sign-in: skipped (${e instanceof Error ? e.message : e})`); return false; }
}

if (require.main === module) ensureEksSignedIn({ force: true }).then((ok) => process.exit(ok ? 0 : 1));
