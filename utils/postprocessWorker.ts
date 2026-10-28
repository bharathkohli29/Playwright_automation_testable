// Background worker (started detached by utils/postprocessQueue.ts, run with tsx): one job after the other, never in parallel.
// Usage: tsx utils/postprocessWorker.ts <run folder>/.postprocess
// Ends when the site test has written CLOSE and no job is left, or after 3 hours without any job (orphan protection).
import * as fs from 'fs';
import * as path from 'path';
import { runPostProcess, PostJob } from './postprocess';

const dir = path.resolve(process.argv[2] || '');
const pidFile = path.join(dir, 'worker.pid');
const IDLE_MAX_MS = 3 * 60 * 60_000;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return !!e && (e as NodeJS.ErrnoException).code === 'EPERM'; } };
// worker.pid is written by the starter (the tsx launcher = this process's parent); anything else that is alive is another worker
const other = (() => { try { const p = Number(fs.readFileSync(pidFile, 'utf8')); return !!p && p !== process.pid && p !== process.ppid && alive(p); } catch { return false; } })();

async function main() {
  if (!dir || !fs.existsSync(dir)) { console.log(`post-processing worker: folder not found: ${dir}`); return; }
  if (other) return; // another worker already serves this run
  // a job the previous worker was working on when it died is queued again
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.job.json.running'))) fs.renameSync(path.join(dir, f), path.join(dir, f.replace(/\.running$/, '')));
  console.log(`post-processing worker started (pid ${process.pid})`);
  let lastWork = Date.now();
  for (;;) {
    const next = fs.readdirSync(dir).filter((x) => x.endsWith('.job.json')).sort()[0];
    if (next) {
      const running = path.join(dir, `${next}.running`);
      fs.renameSync(path.join(dir, next), running);
      try {
        const job: PostJob = JSON.parse(fs.readFileSync(running, 'utf8'));
        await runPostProcess(job);
        fs.renameSync(running, path.join(dir, next.replace(/\.job\.json$/, '.done.json')));
      } catch (e) {
        console.log(`post-processing job ${next} crashed: ${e instanceof Error ? e.message : e}`);
        try { fs.renameSync(running, path.join(dir, next.replace(/\.job\.json$/, '.failed.json'))); } catch { /* ignore */ }
      }
      lastWork = Date.now();
      continue;
    }
    if (fs.existsSync(path.join(dir, 'CLOSE')) || Date.now() - lastWork > IDLE_MAX_MS) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  fs.writeFileSync(path.join(dir, 'worker.done'), new Date().toISOString());
  try { fs.rmSync(pidFile, { force: true }); } catch { /* ignore */ }
  console.log('post-processing worker finished');
}
main().catch((e) => { console.log(`post-processing worker error: ${e instanceof Error ? e.stack || e.message : e}`); process.exit(1); });
