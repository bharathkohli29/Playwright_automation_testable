import * as dotenv from 'dotenv';
dotenv.config({ override: true }); // override: a long-lived VS Code test process keeps old values otherwise

/**
 * Which Testable environment this run uses:  TEST_ENV=qa (default)  or  TEST_ENV=dev   (set it in .env or in the terminal).
 *   qa  → https://qa-app.testable.cloud   · S3 bucket testable-qa-artifacts-759498976252   · TESTABLE_EMAIL / TESTABLE_PASSWORD
 *   dev → https://dev-app.testable.cloud  · S3 bucket dev-bucket-us2  · TESTABLE_EMAIL_DEV / TESTABLE_PASSWORD_DEV
 * BASE_URL and S3_BUCKET can still override a single value. Everything else (flow, S3 logic, reports) is identical.
 */
export type TestEnv = 'qa' | 'dev';
const raw = (process.env.TEST_ENV || 'qa').trim().toLowerCase();
if (raw !== 'qa' && raw !== 'dev') throw new Error(`TEST_ENV must be "qa" or "dev" (got "${process.env.TEST_ENV}")`);
export const TEST_ENV: TestEnv = raw;

export const baseUrl = process.env.BASE_URL || `https://${TEST_ENV}-app.testable.cloud`;
export const s3Bucket = process.env.S3_BUCKET || (TEST_ENV === 'qa' ? 'testable-qa-artifacts-759498976252' : `${TEST_ENV}-bucket-us2`);
export const awsRegion = process.env.AWS_REGION || 'us-east-2';
/** folder in the bucket where the runs are stored (the same for every branch). qa: cells/cell-001/qa/cell-001/ · others: development/cell-001/. S3_ROOT in .env overrides. */
export const s3Root = (process.env.S3_ROOT || (TEST_ENV === 'qa' ? 'cells/cell-001/qa/cell-001/' : 'development/cell-001/')).replace(/^\/+/, '').replace(/\/*$/, '/');
/**
 * Second Testable account on the same PC:  ACCOUNT=2  (set it in the terminal, NOT in .env) uses TESTABLE_EMAIL_2 / TESTABLE_PASSWORD_2
 * (DEV: TESTABLE_EMAIL_DEV_2 / TESTABLE_PASSWORD_DEV_2), its own saved session and its own results folder, so two terminals can run side by side.
 * Not set = the normal single account, exactly as before.
 */
export const ACCOUNT = (process.env.ACCOUNT || '').trim().replace(/[^\w-]/g, '');
const sfx = ACCOUNT ? `_${ACCOUNT}` : '';
export const loginEmail = TEST_ENV === 'dev' ? process.env[`TESTABLE_EMAIL_DEV${sfx}`] : process.env[`TESTABLE_EMAIL${sfx}`];
export const loginPassword = TEST_ENV === 'dev' ? process.env[`TESTABLE_PASSWORD_DEV${sfx}`] : process.env[`TESTABLE_PASSWORD${sfx}`];
if (ACCOUNT && (!loginEmail || !loginPassword)) throw new Error(`ACCOUNT=${ACCOUNT}: add ${TEST_ENV === 'dev' ? `TESTABLE_EMAIL_DEV_${ACCOUNT} and TESTABLE_PASSWORD_DEV_${ACCOUNT}` : `TESTABLE_EMAIL_${ACCOUNT} and TESTABLE_PASSWORD_${ACCOUNT}`} to .env`);
/** each environment (and each account) keeps its own saved login, so switching never reuses another session */
export const authFile = `.auth/user${TEST_ENV === 'dev' ? '-dev' : ''}${ACCOUNT ? `-${ACCOUNT}` : ''}.json`;
