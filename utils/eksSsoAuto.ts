import { spawn } from 'child_process';
import * as crypto from 'crypto';
import './env';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { eksSignedIn } from './eksLogin';

/**
 * AUTOMATIC QA EKS SIGN-IN (no person at the keyboard): the script starts  aws sso login --profile qa-eks-ro --no-browser , takes the sign-in link it prints,
 * opens it in its OWN fresh browser (headless; nothing is saved), and fills the Microsoft sign-in with the account made for the script:
 *   EKS_LOGIN_EMAIL, EKS_LOGIN_PASSWORD   in the git-ignored .env
 *   EKS_LOGIN_TOTP_SECRET                  optional: the base32 secret of the authenticator code of that account (the script then types the 6-digit code itself)
 *   EKS_AUTO_LOGIN=off                     turns this off (the old window that waits for a person is used)
 *   EKS_LOGIN_HEADLESS=off                 shows the browser while it signs in (to watch the first time)
 * The pages are driven by what is on them (email box, password box, "stay signed in?", the code box, the AWS "confirm / allow access" buttons), step by step, until
 * AWS says the request is approved. When the account needs an approval that cannot be typed (a push to a phone, a security key), it says so and stops: the old window
 * flow stays as the fallback. The email and password are never printed, never put in a screenshot and never passed on a command line.
 */
const clean = (s?: string) => (s || '').trim().replace(/^["']|["']$/g, '');
const PROFILE = () => clean(process.env.EKS_AWS_PROFILE) || 'qa-eks-ro';
const AWS = () => clean(process.env.EKS_AWS_CLI) || 'aws';
const WIN = process.platform === 'win32';

export const autoLoginConfigured = (): boolean => !!clean(process.env.EKS_LOGIN_EMAIL) && !!clean(process.env.EKS_LOGIN_PASSWORD) && !/^(0|no|off|false)$/i.test(clean(process.env.EKS_AUTO_LOGIN));

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** RFC 6238 time-based code (HMAC-SHA1), what an authenticator app shows */
export function totp(secretBase32: string, atMs = Date.now(), digits = 6, stepSec = 30): string {
  const clean32 = secretBase32.toUpperCase().replace(/[^A-Z2-7]/g, ''); let bits = ''; for (const ch of clean32) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = Buffer.from(bits.match(/.{8}/g)?.map((b) => parseInt(b, 2)) || []);
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / stepSec)));
  const h = crypto.createHmac('sha1', bytes).update(counter).digest(); const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}

/** the sign-in link that  aws sso login --no-browser  prints */
export function ssoUrl(text: string): string | null { return /(https:\/\/[^\s]*(?:device|authorize|awsapps|oidc|verification)[^\s]*)/i.exec(text)?.[1] || null; }

export interface Creds { email: string; password: string; totpSecret?: string }
export interface DriveResult { ok: boolean; why: string }
const vis = async (page: Page, sel: string) => page.locator(sel).first().isVisible().catch(() => false);

/** types into a box the way a person does (the Microsoft page re-draws between the steps, so a fast fill can be lost) and checks the box really holds the text */
async function typeInto(page: Page, sel: string, text: string): Promise<boolean> {
  const loc = page.locator(sel).first();
  await page.waitForTimeout(500); // the page is still sliding in
  await loc.click({ timeout: 8000 }).catch(() => {}); await loc.fill('').catch(() => {});
  await loc.pressSequentially(text, { delay: 30 }).catch(() => {});
  if (((await loc.inputValue().catch(() => '')) || '').length !== text.length) await loc.fill(text).catch(() => {});
  return (((await loc.inputValue().catch(() => '')) || '').length === text.length);
}

/** fills the sign-in pages one by one, deciding by what is on the page, until AWS says approved (or it cannot go on) */
export async function driveSignIn(page: Page, c: Creds, opts: { timeoutMs?: number; awsHost?: RegExp } = {}): Promise<DriveResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000); const awsHost = opts.awsHost || /amazonaws\.com|awsapps\.com|aws\.amazon\.com/i;
  let emailDone = 0, passDone = 0, codeDone = 0, retries = 0, last = '';
  while (Date.now() < deadline) {
    let host = ''; try { host = new URL(page.url()).host; } catch { /* about:blank */ } last = host;
    const body = (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')) || '';
    if (/request approved|you can (now )?close this (browser )?window|you have been signed in|successfully (authorized|signed in)/i.test(body)) return { ok: true, why: 'approved' };
    if (await vis(page, '#usernameError, #passwordError, #idTD_Error, #errorText')) {
      const t = (await page.locator('#usernameError, #passwordError, #idTD_Error, #errorText').first().innerText().catch(() => '')).trim().slice(0, 140);
      if (/please enter|enter your (password|email|username|phone)/i.test(t) && retries < 3) { retries++; passDone = 0; emailDone = 0; await page.waitForTimeout(800); } // the box was empty when it was submitted: type it again
      else return { ok: false, why: `the sign-in page refused it: ${t || 'error shown'}` };
    }
    if (await vis(page, 'input[name="loginfmt"]') && emailDone < 2) { await typeInto(page, 'input[name="loginfmt"]', c.email); await page.locator('input[name="loginfmt"]').first().press('Enter').catch(() => {}); emailDone++; await page.waitForTimeout(1200); continue; }
    if (await vis(page, 'input[name="passwd"]')) { if (passDone >= 2) return { ok: false, why: 'the password was typed twice and the page is still asking for it' }; const held = await typeInto(page, 'input[name="passwd"]', c.password); if (!held) return { ok: false, why: 'the password box did not take the text that was typed' }; await page.locator('input[name="passwd"]').first().press('Enter').catch(() => {}); passDone++; await page.waitForTimeout(1500); continue; }
    if (await vis(page, 'input[name="otc"]')) { if (!c.totpSecret) return { ok: false, why: 'the account asks for an authenticator code: set EKS_LOGIN_TOTP_SECRET (the base32 secret of that account) or use an account without it' }; if (codeDone >= 2) return { ok: false, why: 'the authenticator code was typed twice and was not accepted' }; await page.locator('input[name="otc"]').first().fill(totp(c.totpSecret)); await page.locator('#idSubmit_SAOTCC_Continue, input[type="submit"]').first().click(); codeDone++; await page.waitForTimeout(900); continue; }
    if (/approve sign.?in request|open your authenticator|approve a request on your|use your security key|touch your security key/i.test(body)) return { ok: false, why: 'the account needs an approval that cannot be typed (a phone push or a security key)' };
    if (await vis(page, '#idBtn_Back')) { await page.locator('#idBtn_Back').first().click(); await page.waitForTimeout(700); continue; } // "Stay signed in?" -> No
    const tile = page.getByText(c.email, { exact: false }).first(); if (/microsoftonline|login\.live|login\.microsoft/i.test(host) && await tile.isVisible().catch(() => false) && !(await vis(page, 'input[name="passwd"]'))) { await tile.click().catch(() => {}); await page.waitForTimeout(700); continue; } // "Pick an account"
    if (awsHost.test(host)) { const btn = page.getByRole('button', { name: /confirm and continue|allow access|^allow$|authorize|^continue$/i }).first(); if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); await page.waitForTimeout(900); continue; } }
    await page.waitForTimeout(700);
  }
  return { ok: false, why: `no answer in time (last page: ${last || 'none'})` };
}

/** the whole sign-in: start aws sso login, drive the page, check that the profile works afterwards. Never throws, never prints the account's password. */
export async function autoSsoLogin(say: (m: string) => void = console.log): Promise<boolean> {
  if (!autoLoginConfigured()) return false;
  const creds: Creds = { email: clean(process.env.EKS_LOGIN_EMAIL), password: clean(process.env.EKS_LOGIN_PASSWORD), totpSecret: clean(process.env.EKS_LOGIN_TOTP_SECRET) || undefined };
  say(`QA EKS sign-in: signing in by itself as ${creds.email} (profile ${PROFILE()}) ...`);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    const child = spawn(AWS(), ['sso', 'login', '--profile', PROFILE(), '--no-browser'], { shell: WIN, windowsHide: true, env: { ...process.env, AWS_PAGER: '' } });
    let out = ''; let started = false; let drive: Promise<DriveResult> | null = null;
    const closed = new Promise<number>((res) => { child.on('close', (c) => res(c ?? 1)); child.on('error', () => res(1)); });
    const onText = (d: Buffer) => {
      out += d.toString('utf8'); const url = !started ? ssoUrl(out) : null;
      if (url) { started = true; drive = (async () => { browser = await chromium.launch({ headless: !/^(0|no|off|false)$/i.test(clean(process.env.EKS_LOGIN_HEADLESS)) }); const page = await (await browser.newContext()).newPage(); await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }); return driveSignIn(page, creds); })().catch((e) => ({ ok: false, why: `the browser step failed (${e instanceof Error ? e.message.split('\n')[0] : e})` })); }
    };
    child.stdout?.on('data', onText); child.stderr?.on('data', onText);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 170_000);
    const r = await Promise.race([drive ? drive : new Promise<DriveResult | null>((res) => { const t = setInterval(() => { if (drive) { clearInterval(t); (drive as Promise<DriveResult>).then(res); } else if (!started && child.exitCode !== null) { clearInterval(t); res(null); } }, 300); }), closed.then(() => null as DriveResult | null)]);
    await Promise.race([closed, new Promise((res) => setTimeout(res, 20_000))]); clearTimeout(timer); try { child.kill(); } catch { /* done */ }
    const ok = eksSignedIn();
    if (ok) { say('QA EKS sign-in: signed in (no person was needed)'); return true; }
    say(`QA EKS sign-in: the automatic sign-in did not finish${r && !r.ok ? ` (${r.why})` : ''}; the window that waits for a person is the fallback`);
    return false;
  } catch (e) { say(`QA EKS sign-in: the automatic sign-in failed (${e instanceof Error ? e.message.split('\n')[0] : e})`); return false; }
  finally { try { await (browser as { close(): Promise<void> } | null)?.close(); } catch { /* closed */ } }
}

if (require.main === module) autoSsoLogin().then((ok) => process.exit(ok ? 0 : 1));
