import * as fs from 'fs';
import * as path from 'path';

/**
 * Jira Cloud client for the bug step (read, search, create, comment, attach). Plain fetch, no extra package.
 * Needs in .env:  JIRA_EMAIL  and  JIRA_API_TOKEN  (a personal Atlassian API token of the person whose name the bugs are filed under).
 * Optional:       JIRA_BASE_URL (default https://testable.atlassian.net) | JIRA_PROJECT (default TP) | JIRA_ISSUE_TYPE (default Bug)
 *                 JIRA_PRIORITY | JIRA_COMPONENT | JIRA_LABELS (comma list) | JIRA_EXTRA_FIELDS (JSON object of extra fields, e.g. a required custom field)
 *                 JIRA_MODE = off | dry (default: plan only, nothing is written to Jira) | ask (plan, a person applies it with npm run jira:apply) | auto (plan and apply)
 * The token is never printed or written to any file.
 */
export type JiraMode = 'off' | 'dry' | 'ask' | 'auto';
export interface JiraConfig { base: string; email: string; token: string; project: string; issueType: string; priority: string; component: string; labels: string[]; extra: Record<string, unknown>; mode: JiraMode }

export function jiraMode(): JiraMode {
  const m = String(process.env.JIRA_MODE || 'dry').trim().toLowerCase();
  return m === 'off' || m === 'ask' || m === 'auto' ? (m as JiraMode) : m === 'dry' ? 'dry' : 'dry';
}

export function jiraConfig(): JiraConfig {
  let extra: Record<string, unknown> = {};
  try { const raw = (process.env.JIRA_EXTRA_FIELDS || '').trim(); if (raw) extra = JSON.parse(raw); } catch { /* ignore a broken JSON: the create call shows the Jira error */ }
  return {
    base: (process.env.JIRA_BASE_URL || 'https://testable.atlassian.net').trim().replace(/\/+$/, ''),
    email: (process.env.JIRA_EMAIL || '').trim(), token: (process.env.JIRA_API_TOKEN || '').trim(),
    project: (process.env.JIRA_PROJECT || 'TP').trim(), issueType: (process.env.JIRA_ISSUE_TYPE || 'Bug').trim(),
    priority: (process.env.JIRA_PRIORITY ?? 'Highest').trim(), component: (process.env.JIRA_COMPONENT || '').trim(),
    labels: (process.env.JIRA_LABELS || '').split(',').map((s) => s.trim()).filter(Boolean),
    extra, mode: jiraMode(),
  };
}
export const jiraReady = (c: JiraConfig = jiraConfig()) => !!(c.email && c.token);

export interface JiraIssue { key: string; summary: string; status: string; statusCategory: string; labels: string[]; updated: string; description: string; attachments: string[]; url: string }

/** Atlassian document format -> plain text (the description of an issue read through the v3 search). */
export function adfText(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfText).join('');
  const t = node.type;
  if (t === 'text') return String(node.text || '');
  if (t === 'hardBreak') return '\n';
  const inner = adfText(node.content);
  if (['paragraph', 'heading', 'listItem', 'tableRow', 'codeBlock', 'blockquote', 'panel'].includes(t)) return inner + '\n';
  if (t === 'tableCell' || t === 'tableHeader') return inner.replace(/\n+$/, '') + ' | ';
  return inner;
}

export function toIssue(base: string, n: any): JiraIssue {
  const f = n.fields || {};
  return {
    key: String(n.key), summary: String(f.summary || ''), status: String(f.status?.name || ''), statusCategory: String(f.status?.statusCategory?.key || ''),
    labels: Array.isArray(f.labels) ? f.labels.map(String) : [], updated: String(f.updated || ''),
    description: typeof f.description === 'string' ? f.description : adfText(f.description),
    attachments: Array.isArray(f.attachment) ? f.attachment.map((a: any) => String(a.filename || '')).filter(Boolean) : [],
    url: `${base}/browse/${n.key}`,
  };
}

export class JiraError extends Error { constructor(msg: string, public status = 0) { super(msg); } }

export class JiraClient {
  constructor(public cfg: JiraConfig = jiraConfig()) {}
  private auth() { return 'Basic ' + Buffer.from(`${this.cfg.email}:${this.cfg.token}`).toString('base64'); }
  /** one call, up to 3 tries on a network error / HTTP 429 / 5xx. The token is never part of an error text. */
  async call(method: string, url: string, body?: unknown, extra: Record<string, string> = {}, raw?: FormData): Promise<any> {
    if (!jiraReady(this.cfg)) throw new JiraError('Jira is not set up: add JIRA_EMAIL and JIRA_API_TOKEN to .env');
    let last: Error = new Error('Jira call failed');
    for (let i = 0; i < 3; i++) {
      if (i) await new Promise((r) => setTimeout(r, 2000 * i));
      try {
        const res = await fetch(`${this.cfg.base}${url}`, {
          method, signal: AbortSignal.timeout(60_000),
          headers: { Authorization: this.auth(), Accept: 'application/json', ...(raw ? {} : body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra },
          body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
        });
        if (res.status === 429 || res.status >= 500) { last = new JiraError(`Jira answered HTTP ${res.status}`, res.status); continue; }
        const txt = await res.text();
        if (!res.ok) throw new JiraError(`Jira answered HTTP ${res.status}${res.status === 401 ? ' (check JIRA_EMAIL and JIRA_API_TOKEN)' : res.status === 403 ? ' (this account may not do this in the project)' : ''}: ${txt.replace(/\s+/g, ' ').slice(0, 400)}`, res.status);
        return txt ? JSON.parse(txt) : {};
      } catch (e) {
        if (e instanceof JiraError && e.status && e.status < 500 && e.status !== 429) throw e;
        last = e instanceof Error ? e : new Error(String(e));
      }
    }
    throw last;
  }

  /** every issue of a JQL search (pages of 100) */
  async search(jql: string, fields = ['summary', 'status', 'labels', 'updated', 'description', 'attachment']): Promise<JiraIssue[]> {
    const out: JiraIssue[] = []; let token: string | undefined;
    for (let page = 0; page < 60; page++) {
      const r = await this.call('POST', '/rest/api/3/search/jql', { jql, fields, maxResults: 100, ...(token ? { nextPageToken: token } : {}) });
      for (const n of r.issues || []) out.push(toIssue(this.cfg.base, n));
      token = r.nextPageToken; if (!token || r.isLast) break;
    }
    return out;
  }
  async comments(key: string): Promise<string[]> {
    const r = await this.call('GET', `/rest/api/2/issue/${encodeURIComponent(key)}/comment?maxResults=100&orderBy=-created`);
    return (r.comments || []).map((c: any) => typeof c.body === 'string' ? c.body : adfText(c.body));
  }
  /** description / comment bodies are Jira wiki markup (REST v2) */
  async create(summary: string, description: string, labels: string[]): Promise<{ key: string; url: string }> {
    const c = this.cfg;
    const fields: Record<string, unknown> = { project: { key: c.project }, issuetype: { name: c.issueType }, summary: summary.slice(0, 250), description, labels: [...new Set([...c.labels, ...labels])].map((l) => l.replace(/\s+/g, '-')), ...c.extra };
    if (c.priority) fields.priority = { name: c.priority };
    if (c.component) fields.components = [{ name: c.component }];
    const r = await this.call('POST', '/rest/api/2/issue', { fields });
    return { key: String(r.key), url: `${c.base}/browse/${r.key}` };
  }
  async comment(key: string, body: string): Promise<void> { await this.call('POST', `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { body }); }
  async attach(key: string, file: string, asName?: string): Promise<boolean> {
    try {
      const st = fs.statSync(file); if (!st.isFile() || st.size > 9_500_000) return false;
      const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(file)]), asName || path.basename(file));
      await this.call('POST', `/rest/api/2/issue/${encodeURIComponent(key)}/attachments`, undefined, { 'X-Atlassian-Token': 'no-check' }, fd);
      return true;
    } catch { return false; }
  }
}
