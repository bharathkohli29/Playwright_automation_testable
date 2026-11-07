import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { TEST_ENV, loginEmail, loginPassword, baseUrl } from './env';

/**
 * Signing in to the platform with the account of .env, shared by the one-time setup (tests/auth.setup.ts) and by every branch that has to sign in again
 * because the branch before it signed out (only with LOGOUT_EACH=on; by default the script signs out once, after the last branch).
 * LOGIN_MODE=okta signs in through "Sign in with SSO" -> Okta (OKTA_EMAIL / OKTA_PASSWORD, else the normal ones); default is email + password.
 * Credentials come from .env, never from the code. With none in .env the person signs in by hand in the browser window.
 */
const okta = () => /^okta$/i.test((process.env.LOGIN_MODE || '').trim());

/** off by default: the script stays signed in for all branches and signs out once, after the last one. LOGOUT_EACH=on: every branch signs out when it is finished and the next one signs in again */
export const logoutEach = (): boolean => /^(1|yes|on|true)$/i.test((process.env.LOGOUT_EACH || '').trim());

export async function loginToPlatform(page: Page): Promise<void> {
  await page.goto('/auth/login');
  const email = loginEmail; const password = loginPassword;
  console.log(`  environment: ${TEST_ENV.toUpperCase()}`);
  if (okta()) {
    const oEmail = process.env.OKTA_EMAIL || email; const oPass = process.env.OKTA_PASSWORD || password;
    console.log('  login mode: SSO → Okta');
    if (oEmail && oPass) {
      await page.getByRole('button', { name: /^Sign in with SSO$/i }).click({ timeout: 15_000 });
      await page.getByText('Okta', { exact: true }).first().click({ timeout: 15_000 });
      await page.getByPlaceholder('Email or username').fill(oEmail, { timeout: 15_000 });
      await page.getByPlaceholder('Password', { exact: true }).fill(oPass, { timeout: 15_000 });
      await page.getByRole('button', { name: /Authenticate with Okta/i }).click({ timeout: 15_000 });
    } else {
      console.log('  🔐 No OKTA_EMAIL/OKTA_PASSWORD (or TESTABLE_EMAIL/TESTABLE_PASSWORD) in .env — please sign in with Okta manually in the browser window…');
    }
  } else if (email && password) {
    await page.getByPlaceholder('Email or username').fill(email, { timeout: 15_000 });
    await page.getByPlaceholder('Password', { exact: true }).fill(password, { timeout: 15_000 });
    await page.locator('button[type="submit"]').first().click();
  } else {
    const sfx = TEST_ENV === 'dev' ? '_DEV' : '';
    console.log(`  🔐 No TESTABLE_EMAIL${sfx}/TESTABLE_PASSWORD${sfx} in .env — please log in manually in the browser window…`);
  }
  // with Okta the browser may pass through the Okta site (not /auth/): wait until we are back on Testable itself
  await page.waitForURL((u) => (!okta() || u.origin === new URL(baseUrl).origin) && !/\/auth\//i.test(u.pathname), { timeout: 5 * 60_000 });
  await page.goto('/execution-assistant');
  await expect(page.getByRole('button', { name: 'Change repository / branch' })).toBeVisible({ timeout: 60_000 });
}

/** opens the platform; when the page shows the login (the session was signed out by the branch before), signs in again. Never throws on the check itself. */
export async function ensureLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.goto('/execution-assistant', { waitUntil: 'domcontentloaded' });
    const ready = page.getByRole('button', { name: 'Change repository / branch' });
    if (await ready.isVisible({ timeout: 15_000 }).catch(() => false)) return false; // still signed in
  } catch { /* fall through to the sign-in */ }
  console.log('  signed out (the branch before ended with a sign-out): signing in again');
  await loginToPlatform(page);
  return true;
}
