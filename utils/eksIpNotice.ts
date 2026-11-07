import { spawnSync, spawn } from 'child_process';
import './env';

/**
 * QA EKS live capture works only from an IP address that is on the cluster endpoint's allow-list (publicAccessCidrs). When this PC's IP is not on it, kubectl
 * simply times out and nothing says why. This module finds out (read only) and SHOWS the current public IP, in the terminal and as a desktop popup (also in an IDE),
 * with the request text to send to whoever manages the allow-list, and copies the IP to the clipboard.
 *   npm run eks:ip        same check by hand
 * Settings: EKS_IP_POPUP=off turns the popup off (it is also off in CI). EKS_CLUSTER_NAME, EKS_REGION, EKS_AWS_PROFILE as for the other EKS tools. Never throws.
 */
const clean = (s?: string) => (s || '').trim().replace(/^["']|["']$/g, '');
const PROFILE = () => clean(process.env.EKS_AWS_PROFILE) || 'qa-eks-ro';
const REGION = () => clean(process.env.EKS_REGION) || 'us-east-2';
const CLUSTER = () => clean(process.env.EKS_CLUSTER_NAME) || 'qa-eks';
const AWS = () => clean(process.env.EKS_AWS_CLI) || 'aws';
const WIN = process.platform === 'win32';

export interface IpReport { ip: string; cidrs: string[] | null; allowed: boolean | null; note: string }

const toInt = (ip: string): number | null => { const p = ip.split('.').map(Number); return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3] : null; };
/** true when the IPv4 address is inside one of the CIDR blocks (a block without a slash is a single address) */
export function ipInCidrs(ip: string, cidrs: string[]): boolean {
  const a = toInt(ip); if (a === null) return false;
  return cidrs.some((c) => { const [net, bitsRaw] = c.trim().split('/'); const n = toInt(net); const bits = bitsRaw === undefined ? 32 : Number(bitsRaw); if (n === null || !(bits >= 0 && bits <= 32)) return false; const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0; return ((a & mask) >>> 0) === ((n & mask) >>> 0); });
}

export async function publicIp(): Promise<string> {
  for (const u of ['https://checkip.amazonaws.com', 'https://api.ipify.org']) { try { const t = (await (await fetch(u, { signal: AbortSignal.timeout(8000) })).text()).trim(); if (toInt(t) !== null) return t; } catch { /* next */ } }
  return '';
}

export async function eksIpReport(): Promise<IpReport> {
  const ip = await publicIp();
  const r = spawnSync(AWS(), ['eks', 'describe-cluster', '--name', CLUSTER(), '--region', REGION(), '--profile', PROFILE(), '--output', 'json'], { encoding: 'utf8', shell: WIN, timeout: 60_000, env: { ...process.env, AWS_PAGER: '' } });
  if (r.status !== 0) return { ip, cidrs: null, allowed: null, note: 'the allow-list could not be read (sign in first: aws sso login --profile ' + PROFILE() + ')' };
  try {
    const v = JSON.parse(r.stdout).cluster?.resourcesVpcConfig || {}; const cidrs: string[] = v.publicAccessCidrs || [];
    if (v.endpointPublicAccess === false) return { ip, cidrs, allowed: null, note: 'the cluster endpoint is private (VPN needed), the IP allow-list does not apply' };
    return { ip, cidrs, allowed: ip ? ipInCidrs(ip, cidrs) : null, note: cidrs.includes('0.0.0.0/0') ? 'the cluster is open to all IPs' : `${cidrs.length} address block(s) on the allow-list` };
  } catch { return { ip, cidrs: null, allowed: null, note: 'the allow-list answer could not be read' }; }
}

/** the text to send to whoever manages the allow-list */
export function requestText(r: IpReport): string {
  return `Please add this IP to the allow-list (public access CIDRs) of the QA EKS cluster "${CLUSTER()}" (${REGION()}) so the test automation can read pod logs: ${r.ip}/32`;
}

function popup(title: string, text: string): void {
  if (!WIN || /^(off|no|0|false)$/i.test(clean(process.env.EKS_IP_POPUP)) || process.env.CI) return;
  const q = (s: string) => s.replace(/'/g, "''");
  const ps = `Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show('${q(text)}','${q(title)}','OK','Warning')`;
  try { const c = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: false }); c.unref(); } catch { /* the terminal message is enough */ }
}
function toClipboard(text: string): boolean {
  try { if (WIN) { const r = spawnSync('powershell', ['-NoProfile', '-Command', `Set-Clipboard -Value '${text.replace(/'/g, "''")}'`], { timeout: 15_000, windowsHide: true }); return r.status === 0; } } catch { /* ignore */ }
  return false;
}

/** prints (and pops up) the message when this PC's IP is NOT on the allow-list; returns true when it did */
export async function announceIfBlocked(say: (m: string) => void = console.log, known?: IpReport): Promise<boolean> {
  const r = known || (await eksIpReport());
  if (r.allowed !== false || !r.ip) return false;
  const text = requestText(r);
  const copied = toClipboard(r.ip);
  say('');
  say('  ┌─ QA EKS: this PC\'s IP is NOT on the cluster allow-list ───────────────────────');
  say(`  │  Your public IP:  ${r.ip}${copied ? '   (copied to the clipboard)' : ''}`);
  say(`  │  Allow-list:      ${r.note}`);
  say('  │  Live pod logs cannot be captured from this IP, so the RCA Report would have no EKS evidence.');
  say('  │  Send this to the person who manages the cluster allow-list, then start again:');
  say(`  │  "${text}"`);
  say('  └──────────────────────────────────────────────────────────────────────────────');
  say('');
  popup('QA EKS: your IP is not approved', `Your public IP is ${r.ip}\n\nIt is not on the QA EKS cluster allow-list, so live pod logs cannot be captured.\n\nAsk the cluster admin to add ${r.ip}/32 (the IP is copied to your clipboard).\n\nThen start the script again.`);
  return true;
}

if (require.main === module) {
  eksIpReport().then(async (r) => {
    console.log(`  public IP: ${r.ip || '(could not be found: offline?)'}   ${r.note}`);
    if (r.allowed === true) console.log('  ✔ this IP is on the allow-list');
    else if (r.allowed === false) await announceIfBlocked(console.log, r);
    else console.log('  ! could not tell whether this IP is on the allow-list');
    process.exit(r.allowed === false ? 1 : 0);
  });
}
