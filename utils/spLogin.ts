// One-time SharePoint sign-in per developer:  npm run sp:login
import './env';
import { graphConfigured, deviceLogin, checkTarget } from './sharepointGraph';

(async () => {
  if (!graphConfigured()) { console.log('Set SP_TENANT_ID and SP_CLIENT_ID in .env first (the Entra app registration the admin created — see .env.example).'); process.exit(1); }
  await deviceLogin();
  await checkTarget();
})().catch((e) => { console.log(`SharePoint sign-in failed: ${e instanceof Error ? e.message : e}`); process.exit(1); });
