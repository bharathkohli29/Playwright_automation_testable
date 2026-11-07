import { test as setup, expect } from '@playwright/test';
import { ensureEksSignedIn, eksSignedIn } from '../utils/eksLogin';
import { autoLoginConfigured, autoSsoLogin } from '../utils/eksSsoAuto';
import { preflightAtStart } from '../utils/preflight';
import { authFile } from '../utils/env';
import { loginToPlatform } from '../utils/platformLogin';

// the setup steps run in order and stop at the first failure: a pre-flight that is not green means the platform is never opened (no login, no branch)
setup.describe.configure({ mode: 'serial' });

// LOGIN_MODE=okta in .env (or $env:LOGIN_MODE="okta") signs in through "Sign in with SSO" → Okta. Default (normal / not set): the usual email + password login, unchanged.
// The Okta route uses OKTA_EMAIL / OKTA_PASSWORD when set, otherwise the same TESTABLE_EMAIL / TESTABLE_PASSWORD as the normal login.
const okta = /^okta$/i.test((process.env.LOGIN_MODE || '').trim());

// Verified live on /auth/login: textbox "Email or username", textbox "Password", and a
// button[type=submit] (no text). Credentials come from .env — never from the code.
// QA EKS cluster sign-in (only when EKS_AUTO is on): if it expired, a private browser window opens and you sign in once; no answer = the round carries on without the cluster logs
setup('QA EKS sign-in', async () => {
  setup.setTimeout(((Number(process.env.EKS_LOGIN_WAIT_MIN) || 4) + 2) * 60_000);
  if (autoLoginConfigured() && !eksSignedIn()) await autoSsoLogin(); // no person: the script signs in with the account of .env first
  await ensureEksSignedIn();
});

// Pre-flight check: what is missing (AWS keys, SharePoint sign-in, cluster ...) and what that skips, shown before the first branch.
// Only reports; PREFLIGHT=strict stops the run on a FAIL, PREFLIGHT=off skips it. Same check by hand: npm run preflight
setup('pre-flight check', async () => {
  setup.setTimeout(3 * 60_000);
  expect(await preflightAtStart(), 'NOT READY: a check is not green (see the lines above). The platform is not opened until every check is green (PREFLIGHT=warn only reports).').toBe(true);
});

setup('log in', async ({ page }) => {
  await loginToPlatform(page); // the same sign-in is used by every branch that has to sign in again (utils/platformLogin.ts)
  await page.context().storageState({ path: authFile });
});
