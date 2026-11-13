import * as fs from 'fs';
import * as path from 'path';
import './env'; // loads .env
import { authFile, loginEmail, loginPassword, s3Root, TEST_ENV, baseUrl } from './env';
import { chromium } from 'playwright';
import { codeRoot, resolveRef } from './rcaCode';
import { eksIpReport } from './eksIpNotice';
import { loadBuilds } from './builds';
import { S3Reader } from './awsS3';
import { hasAwsCredentials } from './s3Evidence';
import { sessionSaved, sessionFileRequest } from './sharepointSession';
import { teamsEnabled } from './teams';
import { eksAutoEnabled, eksClusterReady } from './eksAnalyze';
import { rcaModelStatus } from './rcaWriter';
import { dummyPrEnabled, dummyVia, tokenFor, findGh, realGh, ghRepoAccess, ghTokenCanWrite, ownerAndName } from './dummyCommit';

/**
 * Pre-flight check, run once before the first branch (npm test) or by hand (npm run preflight): looks at everything the run and its post-processing
 * need and says what is missing and what will be skipped, so nobody finds out after a 60 minute run. Read only: nothing is created or changed.
 *   OK    ready
 *   WARN  the run works, one part is reduced or skipped (the line says which)
 *   FAIL  that part will not work; the line says the effect and how to fix it
 * GATE (default): the script opens the platform only when EVERY check is green (OK). Any WARN or FAIL stops it before the browser starts, with the lines that say what to fix.
 * PREFLIGHT=warn only reports (the run carries on, the parts above are reduced or skipped). PREFLIGHT=off skips the check.
 */
export type Level = 'OK' | 'WARN' | 'FAIL';
export interface Check { name: string; level: Level; message: string; effect?: string; fix?: string }

const clean = (s?: string) => (s || '').trim().replace(/^["']|["']$/g, '');

/** DUMMY_PR=yes: can this PC make the new commit on every repo of the queue? (token + GitHub CLI, else this PC's git login) */
function checkDummyCommit(): Check {
  if (!dummyPrEnabled()) return { name: 'Dummy commit', level: 'OK', message: 'DUMMY_PR is off: the branches run on their latest commit (an already analysed commit may finish at once)' };
  const repos = [...new Set(loadBuilds().map((b) => ownerAndName(b.repo)).filter((x): x is string => !!x))];
  if (dummyVia() === 'git') return { name: 'Dummy commit', level: 'OK', message: `DUMMY_VIA=git: this PC's git login makes the commit on ${repos.length} repo(s) (access is only known when the push is tried)` };
  const noToken = repos.filter((r) => !tokenFor(r.split('/')[0]));
  if (noToken.length === repos.length) return { name: 'Dummy commit', level: 'WARN', message: 'no GH_TOKEN in .env: the commit is made with this PC\'s git login', effect: 'works only where this PC\'s git login can write; the push is only tried at the start of each branch', fix: 'put GH_TOKEN=<token> (or GH_TOKEN_<OWNER>=<token>) in .env' };
  const gh = findGh();
  if (!gh) return { name: 'Dummy commit', level: 'WARN', message: 'token found, but the GitHub CLI (gh) is not installed yet', effect: 'the script installs it with winget when the first branch starts (about a minute)', fix: 'nothing to do, or: winget install --id GitHub.cli' };
  const bad: string[] = []; let soon = '';
  for (const r of repos) {
    const tk = tokenFor(r.split('/')[0]); if (!tk) { bad.push(`${r} (no token)`); continue; }
    const a = ghRepoAccess(r, realGh(gh, tk));
    if (!a.push) bad.push(`${r} (${a.error ? first(a.error) : 'no write access'})`);
    else { const w = ghTokenCanWrite(r, realGh(gh, tk)); if (!w.ok) bad.push(`${r} (the token cannot write: ${first(w.error || '')})`); }
    if (a.expires) { const days = Math.round((Date.parse(a.expires.replace(' UTC', 'Z').replace(' ', 'T')) - Date.now()) / 86_400_000); if (!isNaN(days) && days < 14 && !soon) soon = `the token expires in ${days} day(s) (${a.expires})`; }
  }
  if (bad.length) return { name: 'Dummy commit', level: 'WARN', message: `no write access through the token on: ${bad.slice(0, 4).join('; ')}${bad.length > 4 ? ' …' : ''}`, effect: 'those branches fall back to this PC\'s git login, or run on their old commit', fix: 'token settings: this repo selected, Contents = Read and write, Resource owner = the repo\'s owner (else a classic token with the repo scope), SSO authorized; or ask the repo owner for write access' };
  if (soon) return { name: 'Dummy commit', level: 'WARN', message: soon, effect: 'after that date the dummy commit falls back to git', fix: 'make a new token and replace GH_TOKEN in .env' };
  return { name: 'Dummy commit', level: 'OK', message: `GitHub CLI + token can write to all ${repos.length} repo(s)` };
}

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
  if (!sessionSaved()) return { name: 'SharePoint sign-in', level: 'FAIL', message: 'no saved sign-in', effect: 'no copy to SharePoint, no earlier-run history, no EKS log fetch', fix };
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
  if (!eksAutoEnabled()) return { name: 'QA EKS cluster', level: 'FAIL', message: 'EKS_AUTO is off', effect: 'no live log capture: the RCA Reports have no EKS evidence', fix: 'set EKS_AUTO=on in .env' };
  let note = ''; const ok = await eksClusterReady((m) => { note = m; });
  if (ok) return { name: 'QA EKS cluster', level: 'OK', message: 'reachable (live log capture will run)' };
  // not reachable: is it this PC's IP that is not on the cluster allow-list? Then the IP is shown (and the request text), so it can be approved
  const ipr = await eksIpReport().catch(() => null);
  if (ipr && ipr.allowed === false) return { name: 'QA EKS cluster', level: 'FAIL', message: `this PC's public IP ${ipr.ip} is NOT on the cluster allow-list`, effect: 'no live pod logs: the RCA Reports have no EKS evidence', fix: `ask the cluster admin to add ${ipr.ip}/32 (npm run eks:ip shows the message and copies the IP)` };
  return { name: 'QA EKS cluster', level: 'FAIL', message: first(note) || 'not reachable from this PC', effect: 'no live pod logs: the RCA Reports have no EKS evidence', fix: 'npm run eks:setup shows what is missing (sign-in, IP, VPN)' };
}

async function checkRcaModel(): Promise<Check> {
  const s = await rcaModelStatus();
  if (!s.enabled) return { name: 'RCA model', level: 'WARN', message: 'RCA_MODEL=off', effect: 'the RCA Report is written from the facts and rules only', fix: 'set RCA_MODEL=on in .env' };
  if (!s.reachable) return { name: 'RCA model', level: 'WARN', message: 'Ollama does not answer on this PC', effect: 'the red RCA reports use the rule-written text (the PDFs are still made)', fix: 'start Ollama, then: ollama create rca-writer -f rca-model/Modelfile' };
  if (!s.present) return { name: 'RCA model', level: 'WARN', message: `Ollama is running but the model "${s.name}" does not exist`, effect: 'the red RCA reports use the rule-written text', fix: 'ollama create rca-writer -f rca-model/Modelfile' };
  return { name: 'RCA model', level: 'OK', message: `Ollama answers and "${s.name}" exists (the red RCA reports are worded by it)` };
}

/** the platform answers (before a browser is opened or anything is typed) */
async function checkSite(): Promise<Check> {
  try {
    const r = await fetch(baseUrl, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (r.status < 500) return { name: 'Platform site', level: 'OK', message: `${baseUrl} answers (HTTP ${r.status})` };
    return { name: 'Platform site', level: 'FAIL', message: `${baseUrl} answered HTTP ${r.status}`, effect: 'the run cannot start', fix: 'check that the platform is up, then start again' };
  } catch (e) { return { name: 'Platform site', level: 'FAIL', message: `${baseUrl} does not answer (${first(String((e as Error).message))})`, effect: 'the run cannot start', fix: 'check the network or VPN and that the platform is up' }; }
}
function checkBrowser(): Check {
  try { if (fs.existsSync(chromium.executablePath())) return { name: 'Browser', level: 'OK', message: 'Chromium for the run and the PDF reports is installed' }; } catch { /* below */ }
  return { name: 'Browser', level: 'FAIL', message: 'Chromium is not installed', effect: 'no browser steps and no RCA PDFs', fix: 'run  npx playwright install chromium' };
}
function checkDisk(): Check {
  try {
    let p = path.resolve(process.env.RUN_DIR || path.join(__dirname, '..', 'results')); while (!fs.existsSync(p)) p = path.dirname(p);
    const s = fs.statfsSync(p); const gb = (Number(s.bavail) * Number(s.bsize)) / 1e9;
    return gb >= 3 ? { name: 'Disk space', level: 'OK', message: `${gb.toFixed(1)} GB free for the results` }
      : { name: 'Disk space', level: 'FAIL', message: `only ${gb.toFixed(1)} GB free where the results are written`, effect: 'screenshots, S3 evidence and PDFs may fail to save', fix: 'free at least 3 GB' };
  } catch (e) { return { name: 'Disk space', level: 'WARN', message: `could not be checked (${first(String((e as Error).message))})`, fix: 'check the free space of the results drive by hand' }; }
}
function checkCode(): Check {
  if (/^(0|no|off|false)$/i.test((process.env.RCA_CODE || '').trim())) return { name: 'Platform code', level: 'WARN', message: 'RCA_CODE=off', effect: 'the RCA Reports have no platform-code evidence', fix: 'remove RCA_CODE=off from .env' };
  const r = codeRoot();
  if (!r) return { name: 'Platform code', level: 'FAIL', message: 'no local copy of the platform code', effect: 'the RCA Reports have no platform-code evidence', fix: 'run  npm run code:login  (or set RCA_CODE_DIR / RCA_CODE_REMOTE in .env); the start step clones it when it has access' };
  return { name: 'Platform code', level: 'OK', message: resolveRef(r).label };
}
async function checkFallbackModel(): Promise<Check> {
  const fb = (process.env.RCA_MODEL_FALLBACK ?? 'rca-writer').trim(); const main = (process.env.RCA_MODEL_NAME || 'rca-writer').trim();
  if (!fb || fb === main) return { name: 'RCA fallback model', level: 'OK', message: 'no separate fallback model is set' };
  const s = await rcaModelStatus(undefined, fb);
  return s.present ? { name: 'RCA fallback model', level: 'OK', message: `"${fb}" exists (asked when the first model's answer is rejected)` }
    : { name: 'RCA fallback model', level: 'FAIL', message: `the fallback model "${fb}" does not exist in Ollama`, effect: 'a rejected answer goes straight to the rule text', fix: 'npm run model:setup creates it, or set RCA_MODEL_FALLBACK to a model that exists' };
}

export async function runPreflight(): Promise<Check[]> {
  const safe = async (name: string, f: () => Promise<Check> | Check): Promise<Check> => { try { return await f(); } catch (e) { return { name, level: 'WARN', message: `check itself failed (${first(String((e as Error).message))})` }; } };
  return [await safe('Branch list', checkBuilds), await safe('Platform login', checkLogin), await safe('AWS S3 keys', checkAws), await safe('SharePoint sign-in', checkSharePoint),
    await safe('Teams webhook', checkTeams), await safe('QA EKS cluster', checkEks), await safe('RCA model', checkRcaModel), await safe('RCA fallback model', checkFallbackModel), await safe('Platform code', async () => checkCode()),
    await safe('Dummy commit', checkDummyCommit), await safe('Platform site', checkSite), await safe('Browser', async () => checkBrowser()), await safe('Disk space', async () => checkDisk())];
}

export function printPreflight(cs: Check[]): void {
  console.log('\n  PRE-FLIGHT CHECK');
  for (const c of cs) {
    console.log(`  ${c.level.padEnd(4)}  ${c.name.padEnd(18)} ${c.message}`);
    if (c.level !== 'OK') { if (c.effect) console.log(`        effect: ${c.effect}`); if (c.fix) console.log(`        fix:    ${c.fix}`); }
  }
  const bad = cs.filter((c) => c.level !== 'OK'); const mode = modeOf();
  console.log(!bad.length ? '\n  ALL CHECKS GREEN: the script may open the platform\n'
    : mode === 'warn' ? `\n  ${bad.length} check(s) not green: PREFLIGHT=warn, the run carries on and the parts above are reduced or skipped\n`
    : `\n  NOT READY: ${bad.length} check(s) are not green (${bad.map((c) => c.name).join(', ')}). The script will NOT open the platform. Fix the lines above and start again (PREFLIGHT=warn only reports).\n`);
}

/** gate | warn | off: the default is gate (every check green, else the platform is never opened) */
export const modeOf = (): 'gate' | 'warn' | 'off' => { const m = clean(process.env.PREFLIGHT).toLowerCase(); return /^(off|no|0|false)$/.test(m) ? 'off' : /^(warn|report)$/.test(m) ? 'warn' : 'gate'; };

/** called at the start of npm test; returns false when PREFLIGHT=strict and a check failed */
export async function preflightAtStart(): Promise<boolean> {
  const mode = modeOf(); if (mode === 'off') return true;
  const cs = await runPreflight(); printPreflight(cs);
  try { const d = process.env.RUN_DIR; if (d) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'preflight.json'), JSON.stringify({ at: new Date().toISOString(), mode, checks: cs }, null, 2)); } } catch { /* the report is optional */ }
  return mode === 'warn' || cs.every((c) => c.level === 'OK'); // gate: ONE check that is not green stops the run before the browser opens
}

if (require.main === module) {
  const gate = process.argv.includes('--gate');
  runPreflight().then((cs) => {
    printPreflight(cs);
    const code = gate ? (modeOf() === 'gate' && cs.some((c) => c.level !== 'OK') ? 1 : 0) : cs.some((c) => c.level === 'FAIL') ? 1 : 0;
    // Do NOT call process.exit() straight away: on Windows (Node 22) it can hit "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) ... async.c" while a child process / socket is still closing,
    // and the crash code (3221226505) stops the whole start chain even when every check passed. Set the code, let the handles close, and only force the exit after a safe wait.
    process.exitCode = code;
    setTimeout(() => process.exit(code), 20_000).unref();
  });
}
