import * as fs from 'fs';
import * as path from 'path';
import './env'; // loads .env (the background worker is its own process)
import type { Page } from '@playwright/test';
import { checkBranchS3, hasAwsCredentials } from './s3Evidence';
import { describeAwsError } from './awsS3';
import { uploadBranchToSharePoint, sharepointBranchUrl, sharepointDir } from './sharepoint';
import { graphConfigured, uploadBranchGraph, dayFolderName } from './sharepointGraph';
import { sessionSaved, uploadBranchSession } from './sharepointSession';
import { notifyTeams, teamsEnabled } from './teams';
import { attachPreviousFromSharePoint } from './sharepointHistory';
import { fetchEksLive } from './eksFetch';
import { writeEksOnlyRca } from './eksOnlyRca';
import { dryRun, drySharePoint } from './dryRun';
import { warningCount } from './warn';
import { writeRoundSummary } from './roundSummary';
import { recordPostStep, refreshTimingWorkbook } from './timings';
import { writeReports, RCA_DIR } from './rcaReport';
import { prepareCode } from './rcaCode';
import { analyseScriptFailure } from './rcaScriptFailure';
import { agentEnabled, agentForRun } from './rcaAgent';
import { rcaModelEnabled, writeReport } from './rcaWriter';

/**
 * Everything that happens to a PASSED branch after the site part (steps 1-15) is done and needs no browser:
 *   S3 evidence + validators + taxonomy merge + bug drafts  →  SharePoint copy  →  Teams message.
 * The order matters: the SharePoint copy must hold the finished folder and the Teams card reads s3-check.json.
 * Never throws; progress is written to <branch folder>/postprocess.json.
 */
export interface PostJob {
  branchDir: string;
  branch: string;
  repo: string;
  url?: string;
  minutes?: number;
  note?: string;
  /** the script's wait for the run ended (RUN_TIMEOUT_MIN) before the run finished: S3 is not read, the root causes come from the QA EKS logs of this run */
  timedOut?: boolean;
  /** the script's own step failed (the failure text, for example [CS_X/15] locator.click: Timeout ...): the report gets a script-failure page and the Teams card says why */
  failure?: string;
}

type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
interface PostState { state: 'queued' | 'running' | 'done' | 'failed'; steps: Record<string, StepState>; detail: Record<string, string>; updated: string }

export function writePostState(branchDir: string, s: PostState): void {
  try { fs.writeFileSync(path.join(branchDir, 'postprocess.json'), JSON.stringify(s, null, 2)); } catch { /* ignore */ }
}

/**
 * Evidence folder → SharePoint, in this order of preference:
 *  1. Microsoft Graph          when SP_CLIENT_ID / SP_TENANT_ID are set (app registration by an admin; sign-in: npm run sp:login)
 *  2. the developer's session  when `npm run sp:login` was done without those (own Microsoft sign-in, no admin needed)
 *  3. the old OneDrive-shortcut copy (SHAREPOINT_DIR)
 */
export async function shareBranch(branchDir: string): Promise<{ skipped: boolean; url?: string; message: string }> {
  if (dryRun()) return { skipped: true, message: drySharePoint(branchDir, dayFolderName()) }; // POST_DRYRUN: show what would be copied, copy nothing
  if (graphConfigured()) { const r = await uploadBranchGraph(branchDir); console.log(`  ${r.message}`); return { skipped: false, url: r.url || undefined, message: r.message }; }
  if (sessionSaved()) { const r = await uploadBranchSession(branchDir); console.log(`  ${r.message}`); return { skipped: false, url: r.url, message: r.message }; }
  if (!sharepointDir()) console.log('  SharePoint upload skipped — sign in once with  npm run sp:login  (your Microsoft work account)');
  const message = uploadBranchToSharePoint(branchDir);
  return { skipped: !message, url: sharepointBranchUrl(branchDir) || undefined, message };
}

export async function runPostProcess(job: PostJob): Promise<boolean> {
  const st: PostState = { state: 'running', steps: { eks: 'pending', s3: 'pending', rca: 'pending', history: 'pending', rcareport: 'pending', sharepoint: 'pending', teams: 'pending' }, detail: {}, updated: '' };
  const save = () => { st.updated = new Date().toISOString(); writePostState(job.branchDir, st); };
  // a short network / DNS outage must not lose the whole branch: network-type failures are retried after 30 s, 90 s and 3 min
  const NETWORK = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|fetch failed|network|socket hang up|timed? ?out|HTTP 5\d\d|HTTP 429/i;
  const step = async (name: string, fn: () => Promise<string | void>) => {
    st.steps[name] = 'running'; save();
    const t0 = Date.now();
    for (let attempt = 0; ; attempt++) {
      try { const d = await fn(); st.steps[name] = d === 'skipped' ? 'skipped' : 'done'; if (d && d !== 'skipped') st.detail[name] = d; else delete st.detail[name]; break; }
      catch (e) {
        const msg = (e instanceof Error && e.message ? e.message : describeAwsError(e)).slice(0, 400);
        const wait = [30_000, 90_000, 180_000][attempt];
        if (wait && NETWORK.test(msg)) { st.detail[name] = `retry ${attempt + 1}/3 after: ${msg}`; save(); console.log(`  ${job.branch}: ${name} hit a network problem (${msg.slice(0, 120)}) — trying again in ${wait / 1000} s`); await new Promise((r) => setTimeout(r, wait)); continue; }
        st.steps[name] = 'failed'; st.detail[name] = msg; console.log(`  ${job.branch}: ${name} failed (${msg}) — the other steps continue`); break;
      }
    }
    save();
    recordPostStep(job.branchDir, { step: name, start: t0, end: Date.now(), status: st.steps[name], detail: st.detail[name] }); // timings.xlsx
  };
  console.log(`\n=== Post-processing ${job.branch} ===`);
  save();

  // QA EKS logs of this run: already here when this PC ran the test, otherwise the live capture saved on SharePoint by the PC that did
  await step('eks', async () => fetchEksLive(job.branchDir));
  await step('s3', async () => {
    if (job.timedOut) { console.log('  S3 check skipped — the run did not finish within the time limit (npm run post -- "<branch folder>" does the full check once it has finished)'); return 'skipped'; }
    if (!fs.existsSync(path.join(job.branchDir, 'run-details.json'))) { console.log('  S3 check skipped — no run-details.json'); return 'skipped'; }
    if (!hasAwsCredentials()) { console.log('  S3 check skipped — no AWS keys in .env (paste the QA-S3-Readonly keys, or run npm run s3 later)'); return 'skipped'; }
    console.log('  S3 evidence for this branch …');
    await checkBranchS3(job.branchDir, undefined, job.repo);
  });
  // the earlier run of this branch for the Tool Trigger Log, read from the team's SharePoint folder (not from this PC); saved in the branch folder so it uploads with it
  await step('history', async () => { const r = await attachPreviousFromSharePoint(job.branchDir); return r === 'skipped' ? 'skipped' : r; });
  // An s3-check.json left by an EARLIER attempt of this folder would show old tool results under a "S3 not available" card: keep it aside.
  if (st.steps.s3 === 'failed') { try { const f = path.join(job.branchDir, 's3-check.json'); if (fs.existsSync(f)) { fs.renameSync(f, path.join(job.branchDir, 's3-check.previous.json')); console.log('  an older s3-check.json was kept as s3-check.previous.json (it is not the result of this attempt)'); } } catch { /* ignore */ } }
  // A failed S3 step has two cases. With the run's live QA EKS capture (eks-live) the root causes are still written from it by the rules, and the
  // copy and the Teams card go out with them (without S3 tool results; the card says so). Without eks-live the folder and the card would carry no
  // tool data at all, only an empty "success", so both are skipped: fix the cause (usually expired AWS keys in .env) and run  npm run post -- "<branch folder>"  again.
  const s3Failed = st.steps.s3 === 'failed' || !!job.timedOut;
  let eksOnly: { tools: number; lines: string[] } | null = null;
  await step('rca', async () => {
    if (!s3Failed) return 'skipped';
    eksOnly = await writeEksOnlyRca(job.branchDir, job.timedOut ? 'the run did not finish within the time limit' : `S3 check failed: ${(st.detail.s3 || '').split('[')[0].trim().slice(0, 120)}`);
    return eksOnly ? `${eksOnly.tools} tool(s) from the QA EKS logs` : 'skipped';
  });
  // a branch that did not finish normally (job.failure / job.timedOut) is ALWAYS reported: the report, the SharePoint copy and the Teams card go out even when there is no tool data at all
  const noData = s3Failed && !eksOnly && !job.failure && !job.timedOut;
  if (noData) console.log(`  ${job.branch}: S3 check failed and there is no QA EKS capture of this run, so SharePoint and Teams are NOT sent (they would carry no tool data). Fix it and run: npm run post -- "${job.branchDir}"`);
  else if (s3Failed) console.log(`  ${job.branch}: S3 check failed; SharePoint and Teams go out with the root causes from the QA EKS logs only`);
  // One RCA report per defective tool, in the folder "RCA Report" of the branch folder (uploaded to SharePoint with it, before the copy below). The local model words them
  // (RCA_MODEL=off: the rules do); a tool the model cannot word safely gets the rule-written report. Needs the S3 result or the live EKS capture.
  await step('rcareport', async () => {
    if (noData) return 'skipped';
    try { prepareCode((m) => console.log(`  ${m}`)); } catch { /* the code section is optional */ }
    const rows = await writeReports(job.branchDir, undefined, rcaModelEnabled() ? writeReport : undefined, { failure: job.failure, agent: agentEnabled() ? agentForRun : undefined });
    if (!rows.length) return 'skipped';
    const m = rows.filter((r) => r.source === 'model').length; const red = rows.filter((r) => r.tone === 'red'); const nt = rows.filter((r) => !r.triggered).length; const slow = rows.find((r) => r.note);
    console.log(`  RCA Report: ${rows.length} tool report(s): ${rows.length - red.length} green, ${red.length} red (${nt} not triggered); ${m} of the red worded by the model${slow ? ` (${red.length - m} by rules: ${String(slow.note).slice(0, 110)})` : ''}`);
    return `${rows.length} report(s) in "${RCA_DIR}": ${rows.length - red.length} green, ${red.length} red, ${m} by the model`;
  });
  await refreshTimingWorkbook(job.branchDir).catch(() => {}); // so the copy uploaded below already has the eks / s3 / history times
  let evidenceUrl: string | undefined;
  await step('sharepoint', async () => { if (noData) return 'skipped'; const r = await shareBranch(job.branchDir); evidenceUrl = r.url; if (r.skipped) return 'skipped'; });
  await step('teams', async () => {
    if (noData || (!teamsEnabled() && !dryRun())) return 'skipped';
    // the same run must not fill the channel twice: when a COMPLETE card (S3 result included) was already sent for this run id, a second one is skipped
    // (TEAMS_RESEND=1 sends it anyway); a card that was partial (S3 failed, EKS logs only) is replaced by the full one
    const runId = (() => { try { return String(JSON.parse(fs.readFileSync(path.join(job.branchDir, 'run-details.json'), 'utf8')).run_id || ''); } catch { return ''; } })();
    const sentFile = path.join(job.branchDir, 'teams-sent.json');
    const before = (() => { try { return JSON.parse(fs.readFileSync(sentFile, 'utf8')); } catch { return null; } })();
    if (!dryRun() && runId && before?.run_id === runId && before.complete && !/^(1|yes|on|true)$/i.test((process.env.TEAMS_RESEND || '').trim())) {
      console.log(`  Teams: a complete card for run ${runId.slice(0, 8)} was already sent at ${before.at}; not sent again (TEAMS_RESEND=1 sends it anyway)`); return 'skipped';
    }
    // notifyTeams does not use the page; a passed branch never needs a screenshot
    const sent = await notifyTeams(undefined as unknown as Page, {
      branch: job.branch, repo: job.repo, status: 'passed', note: job.note || '', url: job.url,
      minutes: job.minutes, branchDir: job.branchDir, evidenceUrl,
      ...(job.failure ? (() => { const sf = analyseScriptFailure(job.branchDir, job.failure); return { headline: sf.headline, extra: sf.lines }; })() : eksOnly ? { headline: job.timedOut ? `⏱️ Branch ${job.branch}: the run did not finish within ${job.minutes ?? '?'} minutes, root causes from the QA EKS logs of this run` : `⚠️ Branch ${job.branch}: S3 check not available, root causes from the QA EKS logs only`, extra: (eksOnly as { lines: string[] }).lines } : {}),
    });
    if (!sent) throw new Error('Teams message could not be sent (network)');
    if (!dryRun() && runId) { try { fs.writeFileSync(sentFile, JSON.stringify({ run_id: runId, at: new Date().toISOString(), complete: !s3Failed }, null, 1)); } catch { /* ignore */ } }
  });

  const nWarn = warningCount(job.branchDir); if (nWarn) { st.detail.warnings = `${nWarn} warning(s) in warnings.log`; console.log(`  ${nWarn} warning(s) were written to ${path.join(job.branchDir, 'warnings.log')}`); }
  await refreshTimingWorkbook(job.branchDir).catch(() => {}); // the local timings.xlsx now has every step of the worker too
  const failed = Object.values(st.steps).includes('failed');
  st.state = failed ? 'failed' : 'done'; save();
  writeRoundSummary(job.branchDir); // <round folder>/summary.md: one row per branch
  console.log(`=== Post-processing ${job.branch}: ${st.state} (${Object.entries(st.steps).map(([k, v]) => `${k} ${v}`).join(', ')}) ===`);
  return !failed;
}
