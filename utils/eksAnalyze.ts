import { execFile } from 'child_process';

/**
 * Access to the QA EKS cluster for the live log capture (eksCollector.ts), the re-check (eksHistory.ts) and the pre-flight check.
 *
 * Credentials (never in the repository; keep them in .env, which git ignores):
 *   EKS_AWS_ACCESS_KEY_ID, EKS_AWS_SECRET_ACCESS_KEY (and EKS_AWS_SESSION_TOKEN for temporary keys): the team's read-only key. Passed to
 *     kubectl only. The S3 keys (AWS_ACCESS_KEY_ID ...) are NOT used for the cluster.
 *   without them: the AWS profile EKS_AWS_PROFILE (default qa-eks-ro), i.e. your own `aws sso login --profile qa-eks-ro` session.
 * Always on. Only EKS_AUTO=off in .env switches it off.
 * Other settings: EKS_CLUSTER_NAME (qa-eks), EKS_REGION (us-east-2), EKS_NAMESPACE, EKS_KUBECTL / EKS_AWS_CLI (full paths when not on the PATH).
 */
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
