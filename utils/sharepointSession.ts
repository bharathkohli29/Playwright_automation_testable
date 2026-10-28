import * as fs from 'fs';
import * as path from 'path';
import { chromium, request as pwRequest, APIRequestContext } from '@playwright/test';
import { parseSharePointUrl, dayFolderName, chooseFolderName, listFiles, clean, DEFAULT_SP_URL } from './sharepointGraph';

/**
 * SharePoint upload with the developer's OWN Microsoft sign-in — no app registration, no admin.
 * `npm run sp:login` opens a browser once; sign in with your work account (MFA as usual). The session is saved in .auth/sharepoint-session.json
 * and every later run uploads through SharePoint's REST API with that session:
 *     <Automation Evidences Dump>/<DD-MM-YYYY>/<branch>   (a repeat run the same day: <branch>_RUN2, _RUN3 …)
 * When the company's sign-in policy ends the session, the upload says so and `npm run sp:login` is run again.
 */
const SESSION_FILE = path.join(__dirname, '..', '.auth', 'sharepoint-session.json');
const MAX_BYTES = 240 * 1024 * 1024; // the simple REST upload limit is 250 MB; bigger files are listed in sharepoint-copy-errors.txt
export const sessionSaved = () => fs.existsSync(SESSION_FILE);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (s: string) => encodeURIComponent(s.replace(/'/g, "''")).replace(/%2F/g, '/'); // value inside decodedurl='…'

class Session {
  digest = ''; digestAt = 0;
  constructor(public ctx: APIRequestContext, public site: string, public siteRel: string, public rel: string[]) {}
  expired(): never { throw new Error('SharePoint: sign-in expired — run  npm run sp:login  again'); }
  async call(method: 'GET' | 'POST', url: string, data?: Buffer, tries = 4): Promise<{ status: number; text: string; json: () => any }> {
    for (let i = 1; ; i++) {
      const res = await this.ctx.fetch(this.site + url, { method, maxRedirects: 0, data, timeout: 120_000, failOnStatusCode: false,
        headers: { Accept: 'application/json;odata=nometadata', ...(method === 'POST' ? { 'X-RequestDigest': await this.getDigest(), ...(data ? { 'Content-Type': 'application/octet-stream' } : {}) } : {}) } }).catch(() => null);
      if (res && [301, 302, 303, 307, 308, 401].includes(res.status())) this.expired();
      if (res && res.status() === 403 && /login|sign.?in/i.test(await res.text().catch(() => ''))) this.expired();
      if (res && ![429, 500, 502, 503, 504].includes(res.status())) { const text = await res.text().catch(() => ''); return { status: res.status(), text, json: () => JSON.parse(text) }; }
      if (i >= tries) throw new Error(`SharePoint: ${method} failed${res ? ` (HTTP ${res.status()})` : ' (network)'}`);
      await sleep(Number(res?.headers()['retry-after']) * 1000 || 1500 * i);
    }
  }
  async getDigest(): Promise<string> {
    if (this.digest && Date.now() - this.digestAt < 20 * 60_000) return this.digest;
    const res = await this.ctx.fetch(`${this.site}/_api/contextinfo`, { method: 'POST', maxRedirects: 0, failOnStatusCode: false, headers: { Accept: 'application/json;odata=nometadata' }, timeout: 60_000 });
    if ([301, 302, 303, 307, 308, 401, 403].includes(res.status())) this.expired();
    const j = await res.json().catch(() => ({}));
    if (!j.FormDigestValue) throw new Error(`SharePoint: no request digest (HTTP ${res.status()})`);
    this.digest = j.FormDigestValue; this.digestAt = Date.now(); return this.digest;
  }
  path(segs: string[]) { return `${this.siteRel}/${[...this.rel, ...segs].join('/')}`; }
  async folderExists(segs: string[]) { const r = await this.call('GET', `/_api/web/GetFolderByServerRelativePath(decodedurl='${q(this.path(segs))}')?$select=Exists`); if (r.status === 404) return false; if (r.status >= 400) throw new Error(`SharePoint: check folder HTTP ${r.status} ${r.text.slice(0, 120)}`); return true; }
  async makeFolder(segs: string[]) { if (await this.folderExists(segs)) return; const r = await this.call('POST', `/_api/web/folders/addUsingPath(decodedurl='${q(this.path(segs))}')`); if (r.status >= 400) throw new Error(`SharePoint: create folder ${segs.at(-1)} HTTP ${r.status} ${r.text.slice(0, 120)}`); }
  async putFile(folder: string[], name: string, file: string) { const r = await this.call('POST', `/_api/web/GetFolderByServerRelativePath(decodedurl='${q(this.path(folder))}')/files/addUsingPath(decodedurl='${q(name)}',Overwrite=true)`, fs.readFileSync(file)); if (r.status >= 400) throw new Error(`HTTP ${r.status} ${r.text.slice(0, 120)}`); }
}

async function open(): Promise<Session> {
  if (!sessionSaved()) throw new Error('SharePoint: not signed in — run  npm run sp:login  once (sign in with your Microsoft work account)');
  const t = parseSharePointUrl(process.env.SP_URL || DEFAULT_SP_URL);
  const site = (clean(process.env.SP_REST_BASE) || `https://${t.host}`) + t.sitePath; // SP_REST_BASE: test hook (local mock)
  const ctx = await pwRequest.newContext({ storageState: SESSION_FILE, ignoreHTTPSErrors: false });
  return new Session(ctx, site, `${t.sitePath}/${t.library}`, t.folder);
}

/** One-time sign-in: opens a browser, waits until you are in SharePoint, saves the session, then proves the folder is reachable. */
export async function sessionLogin(say: (m: string) => void = console.log): Promise<void> {
  const t = parseSharePointUrl(process.env.SP_URL || DEFAULT_SP_URL);
  const start = `https://${t.host}${t.sitePath}/${encodeURI(t.library)}/${t.folder.map(encodeURIComponent).join('/')}`;
  say('  A browser window opens — sign in with your Microsoft work account (including the approval prompt). It closes by itself.');
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  try {
    const ctx = await browser.newContext({ viewport: null });
    const page = await ctx.newPage();
    await page.goto(start, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const until = Date.now() + 10 * 60_000;
    for (;;) {
      if (Date.now() > until) throw new Error('sign-in timed out (10 min) — run  npm run sp:login  again');
      if (page.isClosed()) throw new Error('the browser was closed before the sign-in finished');
      const onSite = new URL(page.url()).host === t.host;
      const cookies = await ctx.cookies(`https://${t.host}`);
      if (onSite && cookies.some((c) => /^(FedAuth|rtFa)$/i.test(c.name))) break;
      await sleep(1500);
    }
    await sleep(2000); // let the last cookies arrive
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    await ctx.storageState({ path: SESSION_FILE });
  } finally { await browser.close().catch(() => {}); }
  const s = await open();
  try { if (!(await s.folderExists([]))) throw new Error('signed in, but the evidence folder was not found — check SP_URL'); }
  finally { await s.ctx.dispose(); }
  say(`  Signed in. Session saved in .auth/ . Evidence goes to  ${t.folder.join('/')}/${dayFolderName()}/<branch>`);
}

export async function uploadBranchSession(branchFolder: string): Promise<{ url: string; message: string }> {
  const s = await open();
  try {
    const day = dayFolderName();
    await s.makeFolder([day]);
    const name = await chooseFolderName('session', day, branchFolder, (n) => s.folderExists([day, n]));
    const files = listFiles(branchFolder);
    const dirs = new Set<string>(); for (const f of files) for (let i = 1; i < f.length; i++) dirs.add(f.slice(0, i).join('/'));
    await s.makeFolder([day, name]);
    for (const d of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length)) await s.makeFolder([day, name, ...d.split('/')]);
    let done = 0; let bytes = 0; const failed: string[] = []; const queue = files.slice();
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        const abs = path.join(branchFolder, ...f); const size = fs.statSync(abs).size;
        try {
          if (size > MAX_BYTES) throw new Error(`file is ${(size / 1048576).toFixed(0)} MB, over the ${MAX_BYTES / 1048576} MB upload limit — not copied`);
          await s.putFile([day, name, ...f.slice(0, -1)], f[f.length - 1], abs); done++; bytes += size;
        } catch (e) { if (/sign-in expired/.test(String(e))) throw e; failed.push(`${f.join('/')}: ${e instanceof Error ? e.message : e}`); }
      }
    }));
    if (failed.length) { try { fs.writeFileSync(path.join(branchFolder, 'sharepoint-copy-errors.txt'), failed.join('\n') + '\n'); } catch { /* ignore */ } }
    const message = `SharePoint: uploaded ${done}/${files.length} file(s), ${(bytes / 1048576).toFixed(1)} MB to ${day}/${name}${failed.length ? ` — ${failed.length} failed (first: ${failed[0]})` : ''}`;
    if (done === 0 && files.length) throw new Error(message);
    const t = parseSharePointUrl(process.env.SP_URL || DEFAULT_SP_URL);
    const url = `https://${t.host}${t.sitePath}/${encodeURIComponent(t.library)}/Forms/AllItems.aspx?id=${encodeURIComponent(s.path([day, name]))}`;
    return { url, message };
  } finally { await s.ctx.dispose().catch(() => {}); }
}
