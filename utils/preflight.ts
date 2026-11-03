import * as fs from 'fs';
import * as path from 'path';
import './env'; // loads .env
import { authFile, loginEmail, loginPassword, s3Root, TEST_ENV } from './env';
import { loadBuilds } from './builds';
import { S3Reader } from './awsS3';
import { hasAwsCredentials } from './s3Evidence';
import { sessionSaved, sessionFileRequest } from './sharepointSession';
import { teamsEnabled } from './teams';
import { eksAutoEnabled, eksClusterReady } from './eksAnalyze';

/**
 * Pre-flight check, run once before the first branch (npm test) or by hand (npm run preflight): looks at everything the run and its post-processing
 * need and says what is missing and what will be skipped, so nobody finds out after a 60 minute run. Read only: nothing is created or changed.
 *   OK    ready
 *   WARN  the run works, one part is reduced or skipped (the line says which)
 *   FAIL  that part will not work; the line says the effect and how to fix it
 * PREFLIGHT=strict stops the run when any check is FAIL (default: only report). PREFLIGHT=off skips the check.
 */
export type Level = 'OK' | 'WARN' | 'FAIL';
export interface Check { name: string; level: Level; message: string; effect?: string; fix?: string }

const clean = (s?: string) => (s || '').trim().replace(/^["']|["']$/g, '');
const first = (s: string) => s.split('[')[0].replace(/\s+/g, ' ').trim().slice(0, 150);

async function checkBuilds(): Promise<Check> {
  try {
    const b = loadBuilds();
    if (!b.length) return { name: 'Branch list', level: 'FAIL', message: 'builds.json has no branches', effect: 'nothing will run', fix: 'add the branch links to builds.json' };
    return { name: 'Branch list', level: 'OK', message: `${b.length} branch(es): ${b.slice(0, 3).map((x) => x.branch).join(', ')}${b.length > 3 ? ', ...' : ''}` };
  } catch (e) { return { name: 'Branch list', level: 'FAIL', message: `builds.json cannot be read (${first(String((e as Error).message))})`, effect: 'nothing will run', fix: 'fix builds.json (see README: Input)' }; }
}

function checkLogin(): Check {
  if (fs.existsSync(authFile)) return { name: 'Platform login', level: 'OK', message: `saved session found (${authFile}); the run signs in again at the start` };
  if (loginEmail && loginPassword) return { name: 'Platform login', level: 'OK', message: `TESTABLE_EMAIL / TESTABLE_PASSWORD set for ${TEST_ENV.toUpperCase()}` };
  return { name: 'Platform login', level: 'WARN', message: 'no saved session and no TESTABLE_EMAIL / TESTABLE_PASSWORD in .env', effect: 'a browser window waits for a manual sign-in at the start', fix: 'fill TESTABLE_EMAIL and TESTABLE_PASSWORD in .env' };
}

async function checkAws(): Promise<Check> {
  const fix = 'AWS access portal > QA-S3-Readonly > Access keys: copy the 3 values into .env (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN), or use aws sso login with AWS_PROFILE';
  if (!hasAwsCredentials()) return { name: 'AWS S3 keys', level: 'FAIL', message: 'no AWS keys or profile in .env', effect: 'no tool results: the S3 check is skipped (root causes still come from the EKS logs when they exist)', fix };
  try { await new S3Reader().check(s3Root); return { name: 'AWS S3 keys', level: 'OK', message: 'valid now (temporary keys expire after a few hours: a long queue can outlive them)' }; }
  catch (e) { return { name: 'AWS S3 keys', level: 'FAIL', message: first(String((e as Error).message)), effect: 'the S3 check will fail at the end of each branch (root causes still come from the EKS logs when they exist)', fix }; }
}

async function checkSharePoint(): Promise<Check> {
  const fix = 'run  npm run sp:login  (your Microsoft work account)';
  if (!sessionSaved()) return { name: 'SharePoint sign-in', level: 'FAIL', message: 'no saved sign-in', effect: 'no copy to SharePoint, no earlier-run history, no EKS log fetch, no model download', fix };
  try {
    const r = sessionFileRequest([]);
    const url = r.url.replace('GetFileByServerRelativePath', 'GetFolderByServerRelativePath').replace(/\/\$value$/, '') + '/Folders?$top=1';
    const res = await fetch(url, { headers: { ...r.headers, Accept: 'application/json;odata=nometadata' }, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    if (res.status === 200) return { name: 'SharePoint sign-in', level: 'OK', message: 'saved sign-in works, evidence folder reachable' };
    if (res.status >= 300 && res.status < 400) return { name: 'SharePoint sign-in', level: 'FAIL', message: 'the saved sign-in has expired', effect: 'the SharePoint copy and the history step will fail', fix };
    return { name: 'SharePoint sign-in', level: 'FAIL', message: `the evidence folder answered HTTP ${res.status}`, effect: 'the SharePoint copy may fail', fix: 'check SP_REST_BASE / the folder permission, then npm run sp:login' };
  } catch (e) { return { name: 'SharePoint sign-in', level: 'WARN', message: `could not be checked (${first(String((e as Error).message))})`, effect: 'the SharePoint steps may fail', fix }; }
}

function checkTeams(): Check {
  return teamsEnabled() ? { name: 'Teams webhook', level: 'OK', message: 'TEAMS_WEBHOOK_URL is set (it cannot be tested without posting a card)' }
    : { name: 'Teams webhook', level: 'WARN', message: 'TEAMS_WEBHOOK_URL is empty', effect: 'no Teams message is sent', fix: 'put the channel webhook in .env' };
}

async function checkEks(): Promise<Check> {
  if (!eksAutoEnabled()) return { name: 'QA EKS cluster', level: 'WARN', message: 'EKS_AUTO is off', effect: 'no live log capture', fix: 'set EKS_AUTO=on in .env' };
  let note = ''; const ok = await eksClusterReady((m) => { note = m; });
  return ok ? { name: 'QA EKS cluster', level: 'OK', message: 'reachable (live log capture will run)' }
    : { name: 'QA EKS cluster', level: 'WARN', message: first(note) || 'not reachable from this PC', effect: 'no live pod logs for this run; the analysis falls back to the cluster service logs', fix: 'npm run eks:setup shows what is missing (sign-in, IP, VPN)' };
}

export async function runPreflight(): Promise<Check[]> {
  const safe = async (name: string, f: () => Promise<Check> | Check): Promise<Check> => { try { return await f(); } catch (e) { return { name, level: 'WARN', message: `check itself failed (${first(String((e as Error).message))})` }; } };
  return [await safe('Branch list', checkBuilds), await safe('Platform login', checkLogin), await safe('AWS S3 keys', checkAws), await safe('SharePoint sign-in', checkSharePoint),
    await safe('Teams webhook', checkTeams), await safe('QA EKS cluster', checkEks)];
}

export function printPreflight(cs: Check[]): void {
  console.log('\n  PRE-FLIGHT CHECK');
  for (const c of cs) {
    console.log(`  ${c.level.padEnd(4)}  ${c.name.padEnd(18)} ${c.message}`);
    if (c.level !== 'OK') { if (c.effect) console.log(`        effect: ${c.effect}`); if (c.fix) console.log(`        fix:    ${c.fix}`); }
  }
  const bad = cs.filter((c) => c.level !== 'OK');
  const nFail = cs.filter((c) => c.level === 'FAIL').length; const strict = clean(process.env.PREFLIGHT).toLowerCase() === 'strict';
  console.log(!bad.length ? '\n  all checks OK\n'
    : strict && nFail ? `\n  ${nFail} FAIL, ${cs.length - nFail - cs.filter((c) => c.level === 'OK').length} WARN: PREFLIGHT=strict, the run is stopped. Fix the FAIL lines above, or set PREFLIGHT=off\n`
    : `\n  ${nFail} FAIL, ${cs.filter((c) => c.level === 'WARN').length} WARN: the run carries on, and the parts above are reduced or skipped (PREFLIGHT=strict stops it on a FAIL)\n`);
}

/** called at the start of npm test; returns false when PREFLIGHT=strict and a check failed */
export async function preflightAtStart(): Promise<boolean> {
  const mode = clean(process.env.PREFLIGHT).toLowerCase();
  if (/^(off|no|0|false)$/.test(mode)) return true;
  const cs = await runPreflight(); printPreflight(cs);
  try { const d = process.env.RUN_DIR; if (d) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'preflight.json'), JSON.stringify({ at: new Date().toISOString(), checks: cs }, null, 2)); } } catch { /* report only */ }
  return !(mode === 'strict' && cs.some((c) => c.level === 'FAIL'));
}

if (require.main === module) {
  runPreflight().then((cs) => { printPreflight(cs); process.exit(cs.some((c) => c.level === 'FAIL') ? 1 : 0); });
}
