process.env.RCA_CODE = 'off';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import { chromium } from 'playwright';
import { totp, ssoUrl, driveSignIn, autoLoginConfigured } from '../utils/eksSsoAuto';

const noBrowser = (() => { try { return !fs.existsSync(chromium.executablePath()); } catch { return true; } })();
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // the RFC 6238 test secret ("12345678901234567890")

test('totp gives the RFC 6238 test codes', () => {
  assert.equal(totp(SECRET, 59_000, 8), '94287082'); assert.equal(totp(SECRET, 59_000, 6), '287082');
  assert.equal(totp(SECRET, 1111111109_000, 8), '07081804'); assert.equal(totp(SECRET, 1234567890_000, 8), '89005924');
  assert.equal(totp('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq', 59_000, 6), '287082'); // spaces, dashes and case do not matter
});

test('ssoUrl takes the sign-in link out of what aws sso login prints', () => {
  const text = 'Browser will not be automatically opened.' + String.fromCharCode(10) + 'Please visit the following URL:' + String.fromCharCode(10) + 'https://device.sso.us-east-2.amazonaws.com/' + String.fromCharCode(10) + 'Then enter the code: ABCD-EFGH';
  assert.equal(ssoUrl(text), 'https://device.sso.us-east-2.amazonaws.com/'); assert.equal(ssoUrl('nothing here'), null);
  assert.match(ssoUrl('open https://device.sso.eu-west-1.amazonaws.com/?user_code=ABCD-EFGH now') || '', /user_code=ABCD-EFGH/);
});

test('autoLoginConfigured needs the account in .env and can be switched off', () => {
  const keep = { e: process.env.EKS_LOGIN_EMAIL, p: process.env.EKS_LOGIN_PASSWORD, a: process.env.EKS_AUTO_LOGIN };
  try {
    delete process.env.EKS_AUTO_LOGIN; process.env.EKS_LOGIN_EMAIL = 'a@b.test'; process.env.EKS_LOGIN_PASSWORD = ''; assert.equal(autoLoginConfigured(), false);
    process.env.EKS_LOGIN_PASSWORD = 'pw'; assert.equal(autoLoginConfigured(), true); process.env.EKS_AUTO_LOGIN = 'off'; assert.equal(autoLoginConfigured(), false);
  } finally { for (const [k, v] of [['EKS_LOGIN_EMAIL', keep.e], ['EKS_LOGIN_PASSWORD', keep.p], ['EKS_AUTO_LOGIN', keep.a]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

/** a local copy of the sign-in steps (fake account, fake password): AWS confirm -> email -> password -> [code] -> stay signed in? -> allow access -> approved */
function mock(mode: 'plain' | 'mfa' | 'wrongpw' | 'flaky'): Promise<{ url: string; got: Record<string, string>; close: () => void }> {
  const got: Record<string, string> = {}; let afterCalls = 0; const page = (b: string) => `<!doctype html><html><body>${b}</body></html>`;
  const s = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x'); res.writeHead(200, { 'Content-Type': 'text/html' });
    if (u.pathname === '/') return void res.end(page('<h1>Authorize request</h1><form action="/email"><button type="submit">Confirm and continue</button></form>'));
    if (u.pathname === '/email') return void res.end(page('<h1>Sign in</h1><form action="/pw"><input name="loginfmt"><input type="submit" id="idSIButton9" value="Next"></form>'));
    if (u.pathname === '/pw') { got.email = u.searchParams.get('loginfmt') || ''; return void res.end(page('<h1>Enter password</h1><form action="/after"><input type="password" name="passwd"><input type="submit" id="idSIButton9" value="Sign in"></form>')); }
    if (u.pathname === '/after') {
      got.password = u.searchParams.get('passwd') || ''; afterCalls++;
      if (mode === 'flaky' && afterCalls === 1) return void res.end(page('<h1>Enter password</h1><div id="passwordError">Please enter your password.</div><form action="/after"><input type="password" name="passwd"></form>')); // the first submit "lost" the text, like the real page did
      if (mode === 'wrongpw') return void res.end(page('<h1>Enter password</h1><div id="passwordError">Your account or password is incorrect.</div><form action="/after"><input type="password" name="passwd"></form>'));
      return void res.end(page(mode === 'mfa' ? '<h1>Enter code</h1><form action="/kmsi"><input name="otc"><input type="submit" id="idSubmit_SAOTCC_Continue" value="Verify"></form>' : '<h1>Stay signed in?</h1><a id="idBtn_Back" href="/allow">No</a>'));
    }
    if (u.pathname === '/kmsi') { got.code = u.searchParams.get('otc') || ''; return void res.end(page('<h1>Stay signed in?</h1><a id="idBtn_Back" href="/allow">No</a>')); }
    if (u.pathname === '/allow') return void res.end(page('<h1>Allow access?</h1><form action="/done"><button type="submit">Allow access</button></form>'));
    return void res.end(page('<h1>Request approved</h1><p>You can now close this window.</p>'));
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(s.address() as { port: number }).port}/`, got, close: () => s.close() })));
}
async function run(mode: 'plain' | 'mfa' | 'wrongpw' | 'flaky', creds: { email: string; password: string; totpSecret?: string }) {
  const m = await mock(mode); const b = await chromium.launch({ headless: true });
  try { const page = await (await b.newContext()).newPage(); await page.goto(m.url); const r = await driveSignIn(page, creds, { timeoutMs: 40_000, awsHost: /127[.]0[.]0[.]1/ }); return { r, got: m.got }; } finally { await b.close(); m.close(); }
}

test('driveSignIn walks the whole sign-in by itself and types exactly the account of .env', { skip: noBrowser }, async () => {
  const { r, got } = await run('plain', { email: 'qa-testing@example.test', password: 'Fake-pass-1' });
  assert.equal(r.ok, true, r.why); assert.equal(got.email, 'qa-testing@example.test'); assert.equal(got.password, 'Fake-pass-1');
});

test('an authenticator code is typed when the secret is set, and the sign-in says what is missing when it is not', { skip: noBrowser }, async () => {
  const withSecret = await run('mfa', { email: 'a@b.test', password: 'pw', totpSecret: SECRET }); assert.equal(withSecret.r.ok, true, withSecret.r.why); assert.match(withSecret.got.code, /^[0-9]{6}$/);
  const without = await run('mfa', { email: 'a@b.test', password: 'pw' }); assert.equal(without.r.ok, false); assert.match(without.r.why, /EKS_LOGIN_TOTP_SECRET/);
});

test('a refused password stops the sign-in with the page text and never loops', { skip: noBrowser }, async () => {
  const { r } = await run('wrongpw', { email: 'a@b.test', password: 'wrong' }); assert.equal(r.ok, false); assert.match(r.why, /refused it: Your account or password is incorrect/);
  assert.doesNotMatch(r.why, /wrong/); // the password is never part of a message
});

test('"Please enter your password" (the box was empty when submitted) is not the end: it is typed again and the sign-in goes on', { skip: noBrowser }, async () => {
  const { r, got } = await run('flaky', { email: 'qa-testing@example.test', password: 'Fake-pass-2' });
  assert.equal(r.ok, true, r.why); assert.equal(got.password, 'Fake-pass-2');
});
