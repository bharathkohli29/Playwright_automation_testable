import { test as setup, expect } from '@playwright/test';
import { TEST_ENV, loginEmail, loginPassword, authFile, baseUrl } from '../utils/env';

// LOGIN_MODE=okta in .env (or $env:LOGIN_MODE="okta") signs in through "Sign in with SSO" → Okta. Default (normal / not set): the usual email + password login, unchanged.
// The Okta route uses OKTA_EMAIL / OKTA_PASSWORD when set, otherwise the same TESTABLE_EMAIL / TESTABLE_PASSWORD as the normal login.
const okta = /^okta$/i.test((process.env.LOGIN_MODE || '').trim());

// Verified live on /auth/login: textbox "Email or username", textbox "Password", and a
// button[type=submit] (no text). Credentials come from .env — never from the code.
setup('log in', async ({ page }) => {
  await page.goto('/auth/login');
  const email = loginEmail;
  const password = loginPassword;
  console.log(`  environment: ${TEST_ENV.toUpperCase()}`);

  if (okta) {
    const oEmail = process.env.OKTA_EMAIL || email;
    const oPass = process.env.OKTA_PASSWORD || password;
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

  // with Okta the browser may pass through the Okta site (not /auth/) — wait until we are back on Testable itself
  await page.waitForURL((u) => (!okta || u.origin === new URL(baseUrl).origin) && !/\/auth\//i.test(u.pathname), { timeout: 5 * 60_000 });
  await page.goto('/execution-assistant');
  await expect(page.getByRole('button', { name: 'Change repository / branch' })).toBeVisible({ timeout: 60_000 });
  await page.context().storageState({ path: authFile });
});
