import type { Browser, BrowserContext, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { s3Bucket, awsRegion } from './env';

const PORTAL = 'https://testable.awsapps.com/start/#/?tab=accounts';
const ACCOUNT = process.env.AWS_ACCOUNT_NAME || 'foundation-shared-services';
const ROLE = process.env.AWS_ROLE || 'QA-S3-Readonly';
const STATE = path.join(__dirname, '..', '.auth', 'aws.json');

/**
 * Signs in with MICROSOFT_EMAIL / MICROSOFT_PASSWORD from .env (AWS_EMAIL / AWS_PASSWORD also work). The company portal redirects to the Microsoft sign-in page
 * (login.microsoftonline.com): email → Next → password → Sign in → "Stay signed in?" → Yes. Only those pages
 * (and AWS' own sign-in pages) are ever typed into. If MFA is asked, approve it / enter the code in the browser window.
 */
async function signInIfNeeded(page: Page) {
  const email = process.env.MICROSOFT_EMAIL || process.env.AWS_EMAIL; const password = process.env.MICROSOFT_PASSWORD || process.env.AWS_PASSWORD;
  const deadline = Date.now() + 3 * 60_000;
  let userFills = 0; let pwFills = 0; let mfaTold = false; let noCreds = false;
  const visible = (l: ReturnType<Page['locator']>) => l.first().isVisible().catch(() => false);
  while (Date.now() < deadline) {
    if (await page.getByText(/AWS accounts/i).first().isVisible().catch(() => false)) return;
    let host = ''; try { host = new URL(page.url()).hostname; } catch { /* navigating */ }
    const ms = host === 'login.microsoftonline.com';
    const aws = /(^|\.)(signin\.aws|awsapps\.com|amazon\.com)$/.test(host);
    if (!ms && !aws) { await page.waitForTimeout(1000); continue; }
    if (!email || !password) { if (!noCreds) console.log('  MICROSOFT_EMAIL / MICROSOFT_PASSWORD are not set in .env — please sign in by hand.'); noCreds = true; await page.waitForTimeout(2000); continue; }

    const pw = page.locator(ms ? 'input[name="passwd"]' : 'input[type="password"]');
    const user = page.locator(ms ? 'input[name="loginfmt"]' : 'input[type="email"], input[name="username"], input[autocomplete="username"]');
    const next = ms ? page.locator('#idSIButton9') : page.getByRole('button', { name: /^(next|continue|sign in)$/i }).first();
    try {
      if (await visible(pw)) {
        if (++pwFills > 3) { console.log('  The password was not accepted — please sign in by hand in the browser window.'); return; }
        console.log('  Signing in to AWS: entering password …');
        await pw.first().fill(password); await next.click();
      } else if (await visible(user)) {
        if (++userFills > 3) { console.log('  The email was not accepted — please sign in by hand in the browser window.'); return; }
        console.log('  Signing in to AWS: entering email …');
        await user.first().fill(email); await next.click();
      } else if (ms && await page.getByText(/Stay signed in\?/i).first().isVisible().catch(() => false)) {
        await page.locator('#idSIButton9').click(); // "Yes"
      } else if (ms && /(approve sign in|enter code|verify your identity|authenticator)/i.test(await page.locator('body').innerText().catch(() => ''))) {
        if (!mfaTold) console.log('  Microsoft is asking for verification (MFA) — approve it / enter the code in the browser window. Waiting …');
        mfaTold = true;
      }
    } catch { /* page moved on — look again */ }
    await page.waitForTimeout(1500);
  }
}

/** Portal → account → role (QA-S3-Readonly) → AWS Console page. Sign in by hand the first time; the session is saved. */
export async function openAwsConsole(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const context = await browser.newContext({ viewport: null, storageState: fs.existsSync(STATE) ? STATE : undefined });
  const portal = await context.newPage();
  await portal.goto(PORTAL);
  console.log('  AWS portal opened. If you see a sign-in page, sign in in the browser window (only needed when the saved session has expired).');
  await signInIfNeeded(portal);
  await portal.getByText(/AWS accounts/i).first().waitFor({ timeout: 5 * 60_000 });

  const link = portal.locator(`a[href*="role_name=${ROLE}"]`).first();
  if (!(await link.isVisible().catch(() => false))) {
    await portal.locator('[data-testid="account-list-cell"]').filter({ hasText: ACCOUNT }).first().click({ timeout: 5000 }).catch(() => {});
    await portal.getByRole('button', { name: new RegExp(ACCOUNT, 'i') }).first().click({ timeout: 3000 }).catch(() => {});
  }
  const popup = context.waitForEvent('page', { timeout: 3 * 60_000 });
  if (await link.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)) await link.click();
  else console.log(`  Please click the "${ROLE}" role of ${ACCOUNT} yourself in the portal (the script is waiting).`);
  const page = await popup;
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3000);
  await context.storageState({ path: STATE });
  return { context, page };
}

export class S3Console {
  constructor(private page: Page, private bucket = s3Bucket, private region = awsRegion) {}

  private listUrl(prefix: string) { return `https://${this.region}.console.aws.amazon.com/s3/buckets/${this.bucket}?region=${this.region}&prefix=${encodeURIComponent(prefix)}&showversions=false`; }
  private objectUrl(key: string) { return `https://${this.region}.console.aws.amazon.com/s3/object/${this.bucket}?region=${this.region}&prefix=${encodeURIComponent(key)}`; }

  /** Direct children (folders / files) of a prefix, read from the Objects table. */
  async list(prefix: string): Promise<{ folders: string[]; files: string[] }> {
    await this.page.goto(this.listUrl(prefix), { waitUntil: 'domcontentloaded' });
    let last = '';
    for (let i = 0; i < 40; i++) {
      await this.page.waitForTimeout(700);
      const snap = await this.page.evaluate(({ prefix, bucket }) => {
        const folders = new Set<string>(); const files = new Set<string>();
        for (const a of Array.from(document.querySelectorAll('a[href]'))) {
          let u: URL; try { u = new URL(a.getAttribute('href') || '', location.origin); } catch { continue; }
          const p = u.searchParams.get('prefix'); if (!p || !p.startsWith(prefix) || p === prefix) continue;
          const rest = p.slice(prefix.length);
          if (u.pathname.includes(`/s3/buckets/${bucket}`) && /^[^/]+\/$/.test(rest)) folders.add(p);
          else if (u.pathname.includes(`/s3/object/${bucket}`) && !rest.includes('/')) files.add(p);
        }
        return { folders: [...folders], files: [...files], none: /No objects/i.test(document.body.innerText), loading: /Loading|Retrieving/i.test(document.body.innerText) };
      }, { prefix, bucket: this.bucket });
      const key = JSON.stringify([snap.folders, snap.files]);
      if (snap.none) return { folders: [], files: [] };
      if ((snap.folders.length || snap.files.length) && key === last && !snap.loading) return { folders: snap.folders, files: snap.files };
      last = key;
    }
    return { folders: [], files: [] };
  }

  /** Everything below a prefix: all files (depth-first, bounded). */
  async walk(prefix: string, maxDepth = 6, maxFolders = 60): Promise<{ exists: boolean; files: string[] }> {
    const files: string[] = []; let exists = false; let seen = 0;
    const queue: { p: string; d: number }[] = [{ p: prefix, d: 0 }];
    while (queue.length && seen < maxFolders) {
      const { p, d } = queue.shift()!; seen++;
      const r = await this.list(p);
      if (r.folders.length || r.files.length) exists = true;
      files.push(...r.files);
      if (d < maxDepth) r.folders.forEach((f) => queue.push({ p: f, d: d + 1 }));
    }
    return { exists, files };
  }

  /** Object page → "Open" (opens the file via a signed link) → file text. */
  async readText(key: string): Promise<string> {
    await this.page.goto(this.objectUrl(key), { waitUntil: 'domcontentloaded' });
    const open = this.page.locator('button, a').filter({ hasText: /^\s*Open\s*$/ }).first();
    await open.waitFor({ state: 'visible', timeout: 30_000 });
    const ctx = this.page.context();
    const [pop] = await Promise.all([ctx.waitForEvent('page', { timeout: 30_000 }), open.click()]);
    await pop.waitForURL(/amazonaws\.com/, { timeout: 30_000 });
    const url = pop.url();
    await pop.close().catch(() => {});
    const res = await ctx.request.get(url);
    if (!res.ok()) throw new Error(`HTTP ${res.status()} reading ${key}`);
    return res.text();
  }
}
