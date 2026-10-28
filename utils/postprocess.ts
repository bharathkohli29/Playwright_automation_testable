import * as fs from 'fs';
import * as path from 'path';
import './env'; // loads .env (the background worker is its own process)
import type { Page } from '@playwright/test';
import { checkBranchS3, hasAwsCredentials } from './s3Evidence';
import { describeAwsError } from './awsS3';
import { uploadBranchToSharePoint, sharepointBranchUrl } from './sharepoint';
import { graphConfigured, uploadBranchGraph } from './sharepointGraph';
import { notifyTeams } from './teams';

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
}

type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
interface PostState { state: 'queued' | 'running' | 'done' | 'failed'; steps: Record<string, StepState>; detail: Record<string, string>; updated: string }

export function writePostState(branchDir: string, s: PostState): void {
  try { fs.writeFileSync(path.join(branchDir, 'postprocess.json'), JSON.stringify(s, null, 2)); } catch { /* ignore */ }
}

/** Evidence folder → SharePoint. Microsoft Graph when SP_CLIENT_ID / SP_TENANT_ID are set (permanent, no local path); else the old OneDrive-shortcut copy. */
export async function shareBranch(branchDir: string): Promise<{ skipped: boolean; url?: string; message: string }> {
  if (graphConfigured()) { const r = await uploadBranchGraph(branchDir); console.log(`  ${r.message}`); return { skipped: false, url: r.url || undefined, message: r.message }; }
  const message = uploadBranchToSharePoint(branchDir);
  return { skipped: !message, url: sharepointBranchUrl(branchDir) || undefined, message };
}

export async function runPostProcess(job: PostJob): Promise<boolean> {
  const st: PostState = { state: 'running', steps: { s3: 'pending', sharepoint: 'pending', teams: 'pending' }, detail: {}, updated: '' };
  const save = () => { st.updated = new Date().toISOString(); writePostState(job.branchDir, st); };
  const step = async (name: string, fn: () => Promise<string | void>) => {
    st.steps[name] = 'running'; save();
    try { const d = await fn(); st.steps[name] = d === 'skipped' ? 'skipped' : 'done'; if (d && d !== 'skipped') st.detail[name] = d; }
    catch (e) { st.steps[name] = 'failed'; st.detail[name] = (e instanceof Error && e.message ? e.message : describeAwsError(e)).slice(0, 400); console.log(`  ${job.branch}: ${name} failed (${st.detail[name]}) — the other steps continue`); }
    save();
  };
  console.log(`\n=== Post-processing ${job.branch} ===`);
  save();

  await step('s3', async () => {
    if (!fs.existsSync(path.join(job.branchDir, 'run-details.json'))) { console.log('  S3 check skipped — no run-details.json'); return 'skipped'; }
    if (!hasAwsCredentials()) { console.log('  S3 check skipped — no AWS keys in .env (paste the QA-S3-Readonly keys, or run npm run s3 later)'); return 'skipped'; }
    console.log('  S3 evidence for this branch …');
    await checkBranchS3(job.branchDir, undefined, job.repo);
  });
  // a failed S3 step does not stop the copy / message: the site run itself passed
  let evidenceUrl: string | undefined;
  await step('sharepoint', async () => { const r = await shareBranch(job.branchDir); evidenceUrl = r.url; if (r.skipped) return 'skipped'; });
  await step('teams', async () => {
    // notifyTeams does not use the page; a passed branch never needs a screenshot
    await notifyTeams(undefined as unknown as Page, {
      branch: job.branch, repo: job.repo, status: 'passed', note: job.note || '', url: job.url,
      minutes: job.minutes, branchDir: job.branchDir, evidenceUrl,
    });
  });

  const failed = Object.values(st.steps).includes('failed');
  st.state = failed ? 'failed' : 'done'; save();
  console.log(`=== Post-processing ${job.branch}: ${st.state} (${Object.entries(st.steps).map(([k, v]) => `${k} ${v}`).join(', ')}) ===`);
  return !failed;
}
