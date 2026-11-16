import * as fs from 'fs';
import * as path from 'path';
import { JiraClient, JiraIssue } from './jira';

/**
 * The local copy of the OPEN bugs of the Jira project (jira-cache/open-bugs.json, kept out of Git).
 * First sync: every open Bug of the project. Next syncs: only what changed since the last one (updated >= last sync, minus a safety margin);
 * an issue that is now Done / closed leaves the copy, an issue that changed is replaced, a new one is added.
 */
export interface JiraCache { project: string; lastSync: string; issues: JiraIssue[] }
export const CACHE_DIR = () => path.resolve(process.env.JIRA_CACHE_DIR || 'jira-cache');
const FILE = () => path.join(CACHE_DIR(), 'open-bugs.json');

export function loadCache(project: string): JiraCache {
  try { const j = JSON.parse(fs.readFileSync(FILE(), 'utf8')); if (j && j.project === project && Array.isArray(j.issues)) return j; } catch { /* no copy yet */ }
  return { project, lastSync: '', issues: [] };
}
export function saveCache(c: JiraCache): void { fs.mkdirSync(CACHE_DIR(), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(c, null, 1)); }

const jqlTime = (d: Date) => { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

/** merge a changed issue list into the copy (pure: used by the sync and by the tests) */
export function mergeIssues(c: JiraCache, changed: JiraIssue[]): JiraCache {
  const map = new Map(c.issues.map((i) => [i.key, i] as const));
  for (const i of changed) { if (i.statusCategory === 'done') map.delete(i.key); else map.set(i.key, i); }
  return { ...c, issues: [...map.values()].sort((a, b) => b.updated.localeCompare(a.updated)) };
}

export async function syncCache(client: JiraClient, log: (m: string) => void = () => {}): Promise<JiraCache> {
  const project = client.cfg.project; let c = loadCache(project);
  const base = `project = ${project} AND issuetype = "${client.cfg.issueType}"`;
  if (!c.lastSync) {
    const open = await client.search(`${base} AND statusCategory != Done`);
    if (!open.length) throw new Error(`Jira returned 0 open ${client.cfg.issueType.toLowerCase()}s for project ${project}: the account in JIRA_EMAIL may not have access to that project (run npm run jira:check), or the project key is wrong. Nothing was saved.`);
    c = { project, lastSync: new Date().toISOString(), issues: open.sort((a, b) => b.updated.localeCompare(a.updated)) };
    log(`Jira copy: downloaded ${open.length} open ${client.cfg.issueType.toLowerCase()}(s) of ${project}`);
  } else {
    const since = new Date(new Date(c.lastSync).getTime() - 24 * 3_600_000); // a day of overlap: no time-zone difference between this PC and Jira can lose a change (the merge is repeat-safe)
    const started = new Date();
    const changed = await client.search(`${base} AND updated >= "${jqlTime(since)}"`);
    c = mergeIssues(c, changed); c.lastSync = started.toISOString();
    log(`Jira copy: ${changed.length} changed since the last sync, ${c.issues.length} open in the copy`);
  }
  saveCache(c); return c;
}
