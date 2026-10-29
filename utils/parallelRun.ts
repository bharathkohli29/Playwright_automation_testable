// Two (or more) Testable accounts, one list of branches:  npm run parallel
// - the branches come from builds.json (or BRANCHES), exactly like npm test
// - every account is a "lane": it takes the next waiting branch, runs it, and when it is done takes the next one,
//   so the branch list moves to whichever account is free
// - a lane runs ONE branch per `playwright test` process (login, flow, logout); the background worker of the lane keeps
//   working on the finished branch while the lane already runs the next one
// Accounts: TESTABLE_EMAIL (account 1) and TESTABLE_EMAIL_2, _3 ... (DEV: TESTABLE_EMAIL_DEV, TESTABLE_EMAIL_DEV_2 ...) in .env.
// LANES=1 (terminal) limits the number of lanes. Do not set ACCOUNT yourself: the launcher sets it for each lane.
import './env';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { spawn, execFile, ChildProcess } from 'child_process';
import { loadBuilds, Build } from './builds';
import { TEST_ENV } from './env';

const ROOT = path.join(__dirname, '..');
const DEV = TEST_ENV === 'dev';
const CMD = process.env.PARALLEL_CMD || 'npx playwright test --project=flow'; // PARALLEL_CMD: test hook
const STAGGER_MS = Number(process.env.PARALLEL_STAGGER_SEC ?? 20) * 1000; // lane k starts k x this later, so two logins and two analyses do not start in the same second
const CAP_MIN = Number(process.env.RUN_TIMEOUT_MIN || 35) + 45; // a branch process that runs longer than this is killed (frozen)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const p2 = (n: number) => String(n).padStart(2, '0');

interface Lane { n: string; label: string; runDir: string; noStart: number; retired: boolean; current: string; logPos: number; child?: ChildProcess }
interface Result { branch: string; repo: string; lane: string; status: string; minutes?: number; note?: string }

try { require('../queue-server/keepAwake').keepAwake('the two-account run is active'); } catch { /* ignore */ }

const emailKey = (n: string) => `${DEV ? 'TESTABLE_EMAIL_DEV' : 'TESTABLE_EMAIL'}${n === '1' ? '' : `_${n}`}`;
const say = (lane: Lane | null, text: string) => { for (const l of String(text).split(/\r?\n/)) if (l.trim()) console.log(`${lane ? `[${lane.label}] ` : '[parallel] '}${l}`); };

function summaryFor(lane: Lane, b: Build): any | undefined {
  try { const all = JSON.parse(fs.readFileSync(path.join(lane.runDir, 'summary.json'), 'utf8')); return all.slice().reverse().find((x: any) => x.branch === b.branch); } catch { return undefined; }
}

function killTree(child?: ChildProcess) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else { try { child.kill('SIGTERM'); } catch { /* ignore */ } }
}

/** copies new lines of the lane's background-worker log (postprocess.log) to this terminal */
function tailWorker(lane: Lane) {
  try {
    const f = path.join(lane.runDir, 'postprocess.log'); if (!fs.existsSync(f)) return;
    const size = fs.statSync(f).size; if (size < lane.logPos) lane.logPos = 0; if (size === lane.logPos) return;
    const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(size - lane.logPos);
    fs.readSync(fd, buf, 0, buf.length, lane.logPos); fs.closeSync(fd); lane.logPos = size;
    for (const l of buf.toString('utf8').split(/\r?\n/)) if (l.trim()) console.log(`[${lane.label} post] ${l}`);
  } catch { /* ignore */ }
}

function runBranch(lane: Lane, b: Build): Promise<number> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ACCOUNT: lane.n === '1' ? '' : lane.n, REPO: b.repo, BRANCHES: b.branch, RUN_DIR: lane.runDir, POSTPROCESS_WAIT: 'off', POSTPROCESS_ECHO: 'off', QUEUE_NO_MIRROR: '1' };
    const child = spawn(CMD, { cwd: ROOT, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    lane.child = child;
    for (const s of [child.stdout!, child.stderr!]) readline.createInterface({ input: s }).on('line', (l) => say(lane, l));
    const cap = setTimeout(() => { say(lane, `no result after ${CAP_MIN} min: stopping this branch process`); killTree(child); }, CAP_MIN * 60_000);
    child.on('error', (e) => { say(lane, `could not start: ${e.message}`); });
    child.on('close', (code) => { clearTimeout(cap); lane.child = undefined; resolve(code ?? 1); });
  });
}

async function main() {
  if ((process.env.ACCOUNT || '').trim()) { console.log('Do not set ACCOUNT for npm run parallel: the launcher sets it for each lane.'); process.exit(1); }
  const builds = loadBuilds();
  if (!builds.length) { console.log('No branches: fill builds.json (or set BRANCHES) first.'); process.exit(1); }
  if (!process.env[emailKey('1')]) { console.log(`${emailKey('1')} is missing in .env`); process.exit(1); }
  let accounts = ['1']; for (let i = 2; i <= 9; i++) if (process.env[emailKey(String(i))] && process.env[emailKey(String(i)).replace('EMAIL', 'PASSWORD')]) accounts.push(String(i));
  const maxLanes = Number(process.env.LANES || accounts.length); accounts = accounts.slice(0, Math.max(1, maxLanes));
  const d = new Date();
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
  const lanes: Lane[] = accounts.map((n) => ({ n, label: `acct${n}`, runDir: path.join(ROOT, 'results', `merge-flow_${DEV ? 'dev_' : ''}${stamp}_acct${n}`), noStart: 0, retired: false, current: '', logPos: 0 }));
  say(null, `${builds.length} branch(es), ${lanes.length} account lane(s): ${lanes.map((l) => l.label).join(', ')}${lanes.length < 2 ? '  (add TESTABLE_EMAIL_2 and TESTABLE_PASSWORD_2 to .env for a second lane)' : ''}`);

  process.env.RUN_DIR = lanes[0].runDir; // postprocessQueue reads RUN_DIR when it is loaded; without it a stray results/latest folder would be created
  const { drainPostProcess } = await import('./postprocessQueue');
  const queue = builds.slice();
  const results = new Map<string, Result>();
  const tried = new Map<string, Set<string>>(); // branch -> lanes that already failed to start it
  const pick = (lane: Lane): Build | undefined => { const i = queue.findIndex((b) => !tried.get(b.id)?.has(lane.n)); return i < 0 ? undefined : queue.splice(i, 1)[0]; };
  const tailer = setInterval(() => lanes.forEach(tailWorker), 3000);

  const onStop = () => { say(null, 'stopping: closing the running branch processes'); lanes.forEach((l) => killTree(l.child)); setTimeout(() => process.exit(130), 1500); };
  process.on('SIGINT', onStop); process.on('SIGTERM', onStop);

  const runLane = async (lane: Lane, delayMs: number) => {
    if (delayMs) { say(lane, `starts in ${Math.round(delayMs / 1000)} s`); await sleep(delayMs); }
    for (;;) {
      if (lane.retired) return;
      const b = pick(lane); if (!b) return;
      lane.current = b.branch; say(lane, `=== ${b.branch} (${b.repo}) — ${queue.length} still waiting ===`);
      const t0 = Date.now();
      const code = await runBranch(lane, b);
      const s = summaryFor(lane, b);
      if (s) { lane.noStart = 0; results.set(b.id, { branch: b.branch, repo: b.repo, lane: lane.label, status: s.status, minutes: s.minutes, note: s.note }); say(lane, `=== ${b.branch}: ${s.status}${s.minutes !== undefined ? ` (${s.minutes} min)` : ''} ===`); }
      else {
        // the process ended before the branch produced a result (login problem, site down ...): another lane gets a try
        lane.noStart++; (tried.get(b.id) || tried.set(b.id, new Set()).get(b.id)!).add(lane.n);
        say(lane, `=== ${b.branch}: did not start (exit code ${code}, ${Math.round((Date.now() - t0) / 1000)} s) ===`);
        if (lanes.some((l) => !l.retired && !tried.get(b.id)!.has(l.n))) queue.unshift(b);
        else results.set(b.id, { branch: b.branch, repo: b.repo, lane: lane.label, status: 'not started', note: `exit code ${code} on every account` });
        if (lane.noStart >= 2) { lane.retired = true; say(lane, 'two branches in a row did not start: this lane is stopped (check the login of this account); the other lanes continue'); }
      }
      lane.current = '';
    }
  };
  await Promise.all(lanes.map((l, i) => runLane(l, i * STAGGER_MS)));
  // anything left because every lane stopped
  for (const b of queue) results.set(b.id, { branch: b.branch, repo: b.repo, lane: '-', status: 'not run', note: 'every account lane stopped' });

  // wait for every lane's background worker (S3 check, SharePoint, Teams of the last branches)
  say(null, 'all branches done: waiting for the background workers to finish …');
  for (const l of lanes) { process.env.RUN_DIR = l.runDir; await drainPostProcess(70); tailWorker(l); }
  clearInterval(tailer); lanes.forEach(tailWorker);

  const rows = builds.map((b) => results.get(b.id)).filter(Boolean) as Result[];
  console.log('\n=== Summary ===');
  for (const r of rows) console.log(`  ${r.status.padEnd(12)} ${r.lane.padEnd(6)} ${String(r.minutes ?? '-').padStart(4)} min  ${r.branch}${r.note && r.status !== 'passed' ? `  — ${String(r.note).slice(0, 110)}` : ''}`);
  console.log(`  results: ${lanes.map((l) => path.relative(ROOT, l.runDir)).join('  |  ')}`);
  try { fs.writeFileSync(path.join(ROOT, 'results', `parallel_${stamp}_summary.json`), JSON.stringify({ lanes: lanes.map((l) => ({ lane: l.label, runDir: l.runDir })), results: rows }, null, 2)); } catch { /* ignore */ }
  process.exit(rows.every((r) => r.status === 'passed') ? 0 : 1);
}
main().catch((e) => { console.log(`parallel run failed: ${e instanceof Error ? e.stack || e.message : e}`); process.exit(1); });
