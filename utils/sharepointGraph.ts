import * as fs from 'fs';
import * as path from 'path';

/**
 * Permanent SharePoint upload through Microsoft Graph (no OneDrive shortcut, no local path, no daily .env edit).
 * Every run uploads the finished branch folder to   <SP_URL folder>/<DD-MM-YYYY>/<branch>   (a repeat run the same day: <branch>_RUN2, _RUN3 …).
 *
 * One-time setup (an Entra admin, once for the team): register an app, "Mobile and desktop applications" platform, allow public client flows,
 * delegated Microsoft Graph permission  Files.ReadWrite.All.  Put its Application (client) ID and the Tenant ID in .env (SP_CLIENT_ID, SP_TENANT_ID).
 * One-time per developer:  npm run sp:login   (prints a code to type at https://microsoft.com/devicelogin). The token is cached in .auth/ and refreshes by itself.
 * SP_CLIENT_ID / SP_TENANT_ID empty = this module is off and the old OneDrive-shortcut copy (sharepoint.ts) is used.
 */
const ROOT = path.join(__dirname, '..');
const TOKEN_FILE = path.join(ROOT, '.auth', 'sharepoint-token.json');
const SCOPE = 'https://graph.microsoft.com/Files.ReadWrite.All offline_access';
const GRAPH = process.env.SP_GRAPH_URL || 'https://graph.microsoft.com/v1.0'; // SP_GRAPH_URL: test hook (local mock)
/** The team's evidence folder (address-bar URL of the parent folder). Override with SP_URL in .env. */
const DEFAULT_SP_URL = 'https://hopewellsolutions.sharepoint.com/sites/Testable-ExecutionTeam/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FTestable%2DExecutionTeam%2FShared%20Documents%2FGeneral%2FQA%2DTestable%2FTestable%20Whitebox%20Tool%20Execution%2FAutomation%20Evidences%20Dump';

const clean = (s?: string) => (s || '').trim().replace(/^["']|["']$/g, '');
export const graphConfigured = () => !!(clean(process.env.SP_CLIENT_ID) && clean(process.env.SP_TENANT_ID));

export interface SpTarget { host: string; sitePath: string; library: string; folder: string[] }

/** Address-bar URL of a SharePoint folder → site, library and folder path. Accepts the AllItems.aspx?id=… form and a plain folder path. */
export function parseSharePointUrl(url: string): SpTarget {
  const u = new URL(clean(url));
  const id = u.searchParams.get('id');
  const full = decodeURIComponent(id || u.pathname).replace(/\/+$/, '');
  const parts = full.split('/').filter(Boolean); // sites, <site>, <library>, <folders…>
  if (parts[0] !== 'sites' && parts[0] !== 'teams') throw new Error(`SP_URL is not a SharePoint site address: ${url}`);
  if (parts.length < 3) throw new Error('SP_URL needs the site AND the library, e.g. https://<company>.sharepoint.com/sites/<site>/Shared Documents/<folder>');
  return { host: u.host, sitePath: `/${parts[0]}/${parts[1]}`, library: parts[2], folder: parts.slice(3) };
}

/** 28-10-2026 (local date) */
export const dayFolderName = (d = new Date()) => `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;

const enc = (segs: string[]) => segs.map(encodeURIComponent).join('/');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- sign-in (device code) + token cache ----------------
interface TokenCache { access_token: string; refresh_token: string; expires_at: number }
const authBase = () => `https://login.microsoftonline.com/${clean(process.env.SP_TENANT_ID)}/oauth2/v2.0`;
function readCache(): TokenCache | null { try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; } }
function writeCache(t: any, old?: TokenCache | null): TokenCache {
  const c: TokenCache = { access_token: t.access_token, refresh_token: t.refresh_token || old?.refresh_token || '', expires_at: Date.now() + (Number(t.expires_in) || 3600) * 1000 - 120_000 };
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(c));
  return c;
}
async function tokenCall(url: string, form: Record<string, string>): Promise<any> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), signal: AbortSignal.timeout(30_000) });
  return { ok: r.ok, body: await r.json().catch(() => ({})) };
}

/** Interactive, once per developer:  npm run sp:login */
export async function deviceLogin(say: (m: string) => void = console.log): Promise<void> {
  const client_id = clean(process.env.SP_CLIENT_ID);
  const dc = await tokenCall(`${authBase()}/devicecode`, { client_id, scope: SCOPE });
  if (!dc.ok) throw new Error(`sign-in could not start: ${dc.body.error_description || dc.body.error || 'unknown error'}`);
  say(`\n  ${dc.body.message}\n`);
  const until = Date.now() + Number(dc.body.expires_in || 900) * 1000;
  let every = Number(dc.body.interval || 5) * 1000;
  while (Date.now() < until) {
    await sleep(every);
    const t = await tokenCall(`${authBase()}/token`, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id, device_code: dc.body.device_code });
    if (t.ok) { writeCache(t.body); say('  Signed in. The token is saved in .auth/ and refreshes by itself.'); return; }
    if (t.body.error === 'slow_down') every += 5000;
    else if (t.body.error !== 'authorization_pending') throw new Error(`sign-in failed: ${t.body.error_description || t.body.error}`);
  }
  throw new Error('sign-in timed out — run  npm run sp:login  again');
}

async function accessToken(): Promise<string> {
  const c = readCache();
  if (!c || !c.refresh_token) throw new Error('SharePoint: not signed in — run  npm run sp:login  once (a code to type at https://microsoft.com/devicelogin)');
  if (Date.now() < c.expires_at) return c.access_token;
  const t = await tokenCall(`${authBase()}/token`, { grant_type: 'refresh_token', client_id: clean(process.env.SP_CLIENT_ID), refresh_token: c.refresh_token, scope: SCOPE });
  if (!t.ok) throw new Error(`SharePoint: sign-in expired (${t.body.error_description?.split('\r')[0] || t.body.error}) — run  npm run sp:login  again`);
  return writeCache(t.body, c).access_token;
}

// ---------------- Graph calls ----------------
async function graph(method: string, url: string, opts: { body?: any; headers?: Record<string, string>; raw?: boolean } = {}, tries = 5): Promise<Response> {
  for (let i = 1; ; i++) {
    const res = await fetch(url.startsWith('http') ? url : GRAPH + url, {
      method, signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(opts.body && !opts.raw && !(opts.body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
      body: opts.body === undefined ? undefined : opts.raw || opts.body instanceof Buffer ? opts.body : JSON.stringify(opts.body),
    }).catch((e) => { if (i >= tries) throw e; return null; });
    if (res && (res.ok || (res.status !== 429 && res.status < 500) || i >= tries)) return res;
    await sleep(res?.headers.get('retry-after') ? Number(res.headers.get('retry-after')) * 1000 : 1500 * i);
  }
}
const must = async (res: Response, what: string) => {
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`SharePoint ${what}: HTTP ${res.status} ${t.replace(/\s+/g, ' ').slice(0, 200)}`); }
  return res;
};

interface Resolved { driveId: string; base: string[]; target: SpTarget }
let resolved: Resolved | null = null;
async function resolveTarget(): Promise<Resolved> {
  if (resolved) return resolved;
  const target = parseSharePointUrl(process.env.SP_URL || DEFAULT_SP_URL);
  const site = await (await must(await graph('GET', `/sites/${target.host}:${target.sitePath}`), 'find the site')).json() as any;
  const drives = ((await (await must(await graph('GET', `/sites/${site.id}/drives`), 'list the libraries')).json()) as any).value as any[];
  const drive = drives.find((d) => decodeURIComponent(String(d.webUrl || '')).replace(/\/+$/, '').endsWith(`/${target.library}`))
    || drives.find((d) => d.name === target.library || (target.library === 'Shared Documents' && d.name === 'Documents'));
  if (!drive) throw new Error(`SharePoint: library "${target.library}" not found on ${target.sitePath} (found: ${drives.map((d) => d.name).join(', ')})`);
  return (resolved = { driveId: drive.id, base: target.folder, target });
}

const itemUrl = (r: Resolved, segs: string[]) => `/drives/${r.driveId}/root:/${enc([...r.base, ...segs])}`;
async function exists(r: Resolved, segs: string[]): Promise<boolean> {
  const res = await graph('GET', `${itemUrl(r, segs)}?$select=id`);
  if (res.status === 404) return false;
  await must(res, 'check a folder'); return true;
}

/** Same naming rule as the OneDrive copy: <branch>, then <branch>_RUN2 … ; remembered per local folder so a re-copy gives the same name. */
async function targetName(r: Resolved, day: string, branchFolder: string): Promise<string> {
  const base = path.basename(branchFolder);
  const mapFile = path.join(path.dirname(path.dirname(branchFolder)), '.sharepoint-graph-map.json');
  const key = `${day}|${path.resolve(branchFolder)}`;
  let map: Record<string, string> = {}; try { map = JSON.parse(fs.readFileSync(mapFile, 'utf8')); } catch { /* none yet */ }
  if (map[key]) return map[key];
  let name = base; let n = 1;
  while (await exists(r, [day, name])) { n++; name = `${base}_RUN${n}`; }
  try { map[key] = name; fs.writeFileSync(mapFile, JSON.stringify(map, null, 1)); } catch { /* ignore */ }
  return name;
}

async function uploadFile(r: Resolved, segs: string[], file: string): Promise<void> {
  const size = fs.statSync(file).size;
  const where = `${itemUrl(r, segs)}`;
  if (size <= 4 * 1024 * 1024) {
    await must(await graph('PUT', `${where}:/content?@microsoft.graph.conflictBehavior=replace`, { body: fs.readFileSync(file), headers: { 'Content-Type': 'application/octet-stream' } }), `upload ${segs.at(-1)}`);
    return;
  }
  const sess = await (await must(await graph('POST', `${where}:/createUploadSession`, { body: { item: { '@microsoft.graph.conflictBehavior': 'replace' } } }), `start upload of ${segs.at(-1)}`)).json() as any;
  const CH = 16 * 320 * 1024; // 5 MiB, a multiple of 320 KiB as Graph requires
  const fd = fs.openSync(file, 'r');
  try {
    for (let pos = 0; pos < size; pos += CH) {
      const len = Math.min(CH, size - pos); const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, pos);
      for (let i = 1; ; i++) { // the session URL needs no Authorization header
        const res = await fetch(sess.uploadUrl, { method: 'PUT', headers: { 'Content-Length': String(len), 'Content-Range': `bytes ${pos}-${pos + len - 1}/${size}` }, body: buf, signal: AbortSignal.timeout(180_000) }).catch(() => null);
        if (res && (res.ok || res.status === 202)) break;
        if (i >= 4) throw new Error(`SharePoint upload of ${segs.at(-1)} failed at byte ${pos}${res ? ` (HTTP ${res.status})` : ''}`);
        await sleep(2000 * i);
      }
    }
  } finally { fs.closeSync(fd); }
}

function listFiles(dir: string, rel: string[] = []): string[][] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name), [...rel, e.name]) : [[...rel, e.name]]));
}

/** Uploads the whole branch folder. Returns the SharePoint link of the uploaded folder and a one-line result. Throws on sign-in / site problems. */
export async function uploadBranchGraph(branchFolder: string): Promise<{ url: string; message: string }> {
  const r = await resolveTarget();
  const day = dayFolderName();
  const name = await targetName(r, day, branchFolder);
  const files = listFiles(branchFolder);
  let done = 0; let bytes = 0; const failed: string[] = [];
  const queue = files.slice();
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      try { await uploadFile(r, [day, name, ...f], path.join(branchFolder, ...f)); done++; bytes += fs.statSync(path.join(branchFolder, ...f)).size; }
      catch (e) { failed.push(`${f.join('/')}: ${e instanceof Error ? e.message : e}`); }
    }
  }));
  let url = '';
  try { url = ((await (await must(await graph('GET', `${itemUrl(r, [day, name])}?$select=webUrl`), 'read the folder link')).json()) as any).webUrl || ''; } catch { /* the link is optional */ }
  if (failed.length) { try { fs.writeFileSync(path.join(branchFolder, 'sharepoint-copy-errors.txt'), failed.join('\n') + '\n'); } catch { /* ignore */ } }
  const message = `SharePoint: uploaded ${done}/${files.length} file(s), ${(bytes / 1048576).toFixed(1)} MB to ${day}/${name}${failed.length ? ` — ${failed.length} failed (first: ${failed[0]})` : ''}`;
  if (done === 0 && files.length) throw new Error(message);
  return { url, message };
}

/** For  npm run sp:login : signs in, then proves the target folder is reachable. */
export async function checkTarget(say: (m: string) => void = console.log): Promise<void> {
  const r = await resolveTarget();
  say(`  OK: library found; evidence goes to  ${r.base.join('/')}/${dayFolderName()}/<branch>`);
}
