import * as fs from 'fs';
import * as path from 'path';
import './env';
import { runPostProcess } from './postprocess';
import type { PostJob } from './postprocess';

/**
 * SAFETY NET: a branch is analysed even when the script itself stopped (crash, Ctrl+C, power cut, the machine slept) before it could hand the branch over.
 *   npm run post:sweep [-- --hours 48] [--dry-run]
 * A branch folder counts as left behind when the flow started in it (repo-details.json or the first screenshot), no post-processing result exists
 * (postprocess.json missing, or a "running" one that nobody has touched for 30 minutes), nothing in it changed for 20 minutes, it is not older than the window
 * (default 48 hours) and the run's summary.json has no failed / blocked entry for it (those were handed over when they failed).
 * For each one the normal worker steps run (S3, cluster logs, platform code, RCA Report, SharePoint, Teams), with the failure text "the script stopped before this branch finished".
 * It starts by itself, detached, when the script starts (see startGate.ts); POST_SWEEP=off turns it off. Never throws.
 */
const ROOT = path.resolve(__dirname, '..');
const PREFIX: Record<string, string> = { PY: 'Python_Corpus_Tool_Triggering', JV: 'Java_Corpus_Tool_Triggering', TS: 'TypeScript_Corpus_Tool_Triggering', CS: 'CSharp_Corpus_Tool_Triggering', JS: 'JavaScript_Corpus_Tool_Triggering' };

export function repoFor(branch: string, builds: string[]): string {
  for (const u of builds) { const m = /github\.com\/([^/]+\/[^/]+)\/tree\/(.+)$/.exec(u); if (m && decodeURIComponent(m[2]) === branch) return m[1]; }
  return `Nandhini-Testable/${PREFIX[branch.slice(0, 2).toUpperCase()] || 'Corpus_Tool_Triggering'}`;
}

const newest = (dir: string, depth = 0): number => {
  let t = 0; try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (depth < 3) t = Math.max(t, newest(p, depth + 1)); } else t = Math.max(t, fs.statSync(p).mtimeMs); } } catch { /* ignore */ }
  return t;
};

export interface Left { branchDir: string; branch: string; failure: string }
/** the branch folders left behind (pure: reads the results folder only) */
export function findLeftBehind(resultsDir: string, hours = 48, now = Date.now()): Left[] {
  const out: Left[] = [];
  let runs: string[] = []; try { runs = fs.readdirSync(resultsDir).filter((d) => /^merge-flow_/.test(d)); } catch { return out; }
  for (const run of runs) {
    const rdir = path.join(resultsDir, run); let summary: Array<{ branch?: string; status?: string }> = []; try { summary = JSON.parse(fs.readFileSync(path.join(rdir, 'summary.json'), 'utf8')); } catch { /* none written: the script stopped */ }
    let branches: string[] = []; try { branches = fs.readdirSync(rdir, { withFileTypes: true }).filter((e) => e.isDirectory() && !/^(evidence|\.postprocess)$/.test(e.name)).map((e) => e.name); } catch { continue; }
    for (const b of branches) {
      const dir = path.join(rdir, b); const started = fs.existsSync(path.join(dir, 'repo-details.json')) || fs.existsSync(path.join(dir, '01_repo_structure.png')); if (!started) continue;
      const t = newest(dir); if (now - t < 20 * 60_000 || now - t > hours * 3600_000) continue;
      const pp = path.join(dir, 'postprocess.json'); let state = ''; try { state = JSON.parse(fs.readFileSync(pp, 'utf8')).state || ''; } catch { /* none */ }
      if (state === 'done' || state === 'failed' || (state && now - fs.statSync(pp).mtimeMs < 30 * 60_000)) continue; // done, or a worker is on it
      const s = summary.find((x) => x.branch === b); if (s && s.status && s.status !== 'passed') continue; // failed branches were handed over when they failed
      out.push({ branchDir: dir, branch: b, failure: s ? '' : 'The script stopped before this branch finished: no result was recorded for it, so the run was analysed afterwards from what was saved.' });
    }
  }
  return out;
}

export async function sweep(opts: { hours?: number; dry?: boolean; max?: number } = {}): Promise<Left[]> {
  const left = findLeftBehind(path.join(ROOT, 'results'), opts.hours ?? (Number(process.env.POST_SWEEP_HOURS) || 48)).slice(0, opts.max ?? 8);
  let builds: string[] = []; try { builds = JSON.parse(fs.readFileSync(path.join(ROOT, 'builds.json'), 'utf8')).branches || []; } catch { /* none */ }
  for (const l of left) {
    console.log(`  sweep: ${l.branch} (${path.basename(path.dirname(l.branchDir))}) was left behind${l.failure ? '' : ' (finished, never post-processed)'}`);
    if (opts.dry) continue;
    const job: PostJob = { branchDir: l.branchDir, branch: l.branch, repo: repoFor(l.branch, builds), minutes: 0, ...(l.failure ? { failure: l.failure } : {}) };
    try { await runPostProcess(job); } catch (e) { console.log(`  sweep: ${l.branch} failed (${e instanceof Error ? e.message : e}); the next one goes on`); }
  }
  if (!left.length) console.log('  sweep: no branch was left behind');
  return left;
}

if (require.main === module) {
  if (/^(0|no|off|false)$/i.test((process.env.POST_SWEEP || '').trim())) { console.log('  sweep: off (POST_SWEEP=off)'); process.exit(0); }
  const a = process.argv.slice(2); const h = a.indexOf('--hours');
  sweep({ hours: h >= 0 ? Number(a[h + 1]) : undefined, dry: a.includes('--dry-run') }).then(() => process.exit(0), (e) => { console.log(`  sweep failed: ${e instanceof Error ? e.message : e}`); process.exit(0); });
}
