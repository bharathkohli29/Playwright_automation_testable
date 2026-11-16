import * as fs from 'fs';
import * as path from 'path';
import { JiraClient, JiraConfig, JiraError, JiraIssue, jiraConfig, jiraMode, jiraReady } from './jira';
import { CACHE_DIR, JiraCache, loadCache, saveCache, syncCache } from './jiraCache';
import { attName, attachmentsOf, commentText, createText, runAttachments, runComment, runText } from './jiraDraft';
import { writeResultsXlsx } from './jiraResults';
import { RunFacts, collectFacts } from './jiraFacts';
import { FiledRecord, groupBugs, planGroup, planRun } from './jiraMatch';

/**
 * The Jira step of a branch: read the bugs of the run -> is each already in an OPEN ticket (local copy of the project's open bugs, synced first) ->
 * plan: comment on the ticket that covers it / create one new bug for the uncovered tools / review (a person decides) -> write the plan and the texts
 * -> JIRA_MODE=auto also does it. Nothing is written to Jira in dry (default) and ask mode; ask is applied by a person with npm run jira:apply -- "<branch folder>".
 */
export interface PlanItem {
  id: string; group: string; action: 'create' | 'comment' | 'review' | 'skip'; key?: string; url?: string; tools: string[]; title?: string; why: string;
  draftFile?: string; attachments: string[]; labels?: string[]; status: 'planned' | 'done' | 'failed' | 'held'; result?: string; keys?: string[];
}
export interface JiraPlan { mode: string; createdAt: string; branch: string; runId: string; language: string; version: string; project: string; checked: boolean; note: string; items: PlanItem[] }
interface Built extends PlanItem { text: string }

const FILED = () => path.join(CACHE_DIR(), 'filed.json');
export function loadFiled(): FiledRecord[] { try { const j = JSON.parse(fs.readFileSync(FILED(), 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } }
function saveFiled(a: FiledRecord[]) { fs.mkdirSync(CACHE_DIR(), { recursive: true }); fs.writeFileSync(FILED(), JSON.stringify(a, null, 1)); }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** run (default): ONE ticket per branch run, the layout of TP-6335. cause: one ticket per cause group (older behaviour). Set JIRA_GROUPING=cause for that. */
export type Grouping = 'run' | 'cause';
export const jiraGrouping = (): Grouping => (process.env.JIRA_GROUPING || 'run').toLowerCase() === 'cause' ? 'cause' : 'run';

function buildRunItems(f: RunFacts, issues: JiraIssue[], filed: FiledRecord[]): Built[] {
  const items: Built[] = []; let n = 0; const tools = f.bugs.map((b) => b.tool);
  for (const a of planRun(f, issues, filed)) {
    n++; const id = `${String(n).padStart(2, '0')}_${a.type}_${slug(f.branch)}`; const base = { id, group: 'run', tools: a.tools, why: a.why, attachments: runAttachments(f), status: 'planned' as const };
    if (a.type === 'create') { const c = runText(f); items.push({ ...base, action: 'create', title: c.summary, labels: c.labels, text: c.description }); }
    else if (a.type === 'comment') items.push({ ...base, action: 'comment', key: a.key, url: a.url, text: runComment(f) });
    else if (a.type === 'review') items.push({ ...base, action: 'review', keys: a.keys, status: 'held', text: `A person decides: ${a.why}\n\n` + runText(f).description });
    else items.push({ ...base, action: 'skip', key: a.key, status: 'done', attachments: [], text: a.why });
  }
  void tools; return items;
}

export function buildItems(f: RunFacts, issues: JiraIssue[], filed: FiledRecord[], checked: boolean, grouping: Grouping = jiraGrouping()): Built[] {
  if (grouping === 'run') return buildRunItems(f, issues, filed);
  const items: Built[] = []; let n = 0;
  const ctx = { branch: f.branch, language: f.language, version: f.version };
  for (const g of groupBugs(f.bugs)) {
    for (const a of planGroup(g, ctx, issues, f.runId, filed)) {
      const tools = f.bugs.filter((b) => a.tools.includes(b.tool)); n++;
      const id = `${String(n).padStart(2, '0')}_${a.type}_${slug(g.key === 'planning' ? tools.map((t) => t.tool).join('-') : g.key)}`;
      const base = { id, group: g.key, tools: a.tools, why: a.why, attachments: attachmentsOf(tools), status: 'planned' as const };
      if (a.type === 'create') { const c = createText(f, g, tools); items.push({ ...base, action: 'create', title: c.summary, labels: c.labels, text: c.description }); }
      else if (a.type === 'comment') items.push({ ...base, action: 'comment', key: a.key, url: a.url, text: commentText(f, g, tools) });
      else if (a.type === 'review') items.push({ ...base, action: 'review', keys: a.keys, status: 'held', text: `A person decides: ${a.why}\n\n` + createText(f, g, tools).description });
      else items.push({ ...base, action: 'skip', key: a.key, status: 'done', text: a.why });
    }
  }
  void checked; return items;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
export function summaryLine(items: { action: string; key?: string; status?: string }[]): string {
  const c = (a: string) => items.filter((i) => i.action === a).length;
  const parts = [c('comment') ? `${plural(c('comment'), 'comment')} (${[...new Set(items.filter((i) => i.action === 'comment').map((i) => i.key))].join(', ')})` : '', c('create') ? `${c('create')} new` : '', c('review') ? `${c('review')} for a person` : '', c('skip') ? `${c('skip')} already logged` : ''].filter(Boolean);
  return parts.join(' · ') || 'nothing to log';
}

function writePlan(dir: string, plan: JiraPlan, built: Built[]): void {
  const dd = path.join(dir, 'bugs', 'jira-drafts'); fs.mkdirSync(dd, { recursive: true });
  for (const f of fs.readdirSync(dd)) if (/\.md$/.test(f)) fs.rmSync(path.join(dd, f), { force: true });
  for (const b of built) {
    const it = plan.items.find((x) => x.id === b.id)!; it.draftFile = `bugs/jira-drafts/${b.id}.md`;
    fs.writeFileSync(path.join(dd, `${b.id}.md`), [`# ${b.action.toUpperCase()}${b.key ? ' ' + b.key : ''}: ${b.title || b.tools.join(', ')}`, '', `Why: ${b.why}`, `Tools: ${b.tools.join(', ')}`, b.labels ? `Labels: ${b.labels.join(', ')}` : '', `Attachments: ${b.attachments.map((a) => attName(a, plan.runId.slice(0, 8))).join(', ') || '-'}`, '', '---', '', b.text].filter((x, i) => x !== '' || i > 3).join('\n'));
  }
  fs.writeFileSync(path.join(dir, 'jira-plan.json'), JSON.stringify(plan, null, 1));
  const md = [`# Jira plan: ${plan.branch}`, '', `Run ${plan.runId} · ${plan.language} ${plan.version} · mode ${plan.mode} · project ${plan.project}`, plan.note, '', ...plan.items.map((i) => `* **${i.action.toUpperCase()}**${i.key ? ' ' + i.key : ''} [${i.status}]: ${i.tools.join(', ')}. ${i.why}${i.result ? ' → ' + i.result : ''}${i.draftFile ? ` (${i.draftFile})` : ''}`)];
  fs.writeFileSync(path.join(dir, 'jira-plan.md'), md.join('\n'));
}

export interface StepResult { detail: string; executed: boolean }

/** plan (always) and, when execute is true and Jira is readable, do it */
export async function runJira(dir: string, opts: { execute: boolean; log?: (m: string) => void; cfg?: JiraConfig; client?: JiraClient }): Promise<StepResult | null> {
  const log = opts.log || (() => {}); const cfg = opts.cfg || jiraConfig(); const client = opts.client || new JiraClient(cfg);
  const f = collectFacts(dir); if (!f || !f.bugs.length) { for (const x of ['jira-plan.json', 'jira-plan.md']) { try { fs.rmSync(path.join(dir, x), { force: true }); } catch { /* ignore */ } } return null; }
  let cache: JiraCache = loadCache(cfg.project); let checked = false; let note = '';
  if (jiraReady(cfg)) {
    try { cache = await syncCache(client, log); checked = true; note = `Jira checked ${new Date().toISOString()}: ${cache.issues.length} open ${cfg.issueType.toLowerCase()}(s) in ${cfg.project}.`; }
    catch (e) { note = `Jira could not be read (${e instanceof Error ? e.message : e}); matched against the last local copy${cache.lastSync ? ` of ${cache.lastSync}` : ' (none yet)'} - nothing is created or commented.`; }
  } else note = `JIRA_EMAIL / JIRA_API_TOKEN not set: matched against the local copy${cache.lastSync ? ` of ${cache.lastSync}` : ' (none yet)'}; nothing is created or commented.`;
  f.resultsXlsx = await writeResultsXlsx(f);
  const built = buildItems(f, cache.issues, loadFiled(), checked);
  const plan: JiraPlan = { mode: cfg.mode, createdAt: new Date().toISOString(), branch: f.branch, runId: f.runId, language: f.language, version: f.version, project: cfg.project, checked, note, items: built.map((b) => { const { text: _t, ...i } = b; void _t; return i; }) };
  writePlan(dir, plan, built);
  const doIt = opts.execute && checked && cfg.mode !== 'off';
  if (opts.execute && !checked) log('Jira: not applied: Jira could not be read this time (the plan is saved)');
  if (!doIt) { const d = `plan: ${summaryLine(plan.items)}${cfg.mode === 'auto' ? '' : ' (nothing sent to Jira)'}`; log(`Jira ${d}`); return { detail: d, executed: false }; }

  const filed = loadFiled();
  for (const b of built) {
    const it = plan.items.find((x) => x.id === b.id)!; if (it.status !== 'planned') continue;
    const tools = f.bugs.filter((x) => b.tools.includes(x.tool));
    try {
      let key = b.key || '';
      if (b.action === 'create') { const r = await client.create(b.title || '', b.text, b.labels || []); key = r.key; it.key = key; it.url = r.url; cache.issues.unshift({ key, summary: b.title || '', status: 'To Do', statusCategory: 'new', labels: b.labels || [], updated: new Date().toISOString(), description: b.text, attachments: [], url: r.url }); }
      else {
        const old = await client.comments(key);
        if (old.some((c) => c.includes(f.runId))) { it.status = 'done'; it.result = `${key} already has a comment for this run`; for (const t of b.tools) filed.push({ runId: f.runId, tool: t, key, action: 'comment', at: new Date().toISOString() }); continue; }
        await client.comment(key, b.text);
      }
      let n = 0; for (const a of b.attachments) if (await client.attach(key, a, attName(a, f.short))) n++;
      it.status = 'done'; it.result = `${b.action === 'create' ? 'created' : 'commented on'} ${key}, ${n}/${b.attachments.length} file(s) attached`;
      for (const t of b.tools) filed.push({ runId: f.runId, tool: t, key, action: b.action, at: new Date().toISOString() });
      log(`Jira: ${it.result} (${b.tools.join(', ')})`);
    } catch (e) { it.status = 'failed'; it.result = e instanceof JiraError || e instanceof Error ? e.message.slice(0, 300) : String(e); log(`Jira: ${b.action} for ${b.tools.join(', ')} failed: ${it.result}`); }
  }
  saveFiled(filed); saveCache(cache); writePlan(dir, plan, built);
  const failed = plan.items.filter((i) => i.status === 'failed').length;
  const d = `${summaryLine(plan.items.map((i) => ({ ...i, key: i.key })))}${failed ? ` · ${failed} failed (see jira-plan.md)` : ''}`;
  return { detail: d, executed: true };
}

/** the post-processing step: plan, and apply in auto mode. 'skipped' when off or there is nothing to log. */
export async function jiraStep(dir: string, log: (m: string) => void = () => {}): Promise<string> {
  const mode = jiraMode(); if (mode === 'off') return 'skipped';
  const r = await runJira(dir, { execute: mode === 'auto', log }); return r ? r.detail : 'skipped';
}

/** one line for the Teams card, from jira-plan.json */
export function jiraCardLine(dir: string): string {
  try {
    const p: JiraPlan = JSON.parse(fs.readFileSync(path.join(dir, 'jira-plan.json'), 'utf8')); if (!p.items.length) return '';
    const done = p.items.some((i) => i.status === 'done' && i.action !== 'skip' && i.result);
    const links = p.items.filter((i) => i.status === 'done' && i.key && i.action !== 'skip').map((i) => `${i.key} (${i.action === 'create' ? 'new' : 'commented'})`);
    if (done) return `🎫 Jira: ${[...new Set(links)].join(', ')}${p.items.some((i) => i.action === 'review') ? ` · ${p.items.filter((i) => i.action === 'review').length} for a person` : ''}`;
    return `🎫 Jira ${p.mode === 'auto' ? 'plan' : 'dry run, nothing sent'}: ${summaryLine(p.items)}`;
  } catch { return ''; }
}

