import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import type { Page } from '@playwright/test';

/**
 * Teams notification (add-on). One message per branch, posted when the branch finishes.
 *  - success: "Branch <name> successfully completed its executions."
 *  - failure: branch name, why it failed, and the failure screenshot (shrunk copy, so it fits the ~28 KB webhook limit).
 * Switched on only when TEAMS_WEBHOOK_URL is set in .env. Never throws — a Teams problem can not affect the run.
 */
export const teamsEnabled = () => !!(process.env.TEAMS_WEBHOOK_URL || '').trim();

export interface TeamsInfo {
  branch: string;
  repo?: string;
  status: string; // passed | failed | blocked | environment
  note: string;
  url?: string;
  minutes?: number;
  imagePath?: string; // errors/failure.png
  evidenceUrl?: string; // this branch's folder in SharePoint (optional)
}

const card = (body: unknown[], url?: string, evidence?: string) => ({
  type: 'message',
  attachments: [{
    contentType: 'application/vnd.microsoft.card.adaptive',
    content: {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard', version: '1.4',
      body,
      ...(url || evidence ? { actions: [
        ...(url ? [{ type: 'Action.OpenUrl', title: 'Open the run', url }] : []),
        ...(evidence ? [{ type: 'Action.OpenUrl', title: 'Open evidence folder (SharePoint, uploads in a few minutes)', url: evidence }] : []),
      ] } : {}),
    },
  }],
});

async function post(payload: unknown): Promise<boolean> {
  const res = await fetch(process.env.TEAMS_WEBHOOK_URL!.trim(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) console.log(`  Teams: post was rejected (HTTP ${res.status})`);
  return res.ok;
}

export async function notifyTeams(page: Page, i: TeamsInfo): Promise<void> {
  if (!teamsEnabled()) return;
  try {
    const env = (process.env.TEST_ENV || 'qa').toUpperCase();
    const where = `${i.repo ? `${i.repo} · ` : ''}${env}${i.minutes !== undefined ? ` · ${i.minutes} min` : ''}`;
    const url = i.url && /^https?:/i.test(i.url) ? i.url : undefined;
    if (i.status === 'passed') {
      await post(card([
        { type: 'TextBlock', text: `✅ Branch ${i.branch} successfully completed its executions`, weight: 'Bolder', wrap: true },
        { type: 'TextBlock', text: where, isSubtle: true, wrap: true, spacing: 'Small' },
      ], url, i.evidenceUrl));
      console.log('  Teams: success message sent');
      return;
    }
    const reason = (i.note || 'no reason captured').replace(/\s+/g, ' ').trim().slice(0, 600);
    const label = i.status === 'blocked' ? 'blocked by the site' : i.status === 'environment' ? 'environment problem' : 'failed';
    const body: unknown[] = [
      { type: 'TextBlock', text: `❌ Branch ${i.branch} — ${label}`, weight: 'Bolder', wrap: true, color: 'Attention' },
      { type: 'TextBlock', text: where, isSubtle: true, wrap: true, spacing: 'Small' },
      { type: 'TextBlock', text: `Why: ${reason}`, wrap: true },
    ];
    // The failure message (shrink the screenshot + post) is done by a separate detached process, so it can never hold up or break the run:
    // the test returns at once and the next branch starts. Its log: <branch folder>/errors/teams-notify.log
    const dir = i.imagePath ? path.dirname(i.imagePath) : process.cwd();
    const jobFile = path.join(dir, 'teams-job.json');
    fs.writeFileSync(jobFile, JSON.stringify({ webhook: process.env.TEAMS_WEBHOOK_URL!.trim(), payload: card(body, url, i.evidenceUrl), imagePath: i.imagePath || '', log: path.join(dir, 'teams-notify.log') }));
    const child = spawn(process.execPath, [path.join(__dirname, 'teamsWorker.js'), jobFile], { detached: true, stdio: 'ignore', cwd: path.join(__dirname, '..'), windowsHide: true });
    child.on('error', () => {});
    child.unref();
    console.log('  Teams: failure message is being sent in the background (the next branch continues now)');
  } catch (e) {
    console.log(`  Teams: not sent (${e instanceof Error ? e.message : e}) — the run is not affected`);
  }
}
