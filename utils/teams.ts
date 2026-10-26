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

/** post with up to 4 tries (4 s / 10 s / 20 s apart) so a short network blip does not lose the message */
async function postRetry(payload: unknown): Promise<boolean> {
  for (const wait of [0, 4000, 10000, 20000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try { if (await post(payload)) return true; } catch (e) { console.log(`  Teams: try failed (${e instanceof Error ? e.message : e})`); }
  }
  return false;
}

async function post(payload: unknown): Promise<boolean> {
  const res = await fetch(process.env.TEAMS_WEBHOOK_URL!.trim(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) console.log(`  Teams: post was rejected (HTTP ${res.status})`);
  return res.ok;
}

/** The sender gets a clean environment: nothing Playwright put there for the test run (PW_*, NODE_OPTIONS, loaders) can reach it. */
function cleanEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(PW_|PLAYWRIGHT_(?!BROWSERS_PATH)|NODE_OPTIONS$|ELECTRON_|VSCODE_)/i.test(k)) e[k] = v;
  return e;
}

export async function notifyTeams(page: Page, i: TeamsInfo): Promise<void> {
  if (!teamsEnabled()) return;
  try {
    const env = (process.env.TEST_ENV || 'qa').toUpperCase();
    const where = `${i.repo ? `${i.repo} · ` : ''}${env}${i.minutes !== undefined ? ` · ${i.minutes} min` : ''}`;
    const url = i.url && /^https?:/i.test(i.url) ? i.url : undefined;
    if (i.status === 'passed') {
      const sent = await Promise.race([postRetry(card([
        { type: 'TextBlock', text: `✅ Branch ${i.branch} successfully completed its executions`, weight: 'Bolder', wrap: true },
        { type: 'TextBlock', text: where, isSubtle: true, wrap: true, spacing: 'Small' },
      ], url, i.evidenceUrl)), new Promise<boolean>((r) => setTimeout(() => r(false), 90_000))]);
      console.log(sent ? '  Teams: success message sent' : '  Teams: success message could not be sent (the run continues)');
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
    const child = spawn(process.execPath, [path.join(__dirname, 'teamsWorker.js'), jobFile], { detached: true, stdio: 'ignore', cwd: path.join(__dirname, '..'), windowsHide: true, env: cleanEnv() });
    // wait (max 2 min) until the separate sender process has finished, so the message is out before the next branch starts.
    // The sender is its own process: if it crashes or hangs, the run just carries on after the wait.
    const done = new Promise<void>((resolve) => { child.on('error', () => resolve()); child.on('exit', () => resolve()); });
    console.log('  Teams: sending the failure message …');
    await Promise.race([done, new Promise<void>((r) => setTimeout(r, 120_000))]);
    child.unref();
    let log = ''; try { log = fs.readFileSync(path.join(dir, 'teams-notify.log'), 'utf8').trim().split('\n').pop() || ''; } catch { /* ignore */ }
    console.log(`  Teams: ${log || 'sender finished'}`);
  } catch (e) {
    console.log(`  Teams: not sent (${e instanceof Error ? e.message : e}) — the run is not affected`);
  }
}
