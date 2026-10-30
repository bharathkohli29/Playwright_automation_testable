import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import type { Page } from '@playwright/test';
import { toolLogElements, previousRun, ToolRow } from './toolLog';

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
  branchDir?: string; // this branch's results folder (to read s3-check.json for the tool summary)
}

/** Tool-validation summary (language + version, tool counts, tools with a bug) read from <branch folder>/s3-check.json. Empty when there is none. */
export function toolSummary(dir?: string, noteMax = 70, withPrev = true): unknown[] {
  try {
    if (!dir) return [];
    const j = JSON.parse(fs.readFileSync(path.join(dir, 's3-check.json'), 'utf8'));
    const out: unknown[] = [];
    for (const [key, name, runtime] of [['python', 'Python', 'Python'], ['javascript', 'JavaScript', 'Node'], ['typescript', 'TypeScript', 'Node'], ['csharp', 'C#', 'C#'], ['java', 'Java', 'Java']] as const) {
      const s = j[key]; if (!s || !s.version) continue;
      const defects: { tool: string; tag: string }[] = s.defects || [];
      const repo: string[] = s.repoDefects || [];
      const line = `${name} ${runtime === 'Node' ? 'Node ' : ''}${runtime === 'C#' ? (s.version || '').replace(/^\.NET/, '.NET') : s.version} — ${Math.max(0, s.expected - (s.missing?.length || 0) - (s.empty || 0) - (s.falseEmpty || 0) - (s.failed || 0))}/${s.expected} expected tools OK` + (s.naByDesign?.length ? ` · ${s.naByDesign.length} N/A by design` : '');
      out.push({ type: 'TextBlock', text: `**${line}**`, wrap: true, spacing: 'Medium' });
      // Tool Trigger Log: one line per tool of this language (tool, triggered / result, detail), under the bug summary
      const log = toolLogElements(name, String(j.branch || ''), (s.tools as ToolRow[]) || [], noteMax, withPrev ? previousRun(dir, key) : null, path.basename(path.dirname(path.resolve(dir))));
      if (!defects.length && !repo.length) { out.push({ type: 'TextBlock', text: '✅ No tool bugs found', wrap: true, spacing: 'None', color: 'Good' }); out.push(...log); continue; }
      const lines = defects.slice(0, 10).map((d) => `• ${d.tool} — ${String(d.tag).replace(/[\[\]]/g, '')}`);
      if (defects.length > 10) lines.push(`• … and ${defects.length - 10} more`);
      if (lines.length) out.push({ type: 'TextBlock', text: `❌ ${defects.length} tool bug${defects.length > 1 ? 's' : ''} (draft reports saved):\n\n${lines.join('\n\n')}`, wrap: true, spacing: 'None', color: 'Attention' });
      if (repo.length) out.push({ type: 'TextBlock', text: `⚠ Repo-side failures (not platform bugs): ${repo.slice(0, 8).join(', ')}`, wrap: true, spacing: 'None', isSubtle: true });
      out.push(...log);
    }
    // the webhook accepts about 28 KB: shorten the detail text, then drop it, then drop the earlier-run columns, when the tables get too long
    if (JSON.stringify(out).length > 21_000) {
      if (noteMax > 30) return toolSummary(dir, 30, withPrev);
      if (noteMax > 0) return toolSummary(dir, 0, withPrev);
      if (withPrev) return toolSummary(dir, 0, false);
    }
    if (!out.length) { // no validation summary (for example Python 3.6 or a language without a tool matrix): still show language + version
      let rd: any = {}; try { rd = JSON.parse(fs.readFileSync(path.join(dir, 'repo-details.json'), 'utf8')); } catch { /* ignore */ }
      const lang = rd['Language'] || (Array.isArray(rd.languages) ? rd.languages.join(', ') : ''); const ver = rd['Language version'];
      if (!lang && !ver) return [];
      const rows: any[] = Array.isArray(j.checks) ? j.checks : [];
      const noOut = rows.filter((r) => r && r.result === 'FAIL').map((r) => r.tool).filter(Boolean);
      out.push({ type: 'TextBlock', text: `**${lang}${ver ? ` ${ver}` : ''}** — tool results were not judged (no tool matrix for this version)`, wrap: true, spacing: 'Medium' });
      if (false && noOut.length) out.push({ type: 'TextBlock', text: `${noOut.length} tools gave no output: ${noOut.slice(0, 10).join(', ')}${noOut.length > 10 ? ' …' : ''}`, wrap: true, spacing: 'None', isSubtle: true });
    }
    return out;
  } catch { return []; }
}

const card = (body: unknown[], url?: string, evidence?: string, after: unknown[] = []) => ({
  type: 'message',
  attachments: [{
    contentType: 'application/vnd.microsoft.card.adaptive',
    content: {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard', version: JSON.stringify([body, after]).includes('"type":"Table"') ? '1.5' : '1.4', // the Tool Trigger Log table needs 1.5
      // buttons sit inside the body (ActionSet) so the tool summary can come AFTER them
      body: [
        ...body,
        ...(url || evidence ? [{ type: 'ActionSet', actions: [
          ...(url ? [{ type: 'Action.OpenUrl', title: 'Open the run', url }] : []),
          ...(evidence ? [{ type: 'Action.OpenUrl', title: 'Open evidence folder (SharePoint)', url: evidence }] : []),
        ] }] : []),
        ...after,
      ],
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

/** Returns true when the message went out (or Teams is switched off), false when it could not be sent. */
export async function notifyTeams(page: Page, i: TeamsInfo): Promise<boolean> {
  if (!teamsEnabled()) return true;
  try {
    const env = (process.env.TEST_ENV || 'qa').toUpperCase();
    const where = `${i.repo ? `${i.repo} · ` : ''}${env}${i.minutes !== undefined ? ` · ${i.minutes} min` : ''}`;
    const url = i.url && /^https?:/i.test(i.url) ? i.url : undefined;
    if (i.status === 'passed') {
      const sent = await Promise.race([postRetry(card([
        { type: 'TextBlock', text: `✅ Branch ${i.branch} successfully completed its executions`, weight: 'Bolder', wrap: true },
        { type: 'TextBlock', text: where, isSubtle: true, wrap: true, spacing: 'Small' },
      ], url, i.evidenceUrl, toolSummary(i.branchDir))), new Promise<boolean>((r) => setTimeout(() => r(false), 90_000))]);
      console.log(sent ? '  Teams: success message sent' : '  Teams: success message could not be sent (the run continues)');
      return sent;
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
    fs.writeFileSync(jobFile, JSON.stringify({ webhook: process.env.TEAMS_WEBHOOK_URL!.trim(), payload: card(body, url, i.evidenceUrl, toolSummary(i.branchDir)), imagePath: i.imagePath || '', log: path.join(dir, 'teams-notify.log') }));
    const child = spawn(process.execPath, [path.join(__dirname, 'teamsWorker.js'), jobFile], { detached: true, stdio: 'ignore', cwd: path.join(__dirname, '..'), windowsHide: true, env: cleanEnv() });
    // wait (max 2 min) until the separate sender process has finished, so the message is out before the next branch starts.
    // The sender is its own process: if it crashes or hangs, the run just carries on after the wait.
    const done = new Promise<void>((resolve) => { child.on('error', () => resolve()); child.on('exit', () => resolve()); });
    console.log('  Teams: sending the failure message …');
    await Promise.race([done, new Promise<void>((r) => setTimeout(r, 120_000))]);
    child.unref();
    let log = ''; try { log = fs.readFileSync(path.join(dir, 'teams-notify.log'), 'utf8').trim().split('\n').pop() || ''; } catch { /* ignore */ }
    console.log(`  Teams: ${log || 'sender finished'}`);
    return true;
  } catch (e) {
    console.log(`  Teams: not sent (${e instanceof Error ? e.message : e}) — the run is not affected`);
    return false;
  }
}
