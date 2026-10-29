import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { eksReportExists } from './eksMentor';

/**
 * Runs the QA EKS Mentor's analyze.py by itself for the platform defects of a branch, so nobody has to sign in and start it by hand.
 * It is called from bugReport.ts just before the bug drafts are written and writes the ready reports (<tool>-<run id 8 chars>.md)
 * that the bug drafts then print. Never throws and never stops the run: when anything is missing it prints one line and goes on.
 *
 * Credentials (never in the repository; keep them in .env, which git ignores):
 *   EKS_AWS_ACCESS_KEY_ID, EKS_AWS_SECRET_ACCESS_KEY (and EKS_AWS_SESSION_TOKEN for temporary keys): the team's read-only key. Passed to
 *     analyze.py / kubectl only. The S3 keys (AWS_ACCESS_KEY_ID ...) are NOT used for the cluster.
 *   without them: the AWS profile EKS_AWS_PROFILE (default qa-eks-ro), i.e. your own `aws sso login --profile qa-eks-ro` session.
 * On: EKS_AUTO=on, or EKS_AWS_ACCESS_KEY_ID + EKS_AWS_SECRET_ACCESS_KEY set. Off: EKS_AUTO=off. Default without keys: off.
 * Other settings: EKS_CLUSTER_NAME (qa-eks), EKS_REGION (us-east-2), EKS_PYTHON (python), EKS_ANALYZE_MIN (8 minutes at most per branch).
 */
const ROOT = path.join(__dirname, '..');
const MENTOR = path.join(ROOT, 'qa-eks-mentor');
const CONTEXT = 'qa-eks-ro';
const NAMESPACE = 'whitebox-cell-001';
const clean = (s?: string) => (s || '').trim().replace(/^["']|["']$/g, '');
const KUBECTL = () => clean(process.env.EKS_KUBECTL) || 'kubectl'; // EKS_KUBECTL / EKS_AWS_CLI: full path when kubectl or aws is not on the PATH
const AWSCLI = () => clean(process.env.EKS_AWS_CLI) || 'aws';
const haveKeys = () => !!(clean(process.env.EKS_AWS_ACCESS_KEY_ID) && clean(process.env.EKS_AWS_SECRET_ACCESS_KEY));

export function eksAutoEnabled(): boolean {
  const v = clean(process.env.EKS_AUTO);
  if (/^(off|no|0|false)$/i.test(v)) return false;
  return /^(on|yes|1|true)$/i.test(v) || haveKeys();
}

/** Environment for analyze.py and kubectl: the cluster key (or the profile), never the S3 key that .env holds for the S3 role. */
export function eksEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE']) delete e[k];
  if (haveKeys()) {
    e.AWS_ACCESS_KEY_ID = clean(process.env.EKS_AWS_ACCESS_KEY_ID); e.AWS_SECRET_ACCESS_KEY = clean(process.env.EKS_AWS_SECRET_ACCESS_KEY);
    if (clean(process.env.EKS_AWS_SESSION_TOKEN)) e.AWS_SESSION_TOKEN = clean(process.env.EKS_AWS_SESSION_TOKEN);
  } else e.AWS_PROFILE = clean(process.env.EKS_AWS_PROFILE) || CONTEXT;
  e.AWS_REGION = e.AWS_DEFAULT_REGION = clean(process.env.EKS_REGION) || 'us-east-2';
  e.PYTHONIOENCODING = 'utf-8';
  return e;
}

const run = (cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> => new Promise((resolve) => {
  try {
    execFile(cmd, args, { env: eksEnv(), timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, shell: process.platform === 'win32' }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code === 'ENOENT' ? 127 : Number((err as { code?: number }).code) || 1) : 0, out: `${stdout || ''}${stderr || ''}` });
    });
  } catch (e) { resolve({ code: 127, out: String(e) }); }
});

/** the kubectl context qa-eks-ro (analyze.py uses the current context). Created with the key when it is missing on this PC. */
async function ensureContext(): Promise<boolean> {
  const have = await run(KUBECTL(), ['config', 'get-contexts', '-o', 'name'], 20_000);
  if (have.code === 0 && have.out.split(/\r?\n/).map((s) => s.trim()).includes(CONTEXT)) return true;
  if (!haveKeys()) return false;
  const name = clean(process.env.EKS_CLUSTER_NAME) || 'qa-eks';
  const r = await run(AWSCLI(), ['eks', 'update-kubeconfig', '--name', name, '--region', clean(process.env.EKS_REGION) || 'us-east-2', '--alias', CONTEXT], 60_000);
  return r.code === 0;
}

export async function ensureEksReports(tools: string[], c: { runId: string; branch: string; repo: string; version: string; outDir: string; notes?: Record<string, string> }): Promise<void> {
  try {
    if (!eksAutoEnabled()) return;
    const missing = [...new Set(tools)].filter((t) => !eksReportExists(t, c.runId));
    if (!missing.length) return;
    const say = (m: string) => console.log(`  QA EKS analysis: ${m}`);
    if (!fs.existsSync(path.join(MENTOR, 'analyze.py'))) return say('qa-eks-mentor/analyze.py not found, skipped');
    if (!(await ensureContext())) return say(`kubectl context ${CONTEXT} is missing and could not be created (set EKS_AWS_ACCESS_KEY_ID / EKS_AWS_SECRET_ACCESS_KEY, or run aws eks update-kubeconfig), skipped`);
    const ping = await run(KUBECTL(), ['--context', CONTEXT, 'get', 'ns', NAMESPACE, '--request-timeout=15s', '-o', 'name'], 45_000);
    if (ping.code !== 0) return say(`the QA EKS cluster is not reachable from this PC (${haveKeys() ? 'check the key and the network / VPN' : 'sign in with: aws sso login --profile ' + (clean(process.env.EKS_AWS_PROFILE) || CONTEXT) + ' --no-browser, or check the network / VPN'}), skipped`);
    fs.mkdirSync(c.outDir, { recursive: true });
    const facts = path.join(c.outDir, 'eks-facts.md');
    fs.writeFileSync(facts, missing.map((t) => `Tool: ${t} (${c.version}). Repo ${c.repo || '(unknown)'}, branch ${c.branch}. Run ${c.runId}. Observed: ${(c.notes?.[t] || 'tool did not run').replace(/\s+/g, ' ')}`).join('\n') + '\n');
    const maxMs = (Number(process.env.EKS_ANALYZE_MIN) || 8) * 60_000;
    say(`reading the cluster logs of ${missing.join(', ')} (up to ${Math.round(maxMs / 60_000)} min) ...`);
    const log = path.join(c.outDir, 'eks-analyze.log');
    const code = await new Promise<number>((resolve) => {
      let fd = -1; try { fd = fs.openSync(log, 'w'); } catch { /* no log file */ }
      const child = spawn(clean(process.env.EKS_PYTHON) || 'python', ['analyze.py', '--run-id', c.runId, '--tool', missing.join(','), '--facts', facts], { cwd: MENTOR, env: eksEnv(), windowsHide: true, stdio: ['ignore', fd >= 0 ? fd : 'ignore', fd >= 0 ? fd : 'ignore'] });
      const t = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(124); }, maxMs);
      child.on('error', () => { clearTimeout(t); resolve(127); });
      child.on('close', (k) => { clearTimeout(t); resolve(k ?? 1); });
    });
    const done = missing.filter((t) => eksReportExists(t, c.runId));
    say(code === 0 || done.length ? `ready reports: ${done.join(', ') || 'none'}${done.length < missing.length ? ` (no report for ${missing.filter((t) => !done.includes(t)).join(', ')}, see ${path.basename(log)})` : ''}` : `analyze.py did not finish (${code === 124 ? 'timed out' : code === 127 ? 'python was not found (EKS_PYTHON)' : 'exit code ' + code}), see ${log}`);
  } catch (e) { console.log(`  QA EKS analysis skipped: ${e instanceof Error ? e.message : e}`); }
}
