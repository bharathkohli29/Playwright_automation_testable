import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { runDir } from './evidence';
import type { PostJob } from './postprocess';
import { writePostState } from './postprocess';

/**
 * Hand-off from the site test to the background post-processing worker (utils/postprocessWorker.ts).
 * Jobs are plain files in <run folder>/.postprocess/, so a crash loses nothing: a restarted worker picks them up again.
 * POSTPROCESS=inline in .env keeps the old behaviour (everything inside the site test, one branch after the other).
 */
export const postprocessMode = (): 'background' | 'inline' => (/^(inline|off|0|no)$/i.test((process.env.POSTPROCESS || '').trim()) ? 'inline' : 'background');

const ROOT = path.join(__dirname, '..');
const qDir = () => { const d = path.join(runDir(), '.postprocess'); fs.mkdirSync(d, { recursive: true }); return d; };
const logFile = () => path.join(runDir(), 'postprocess.log');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return !!e && (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/** The sender gets a clean environment: nothing Playwright put there for the test run (PW_*, NODE_OPTIONS, loaders) can reach it. */
function cleanEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(PW_|PLAYWRIGHT_(?!BROWSERS_PATH)|NODE_OPTIONS$|ELECTRON_|VSCODE_)/i.test(k)) e[k] = v;
  return e;
}

function workerAlive(dir: string): boolean {
  try { return alive(Number(fs.readFileSync(path.join(dir, 'worker.pid'), 'utf8'))); } catch { return false; }
}

/** Starts the worker if none is running for this run folder. Returns false when it cannot be started (then the caller works inline). */
function ensureWorker(): boolean {
  const dir = qDir();
  if (workerAlive(dir)) return true;
  const tsx = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!fs.existsSync(tsx)) { console.log('  post-processing worker not started: run  npm install  (tsx is missing) — working inline instead'); return false; }
  try { fs.rmSync(path.join(dir, 'worker.done'), { force: true }); } catch { /* ignore */ }
  const out = fs.openSync(logFile(), 'a');
  const child = spawn(process.execPath, [tsx, path.join(__dirname, 'postprocessWorker.ts'), dir], { detached: true, stdio: ['ignore', out, out], cwd: ROOT, windowsHide: true, env: { ...cleanEnv(), RUN_DIR: runDir() } });
  child.on('error', () => { /* checked through worker.pid below */ });
  if (child.pid) fs.writeFileSync(path.join(dir, 'worker.pid'), String(child.pid)); // registered at once, so a second hand-off a moment later does not start a second worker
  child.unref();
  console.log(`  post-processing worker started (log: ${logFile()})`);
  return true;
}

/** Queue the branch's S3 check / SharePoint copy / Teams message. Returns true when the worker took it over. */
export function enqueuePostProcess(job: PostJob): boolean {
  try {
    const dir = qDir();
    try { fs.rmSync(path.join(dir, 'CLOSE'), { force: true }); } catch { /* a new job means more may follow */ }
    const name = `${Date.now()}-${path.basename(job.branchDir).replace(/[^\w.-]+/g, '_')}.job.json`;
    const tmp = path.join(dir, `${name}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
    fs.renameSync(tmp, path.join(dir, name));
    writePostState(job.branchDir, { state: 'queued', steps: { s3: 'pending', sharepoint: 'pending', teams: 'pending' }, detail: {}, updated: new Date().toISOString() });
    if (!ensureWorker()) { fs.rmSync(path.join(dir, name), { force: true }); return false; }
    console.log(`  ${job.branch}: handed to the background worker — the next branch starts now`);
    return true;
  } catch (e) {
    console.log(`  post-processing hand-off failed (${e instanceof Error ? e.message : e}) — working inline instead`);
    return false;
  }
}

let logPos = 0;
/** Prints what the worker has logged since the last call, so its lines show in this terminal and on the queue's /output page. */
export function echoWorkerLog(): void {
  try {
    const f = logFile(); if (!fs.existsSync(f)) return;
    const size = fs.statSync(f).size; if (size < logPos) logPos = 0; if (size === logPos) return;
    const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(size - logPos);
    fs.readSync(fd, buf, 0, buf.length, logPos); fs.closeSync(fd); logPos = size;
    for (const l of buf.toString('utf8').split(/\r?\n/)) if (l.trim()) console.log(`  [post] ${l}`);
  } catch { /* ignore */ }
}

/** Tells the worker no more jobs are coming and waits (max <minutes>) until it has finished every queued job. */
export async function drainPostProcess(minutes = 60): Promise<void> {
  const dir = qDir();
  if (!fs.readdirSync(dir).some((f) => /\.job\.json(\.running)?$/.test(f)) && !workerAlive(dir)) { echoWorkerLog(); return; }
  fs.writeFileSync(path.join(dir, 'CLOSE'), new Date().toISOString());
  ensureWorker(); // jobs left behind by a crashed worker are processed now
  console.log('  waiting for the post-processing worker to finish the queued branches …');
  const until = Date.now() + minutes * 60_000;
  while (Date.now() < until && !fs.existsSync(path.join(dir, 'worker.done'))) {
    await new Promise((r) => setTimeout(r, 5000));
    echoWorkerLog();
    if (!workerAlive(dir) && !fs.existsSync(path.join(dir, 'worker.done'))) { ensureWorker(); }
  }
  echoWorkerLog();
  console.log(fs.existsSync(path.join(dir, 'worker.done')) ? '  post-processing finished' : `  post-processing still running after ${minutes} min — it continues in the background (log: ${logFile()})`);
}
