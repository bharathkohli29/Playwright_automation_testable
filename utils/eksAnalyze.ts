import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { eksReportExists, eksReportFiles } from './eksMentor';
import { ollamaUrl, isLocalOllama } from './ollamaHost';

/**
 * Copies the QA EKS analysis reports (Analysis_Report_<tool>-<run>.pdf and <tool>-<run>.md) of the defective tools into the branch folder
 * (<branch folder>/qa-eks-analysis/), so the SharePoint upload of the branch folder takes them along. Works for reports made by the automatic
 * run and for reports made by hand. Never throws; returns the number of files copied.
 */
export function copyEksReports(tools: string[], runId: string, branchDir: string): number {
  let n = 0;
  try {
    const dest = path.join(branchDir, 'qa-eks-analysis');
    for (const t of [...new Set(tools)]) for (const f of eksReportFiles(t, runId)) {
      fs.mkdirSync(dest, { recursive: true }); fs.copyFileSync(f, path.join(dest, path.basename(f))); n++;
    }
    if (n) console.log(`  QA EKS analysis: ${n} report file(s) copied to ${path.join(path.basename(branchDir), 'qa-eks-analysis')} (uploaded to SharePoint with the branch folder)`);
  } catch (e) { console.log(`  QA EKS analysis: reports could not be copied (${e instanceof Error ? e.message : e})`); }
  return n;
}

/**
 * Runs the QA EKS Mentor's analyze.py by itself for the platform defects of a branch, so nobody has to sign in and start it by hand.
 * It is called from bugReport.ts just before the bug drafts are written and writes the ready reports (<tool>-<run id 8 chars>.md)
 * that the bug drafts then print. Never throws and never stops the run: when anything is missing it prints one line and goes on.
 *
 * Credentials (never in the repository; keep them in .env, which git ignores):
 *   EKS_AWS_ACCESS_KEY_ID, EKS_AWS_SECRET_ACCESS_KEY (and EKS_AWS_SESSION_TOKEN for temporary keys): the team's read-only key. Passed to
 *     analyze.py / kubectl only. The S3 keys (AWS_ACCESS_KEY_ID ...) are NOT used for the cluster.
 *   without them: the AWS profile EKS_AWS_PROFILE (default qa-eks-ro), i.e. your own `aws sso login --profile qa-eks-ro` session.
 * Always on. Only EKS_AUTO=off in .env switches it off. Ollama is started by the script when it is down (ensureOllama).
 * Other settings: EKS_CLUSTER_NAME (qa-eks), EKS_REGION (us-east-2), EKS_PYTHON (python), EKS_ANALYZE_MIN (8 minutes at most per branch).
 */
const ROOT = path.join(__dirname, '..');
const MENTOR = path.join(ROOT, 'qa-eks-mentor');
const CONTEXT = 'qa-eks-ro';
const clean = (s?: string) => (s || '').trim().replace(/^["']|["']$/g, '');
const NAMESPACE = clean(process.env.EKS_NAMESPACE) || 'wb-fabric-us-01-cell-001'; // the recreated QA cluster renamed whitebox-cell-001
const KUBECTL = () => clean(process.env.EKS_KUBECTL) || 'kubectl'; // EKS_KUBECTL / EKS_AWS_CLI: full path when kubectl or aws is not on the PATH
const AWSCLI = () => clean(process.env.EKS_AWS_CLI) || 'aws';
const haveKeys = () => !!(clean(process.env.EKS_AWS_ACCESS_KEY_ID) && clean(process.env.EKS_AWS_SECRET_ACCESS_KEY));

/** The analysis is ALWAYS on. The only way to switch it off is EKS_AUTO=off in .env. */
export function eksAutoEnabled(): boolean {
  return !/^(off|no|0|false)$/i.test(clean(process.env.EKS_AUTO));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ollamaUp = () => fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
const installerRunning = async () => process.platform === 'win32' && /OllamaSetup/i.test((await run('tasklist', ['/FI', 'IMAGENAME eq OllamaSetup.exe', '/NH'], 15_000)).out);

/**
 * Keeps Ollama up for the analysis: when it does not answer, it waits while Ollama's own updater is installing (the server is stopped during that,
 * up to 6 min), and if it is still down it starts `ollama serve` itself (EKS_OLLAMA = full path of ollama when it is not on the PATH). Never throws.
 */
export async function ensureOllama(say: (m: string) => void): Promise<boolean> {
  try {
    if (await ollamaUp()) return true;
    // a SHARED model server (OLLAMA_HOST=http://<other PC>:11434): nothing to start on this PC, it either answers or it does not
    if (!isLocalOllama()) { say(`the shared Ollama at ${ollamaUrl()} does not answer (is that PC on, Ollama running, port 11434 open?): the reports use rule-based summaries`); return false; }
    if (await installerRunning()) {
      say('Ollama is installing an update, waiting for it to finish (up to 6 min) ...');
      for (let i = 0; i < 72 && (await installerRunning()); i++) await sleep(5000);
      for (let i = 0; i < 12 && !(await ollamaUp()); i++) await sleep(5000); // the app restarts the server by itself after the update
      if (await ollamaUp()) { say('Ollama is up again after its update'); return true; }
    }
    say('Ollama is not running, starting it (ollama serve) ...');
    const child = spawn(clean(process.env.EKS_OLLAMA) || 'ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    child.on('error', () => { /* checked below */ }); child.unref();
    for (let i = 0; i < 20; i++) { await sleep(1500); if (await ollamaUp()) { say('Ollama started'); return true; } }
  } catch { /* fall through */ }
  say('Ollama could not be started: the reports will use rule-based summaries (start it by hand: ollama serve)');
  return false;
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

/** the kubectl context qa-eks-ro (analyze.py uses the current context). Created with the key when it is missing on this PC; refresh = true rewrites it (the cluster was recreated with a new address). */
async function ensureContext(refresh = false): Promise<boolean> {
  const have = await run(KUBECTL(), ['config', 'get-contexts', '-o', 'name'], 20_000);
  if (!refresh && have.code === 0 && have.out.split(/\r?\n/).map((s) => s.trim()).includes(CONTEXT)) return true;
  if (!haveKeys()) return false;
  const name = clean(process.env.EKS_CLUSTER_NAME) || 'qa-eks';
  const r = await run(AWSCLI(), ['eks', 'update-kubeconfig', '--name', name, '--region', clean(process.env.EKS_REGION) || 'us-east-2', '--alias', CONTEXT], 60_000);
  return r.code === 0;
}

/** kubectl context + a ping of the cell namespace (refreshes a stale cluster address when the key is set). Says why and returns false when the cluster cannot be used. */
export async function eksClusterReady(say: (m: string) => void): Promise<boolean> {
    if (!(await ensureContext())) { say(`kubectl context ${CONTEXT} is missing and could not be created (set EKS_AWS_ACCESS_KEY_ID / EKS_AWS_SECRET_ACCESS_KEY, or run aws eks update-kubeconfig), skipped`); return false; }
    const pingNs = () => run(KUBECTL(), ['--context', CONTEXT, 'get', 'ns', NAMESPACE, '--request-timeout=15s', '-o', 'name'], 45_000);
    let ping = await pingNs();
    // a recreated cluster has a new address while the saved context still holds the old one: rewrite the context from AWS and try once more
    if (ping.code !== 0 && haveKeys() && (await ensureContext(true))) { say('the saved cluster address did not answer, refreshed it from AWS'); ping = await pingNs(); }
    if (ping.code !== 0) { say(`the QA EKS cluster is not reachable from this PC (${haveKeys() ? 'check the key and the network / VPN' : 'sign in with: aws sso login --profile ' + (clean(process.env.EKS_AWS_PROFILE) || CONTEXT) + ' --no-browser, or check the network / VPN'}), skipped`); return false; }
  return true;
}

/** what the log collector needs: the kubectl command, context and namespace of the QA EKS cell */
export const eksKubectl = () => KUBECTL();
export const eksContext = () => CONTEXT;
export const eksNamespace = () => NAMESPACE;

export async function ensureEksReports(tools: string[], c: { runId: string; branch: string; repo: string; version: string; outDir: string; notes?: Record<string, string> }): Promise<void> {
  try {
    const say = (m: string) => console.log(`  QA EKS analysis [${new Date().toTimeString().slice(0, 8)}]: ${m}`); // one timed line per decision, so it is clear when the model is (not) used
    if (!eksAutoEnabled()) return say(`off, the model is not used (set EKS_AUTO=on, or the EKS key, in .env) · defective tools: ${[...new Set(tools)].join(', ')}`);
    const missing = [...new Set(tools)].filter((t) => !eksReportExists(t, c.runId));
    if (!missing.length) return say(`reports already exist for ${[...new Set(tools)].join(', ')}, the model is not needed`);
    if (!fs.existsSync(path.join(MENTOR, 'analyze.py'))) return say('qa-eks-mentor/analyze.py not found, skipped');
    if (!(await eksClusterReady(say))) return;
    fs.mkdirSync(c.outDir, { recursive: true });
    const facts = path.resolve(c.outDir, 'eks-facts.md'); // absolute: analyze.py runs in its own folder
    fs.writeFileSync(facts, missing.map((t) => `Tool: ${t} (${c.version}). Repo ${c.repo || '(unknown)'}, branch ${c.branch}. Run ${c.runId}. Observed: ${(c.notes?.[t] || 'tool did not run').replace(/\s+/g, ' ')}`).join('\n') + '\n');
    const maxMs = (Number(process.env.EKS_ANALYZE_MIN) || 8) * 60_000;
    await ensureOllama(say); // makes sure the model server is up before the analysis starts
    say(`STARTED for ${missing.length} defective tool(s): ${missing.join(', ')} · reads the cluster logs, then the model ${process.env.EKS_MODEL || 'qa-eks-mentor-trained'} writes the summary (up to ${Math.round(maxMs / 60_000)} min) ...`);
    const t0 = Date.now();
    const log = path.join(c.outDir, 'eks-analyze.log');
    const code = await new Promise<number>((resolve) => {
      let fd = -1; try { fd = fs.openSync(log, 'w'); } catch { /* no log file */ }
      const child = spawn(clean(process.env.EKS_PYTHON) || 'python', ['analyze.py', '--run-id', c.runId, '--tool', missing.join(','), '--facts', facts], { cwd: MENTOR, env: eksEnv(), windowsHide: true, stdio: ['ignore', fd >= 0 ? fd : 'ignore', fd >= 0 ? fd : 'ignore'] });
      const t = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(124); }, maxMs);
      child.on('error', () => { clearTimeout(t); resolve(127); });
      child.on('close', (k) => { clearTimeout(t); resolve(k ?? 1); });
    });
    const done = missing.filter((t) => eksReportExists(t, c.runId));
    let byModel = 0; try { byModel = (fs.readFileSync(log, 'utf8').match(/summary by model/g) || []).length; } catch { /* no log */ }
    say(`FINISHED in ${Math.round((Date.now() - t0) / 1000)} s · ${done.length}/${missing.length} report(s) · summary written by the model: ${byModel}, by rules: ${Math.max(0, done.length - byModel)}`);
    say(code === 0 || done.length ? `ready reports: ${done.join(', ') || 'none'}${done.length < missing.length ? ` · ${missing.length - done.length} tool(s) without a report, see ${path.basename(log)}` : ''}` : `analyze.py did not finish (${code === 124 ? 'timed out' : code === 127 ? 'python was not found (EKS_PYTHON)' : 'exit code ' + code}), see ${log}`);
  } catch (e) { console.log(`  QA EKS analysis skipped: ${e instanceof Error ? e.message : e}`); }
}
