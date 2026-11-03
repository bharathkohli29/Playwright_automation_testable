import { spawnSync } from 'child_process';
import { ensureEksSignedIn } from './eksLogin';

/**
 * One command that prepares and checks the QA EKS read-only access:   npm run eks:setup
 *   1. aws CLI and kubectl are installed
 *   2. the AWS profile qa-eks-ro exists (created from EKS_SSO_START_URL / EKS_SSO_REGION in .env when it does not)
 *   3. you are signed in (if not, it starts `aws sso login --profile qa-eks-ro`: YOU sign in in the browser; no password is ever stored or typed by the script)
 *   4. the cluster is ACTIVE and this PC's public IP is allowed
 *   5. kubectl context qa-eks-ro exists, and what the role may read (namespaces, pods, pod logs)
 * Every step prints OK / FAILED with what to do. Read-only: nothing on the cluster is changed. Never throws into a run.
 */
const PROFILE = (process.env.EKS_AWS_PROFILE || 'qa-eks-ro').trim();
const REGION = (process.env.EKS_REGION || 'us-east-2').trim(); // always passed explicitly (an old profile once had the typo us-east-32)
const CLUSTER = (process.env.EKS_CLUSTER_NAME || 'qa-eks').trim();
const ACCOUNT = (process.env.S3_AWS_ACCOUNT || '759498976252').trim(), ROLE = (process.env.S3_AWS_ROLE || 'QA-S3-Readonly').trim(); // the QA account and role of the S3 keys; override only if they change
const AWS = (process.env.EKS_AWS_CLI || 'aws').trim(), KUBECTL = (process.env.EKS_KUBECTL || 'kubectl').trim();
const WIN = process.platform === 'win32';

function run(cmd: string, args: string[], inherit = false): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: WIN, stdio: inherit ? 'inherit' : 'pipe', timeout: inherit ? 5 * 60_000 : 45_000, env: { ...process.env, AWS_PAGER: '' } });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0 && !r.error, out: r.error ? String(r.error.message) : out };
}
let bad = 0;
const ok = (m: string) => console.log(`  ✅ ${m}`);
const fail = (m: string, fix: string) => { bad++; console.log(`  ❌ ${m}\n     → ${fix}`); };
const first = (s: string) => s.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 220);

async function main() {
  console.log(`\nQA EKS access check — profile ${PROFILE}, cluster ${CLUSTER}, region ${REGION}\n`);

  // 1. tools
  const a = run(AWS, ['--version']); a.ok ? ok(`aws CLI: ${first(a.out)}`) : fail('aws CLI not found', 'install AWS CLI v2, or set EKS_AWS_CLI=<full path> in .env');
  const k = run(KUBECTL, ['version', '--client']); k.ok ? ok(`kubectl: ${first(k.out).slice(0, 80)}`) : fail('kubectl not found', 'install kubectl, or set EKS_KUBECTL=<full path> in .env');
  if (!a.ok) return;

  // 2. profile
  const has = run(AWS, ['configure', 'get', 'region', '--profile', PROFILE]);
  const hasSso = run(AWS, ['configure', 'get', 'sso_account_id', '--profile', PROFILE]).ok || run(AWS, ['configure', 'get', 'sso_session', '--profile', PROFILE]).ok;
  if (hasSso) {
    ok(`profile ${PROFILE} exists`);
    if (has.ok && has.out && has.out !== REGION) { run(AWS, ['configure', 'set', 'region', REGION, '--profile', PROFILE]); ok(`profile region was "${has.out}", set to ${REGION}`); }
  } else if ((process.env.EKS_SSO_START_URL || '').trim()) {
    const set = (key: string, v: string) => run(AWS, ['configure', 'set', key, v, '--profile', PROFILE]);
    set('sso_start_url', process.env.EKS_SSO_START_URL!.trim()); set('sso_region', (process.env.EKS_SSO_REGION || REGION).trim());
    set('sso_account_id', ACCOUNT); set('sso_role_name', ROLE); set('region', REGION); set('output', 'json');
    ok(`profile ${PROFILE} created (account ${ACCOUNT}, role ${ROLE})`);
  } else fail(`profile ${PROFILE} does not exist`, 'put EKS_SSO_START_URL=<the AWS access portal URL from the setup page> (and EKS_SSO_REGION) in .env and run again, or follow the steps in qa-eks-readonly-setup.html');

  // 3. signed in?
  let id = run(AWS, ['sts', 'get-caller-identity', '--profile', PROFILE, '--region', REGION, '--output', 'json']);
  if (!id.ok && hasSso !== false) {
    console.log('  … not signed in (or the sign-in expired): starting the browser sign-in — sign in there, this window waits');
    await ensureEksSignedIn({ force: true });
    id = run(AWS, ['sts', 'get-caller-identity', '--profile', PROFILE, '--region', REGION, '--output', 'json']);
  }
  if (id.ok) { let arn = ''; try { arn = JSON.parse(id.out).Arn || ''; } catch { /* ignore */ } ok(`signed in as ${arn.split('/').slice(-2).join('/') || 'the QA role'}`); }
  else { fail('not signed in', `run: aws sso login --profile ${PROFILE}   (${first(id.out)})`); return; }

  // 4. cluster + IP allowlist
  const cl = run(AWS, ['eks', 'describe-cluster', '--name', CLUSTER, '--region', REGION, '--profile', PROFILE, '--output', 'json']);
  let cidrs: string[] = [];
  if (cl.ok) {
    try { const c = JSON.parse(cl.out).cluster; cidrs = c.resourcesVpcConfig?.publicAccessCidrs || []; c.status === 'ACTIVE' ? ok(`cluster ${CLUSTER} is ACTIVE`) : fail(`cluster ${CLUSTER} status is ${c.status}`, 'the cluster may be rebuilding or destroyed (it is removed after 30 min without traffic); ask an admin'); } catch { fail('cluster answer could not be read', first(cl.out)); }
  } else fail(`cluster ${CLUSTER} not found or not readable`, first(cl.out));
  let myIp = ''; try { myIp = (await (await fetch('https://checkip.amazonaws.com', { signal: AbortSignal.timeout(8000) })).text()).trim(); } catch { /* offline */ }
  if (myIp) {
    const allowed = !cidrs.length || cidrs.some((c) => c === '0.0.0.0/0' || c === `${myIp}/32`);
    allowed ? ok(`public IP ${myIp} ${cidrs.includes('0.0.0.0/0') ? '(cluster is open to all IPs)' : 'is on the cluster allow-list'}`)
      : fail(`public IP ${myIp} is NOT on the cluster allow-list (${cidrs.length} entries)`, 'ask an admin (Vinod or Shihaf) to add this IP; kubectl will time out until then');
  }

  // 5. kubeconfig + permissions
  const kc = run(AWS, ['eks', 'update-kubeconfig', '--name', CLUSTER, '--region', REGION, '--profile', PROFILE, '--alias', PROFILE]);
  kc.ok ? ok(`kubectl context "${PROFILE}" written`) : fail('kubeconfig could not be written', first(kc.out));
  const ns = run(KUBECTL, ['--context', PROFILE, 'get', 'ns', '--no-headers', '-o', 'custom-columns=N:.metadata.name', '--request-timeout=20s']);
  if (!ns.ok) { fail('kubectl cannot list namespaces', /timeout|deadline/i.test(ns.out) ? 'timeout: usually the IP allow-list (see above)' : first(ns.out)); return; }
  const names = ns.out.split('\n').map((s) => s.trim()).filter((n) => /wb-fabric|whitebox|testable-qa/.test(n));
  ok(`kubectl works; platform namespaces: ${names.join(', ') || '(none matched)'}`);
  for (const n of names.filter((x) => /cell-001|exe/.test(x)).slice(0, 4)) {
    const can = (what: string[]) => run(KUBECTL, ['--context', PROFILE, 'auth', 'can-i', ...what, '-n', n]).out.startsWith('yes');
    const pods = can(['list', 'pods']), logs = can(['get', 'pods', '--subresource=log']);
    (pods && logs ? ok : (m: string) => fail(m, 'ask an admin for read access to pods and pod logs in this namespace'))(`${n}: list pods ${pods ? 'yes' : 'NO'} · read pod logs ${logs ? 'yes' : 'NO'}`);
  }
  console.log(bad ? `\n${bad} problem(s) above. The test runs are not affected: the EKS analysis is simply skipped until this is fixed.\n` : '\nAll good — the EKS log analysis can run. Set EKS_AUTO=on in .env to use it in every run.\n');
}
main().catch((e) => { console.log(`eks:setup stopped: ${e instanceof Error ? e.message : e}`); }).finally(() => process.exit(bad ? 1 : 0));
