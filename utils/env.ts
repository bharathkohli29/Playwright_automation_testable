import * as dotenv from 'dotenv';
dotenv.config({ override: true }); // override: a long-lived VS Code test process keeps old values otherwise

/**
 * Which Testable environment this run uses:  TEST_ENV=qa (default)  or  TEST_ENV=dev   (set it in .env or in the terminal).
 *   qa  → https://qa-frontend.testable.cc   · S3 bucket qa-bucket-us2   · TESTABLE_EMAIL / TESTABLE_PASSWORD
 *   dev → https://dev-frontend.testable.cc  · S3 bucket dev-bucket-us2  · TESTABLE_EMAIL_DEV / TESTABLE_PASSWORD_DEV
 * BASE_URL and S3_BUCKET can still override a single value. Everything else (flow, S3 logic, reports) is identical.
 */
export type TestEnv = 'qa' | 'dev';
const raw = (process.env.TEST_ENV || 'qa').trim().toLowerCase();
if (raw !== 'qa' && raw !== 'dev') throw new Error(`TEST_ENV must be "qa" or "dev" (got "${process.env.TEST_ENV}")`);
export const TEST_ENV: TestEnv = raw;

export const baseUrl = process.env.BASE_URL || `https://${TEST_ENV}-frontend.testable.cc`;
export const s3Bucket = process.env.S3_BUCKET || `${TEST_ENV}-bucket-us2`;
export const awsRegion = process.env.AWS_REGION || 'us-east-2';
export const loginEmail = TEST_ENV === 'dev' ? process.env.TESTABLE_EMAIL_DEV : process.env.TESTABLE_EMAIL;
export const loginPassword = TEST_ENV === 'dev' ? process.env.TESTABLE_PASSWORD_DEV : process.env.TESTABLE_PASSWORD;
/** each environment keeps its own saved login, so switching never reuses the other site's session */
export const authFile = TEST_ENV === 'dev' ? '.auth/user-dev.json' : '.auth/user.json';
