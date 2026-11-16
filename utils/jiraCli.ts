import * as fs from 'fs';
import * as path from 'path';
import './env';
import { JiraClient, jiraConfig, jiraReady } from './jira';
import { syncCache } from './jiraCache';
import { runJira } from './jiraFile';

/**
 *   npm run jira:sync                       read-only: download / refresh the local copy of the project's open bugs
 *   npm run jira:plan  -- "<branch folder>" plan only (matching + drafts), nothing is sent
 *   npm run jira:apply -- "<branch folder>" do the plan: comment on the covering tickets, create the new bugs (asks Jira first, so a duplicate made since is seen)
 * <branch folder> = the branch's results folder, e.g. results\merge-flow_2026-11-13_1212\PY_V312_SETUPTOOLS_PIP_MICRO (a round folder with one branch inside works too)
 */
/** read-only diagnosis: who is the token, can it see the project, how many bugs it sees (nothing is written anywhere) */
async function check(c: JiraClient) {
  const p = (m: string) => console.log(`  ${m}`);
  try { const me = await c.call('GET', '/rest/api/3/myself'); p(`signed in as: ${me.displayName} (${String(me.emailAddress || '').replace(/^(.).*@/, '$1***@')}), account type ${me.accountType}`); } catch (e) { p(`sign-in FAILED: ${e instanceof Error ? e.message : e}`); return; }
  try { const pr = await c.call('GET', `/rest/api/3/project/${encodeURIComponent(c.cfg.project)}`); p(`project ${c.cfg.project}: visible (${pr.name})`); } catch (e) { p(`project ${c.cfg.project}: NOT visible to this account (${e instanceof Error ? e.message.slice(0, 160) : e})`); }
  for (const [label, jql] of [['all issues of the project', `project = ${c.cfg.project}`], [`${c.cfg.issueType}s of the project`, `project = ${c.cfg.project} AND issuetype = "${c.cfg.issueType}"`], [`open ${c.cfg.issueType}s`, `project = ${c.cfg.project} AND issuetype = "${c.cfg.issueType}" AND statusCategory != Done`]]) {
    try { const r = await c.call('POST', '/rest/api/3/search/approximate-count', { jql }); p(`${label}: ${r.count}`); } catch (e) { p(`${label}: count failed (${e instanceof Error ? e.message.slice(0, 160) : e})`); }
  }
  p('if all counts are 0 the account cannot see the project: use the Atlassian account that opens TP in your browser (JIRA_EMAIL) and make the token with it');
}

async function main() {
  const [cmd, arg] = process.argv.slice(2); const cfg = jiraConfig(); const log = (m: string) => console.log(`  ${m}`);
  if (!cmd || !['sync', 'plan', 'apply', 'check'].includes(cmd)) { console.log('usage: npm run jira:check | jira:sync | jira:plan -- "<branch folder>" | jira:apply -- "<branch folder>"'); process.exitCode = 1; return; }
  if (cmd === 'sync' || cmd === 'apply' || cmd === 'check') if (!jiraReady(cfg)) { console.log('Jira is not set up: add JIRA_EMAIL and JIRA_API_TOKEN to .env (an Atlassian API token: id.atlassian.com > Security > API tokens)'); process.exitCode = 1; return; }
  if (cmd === 'check') { await check(new JiraClient(cfg)); return; }
  if (cmd === 'sync') { const c = await syncCache(new JiraClient(cfg), log); console.log(`  ${c.issues.length} open bug(s) in ${c.project}, saved in jira-cache/open-bugs.json`); return; }
  if (!arg) { console.log('give the branch folder'); process.exitCode = 1; return; }
  let dir = path.resolve(arg);
  if (!fs.existsSync(path.join(dir, 's3-check.json'))) { const sub = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 's3-check.json'))).map((d) => path.join(dir, d.name)) : []; if (sub.length === 1) dir = sub[0]; else { console.log(sub.length ? `several branches in that folder, give one: ${sub.map((s) => path.basename(s)).join(', ')}` : 'no s3-check.json there: give a branch folder of a finished run'); process.exitCode = 1; return; } }
  const r = await runJira(dir, { execute: cmd === 'apply', log, cfg: cmd === 'apply' && cfg.mode === 'off' ? { ...cfg, mode: 'ask' } : cfg });
  if (!r) { console.log('  no platform bugs in this branch: nothing to log'); return; }
  console.log(`  ${cmd === 'apply' ? 'done' : 'planned'}: ${r.detail}\n  details: ${path.join(dir, 'jira-plan.md')}`);
}
main().catch((e) => { console.log(`Jira step failed: ${e instanceof Error ? e.message : e}`); process.exitCode = 1; });
