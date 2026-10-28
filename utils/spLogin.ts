// One-time SharePoint sign-in per developer:  npm run sp:login
// With SP_CLIENT_ID + SP_TENANT_ID in .env: device-code sign-in for Microsoft Graph. Without them: a browser opens, you sign in with your own Microsoft work account.
import './env';
import { graphConfigured, deviceLogin, checkTarget } from './sharepointGraph';
import { sessionLogin } from './sharepointSession';

(async () => {
  if (graphConfigured()) { await deviceLogin(); await checkTarget(); }
  else await sessionLogin();
})().catch((e) => { console.log(`SharePoint sign-in failed: ${e instanceof Error ? e.message : e}`); process.exit(1); });
