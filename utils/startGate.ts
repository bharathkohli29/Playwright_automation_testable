import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { eksSignedIn } from './eksLogin';
import { eksAutoEnabled } from './eksAnalyze';
import { prepareCode } from './rcaCode';

/**
 * The FIRST thing the terminal does when someone starts the script (npm test / npm run go), before the model setup and before any browser step:
 * it checks the QA EKS sign-in and, when the person is not signed in, says so in the terminal and starts the sign-in (npm run eks:setup does the
 * profile, the sign-in window and the checks). Only after that the other processes start.
 * Never stops a run: with no sign-in the run goes on without the cluster logs (the same as before). The code never sees a password.
 */
const GREEN = '\x1b[32m✔\x1b[0m'; const YELLOW = '\x1b[33m!\x1b[0m'; const BOLD = (s: string) => `\x1b[1m${s}\x1b[0m`;

export function gate(): boolean {
  dotenv.config({ override: true });
  if (!eksAutoEnabled()) { console.log(`${YELLOW} QA EKS: EKS_AUTO is off, the cluster logs are not captured in this run`); return false; }
  if (eksSignedIn()) { console.log(`${GREEN} QA EKS cluster: signed in`); return true; }
  console.log(`\n${YELLOW} ${BOLD('QA EKS cluster: you are not signed in.')}`);
  console.log('   A private browser window opens now: sign in there with the QA account (email, password, any MFA).');
  console.log('   The terminal waits for you; when it shows the green tick the other steps start.\n');
  const r = spawnSync('npx', ['tsx', 'utils/eksSetup.ts'], { stdio: 'inherit', shell: process.platform === 'win32' });
  const ok = eksSignedIn();
  console.log(ok ? `\n${GREEN} QA EKS cluster: signed in, starting the other steps` : `\n${YELLOW} QA EKS cluster: not signed in (${r.status === 0 ? 'no answer' : 'setup reported a problem'}), the run goes on without the cluster logs. Later: npm run eks:setup`);
  return ok;
}

/** starts utils/postSweep.ts detached (log: results/post-sweep.log); POST_SWEEP=off turns it off */
export function startSweep(): { ok: boolean; msg: string } {
  if (/^(0|no|off|false)$/i.test((process.env.POST_SWEEP || '').trim())) return { ok: false, msg: 'off (POST_SWEEP=off)' };
  const root = path.resolve(__dirname, '..'); const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!fs.existsSync(tsx)) return { ok: false, msg: 'not started (run npm install)' };
  fs.mkdirSync(path.join(root, 'results'), { recursive: true }); const out = fs.openSync(path.join(root, 'results', 'post-sweep.log'), 'a');
  const child = spawn(process.execPath, [tsx, path.join(__dirname, 'postSweep.ts')], { detached: true, stdio: ['ignore', out, out], cwd: root, windowsHide: true }); child.unref();
  return { ok: true, msg: 'checked in the background; a branch an earlier run left behind gets its RCA Report, SharePoint copy and Teams card (log: results/post-sweep.log)' };
}

if (require.main === module) {
  try { gate(); } catch (e) { console.log(`${YELLOW} sign-in check skipped (${e instanceof Error ? e.message : String(e)})`); }
  try { const ok = prepareCode((m) => console.log(`  ${m}`)); console.log(`${ok ? GREEN : YELLOW} platform code ${ok ? 'ready: the reports show where each error is raised' : 'not available: the reports are written without the code section'}`); } catch (e) { console.log(`${YELLOW} platform code skipped (${e instanceof Error ? e.message : String(e)})`); }
  process.exit(0);
}
