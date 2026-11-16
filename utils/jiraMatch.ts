import type { BugFact, RunFacts } from './jiraFacts';
import type { JiraIssue } from './jira';

/**
 * Is a bug of this run already in Jira? Works on the local copy of the OPEN bugs (no network here, so it is testable).
 *  - the bugs of a run are GROUPED by cause: every not-placed tool of one run is one group (one ticket, like TP-6370); a runner failure is one group per tool
 *  - a tool is matched to an open ticket that NAMES it (summary, description, attachment names; name variants like coverage.py / coverage-py)
 *  - CONFIDENT only when the ticket does not describe a different cause AND (it names this branch, or [planning] same language + version + the same cause words / [runner] the same cause words)
 *  - anything less is POSSIBLE: a person decides, the script never acts on it
 * Result per group: comment on the ticket(s) that confidently cover tools, create one new bug for the tools nobody covers, review for the doubtful ones.
 */
export interface Group { key: string; kind: 'planning' | 'runner' | 'other'; tag: string; tools: BugFact[] }
export interface MatchCtx { branch: string; language: string; version: string }
export type Level = 'confident' | 'possible' | 'none';
export interface ToolMatch { tool: string; level: Level; key?: string; score: number; why: string; candidates: { key: string; score: number; why: string }[] }
export type Action =
  | { type: 'comment'; key: string; url?: string; tools: string[]; why: string }
  | { type: 'create'; tools: string[]; why: string }
  | { type: 'review'; tools: string[]; keys: string[]; why: string }
  | { type: 'skip'; tools: string[]; key?: string; why: string };

export function groupBugs(bugs: BugFact[]): Group[] {
  const out: Group[] = []; const planning = bugs.filter((b) => /Planning/i.test(b.tag));
  if (planning.length) out.push({ key: 'planning', kind: 'planning', tag: 'Planning Defect', tools: planning });
  for (const b of bugs) {
    if (/Planning/i.test(b.tag)) continue;
    out.push({ key: `${/Runner/i.test(b.tag) ? 'runner' : 'other'}:${b.tag}:${b.tool}`, kind: /Runner/i.test(b.tag) ? 'runner' : 'other', tag: b.tag, tools: [b] });
  }
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** coverage-py -> coverage-py, coverage.py, coverage py, coverage_py, coveragepy */
export function nameVariants(tool: string): string[] {
  const t = tool.toLowerCase(); const parts = t.split(/[-_.\s]+/).filter(Boolean);
  if (parts.length < 2) return [t];
  return [...new Set([t, parts.join('-'), parts.join('.'), parts.join(' '), parts.join('_'), parts.join('')])];
}
export function mentions(text: string, tool: string): boolean {
  const low = text.toLowerCase();
  return nameVariants(tool).some((v) => new RegExp(`(^|[^a-z0-9])${esc(v)}([^a-z0-9]|$)`).test(low));
}

const CAUSE: Record<Group['kind'], RegExp> = {
  planning: /unplaceable|execution_runtime_unavailable|host_runtime_unavailable|planning gap|not planned|not (scheduled|placed|executed|dispatched)|no (available )?runtime/i,
  runner: /exit(ed)? (code )?127|could not start|missing runtime|runtime dependenc|command not found|binary (is )?missing|permanent_runner_error|failed to (start|run)/i,
  other: /$^/,
};
const OTHER_CAUSES = /runtime_image_drift|task_exceeds_tenant_memory_limit|not_applicable|missing_binary|stale (confidence|taxonomy)|image drift/i;

const langWord = (language: string) => language.toLowerCase().replace('#', '(#|sharp)');

export function matchTool(tool: string, g: Group, ctx: MatchCtx, issues: JiraIssue[]): ToolMatch {
  const cands: { key: string; score: number; why: string; level: Level }[] = [];
  const ver = ctx.version.replace(/^\D+/, ''); const verRe = ver ? new RegExp(`(^|[^0-9])${esc(ver)}([^0-9]|$)`) : null;
  const verCompact = ver.replace(/\./g, '');
  for (const is of issues) {
    const text = `${is.summary}\n${is.description}\n${is.attachments.join(' ')}`;
    if (!mentions(text, tool)) continue;
    const branch = !!ctx.branch && text.toLowerCase().includes(ctx.branch.toLowerCase());
    const lang = new RegExp(langWord(ctx.language), 'i').test(text) || /(^|[^a-z])py([^a-z]|$)/i.test(text) && /python/i.test(ctx.language);
    const version = !!verRe && (verRe.test(text) || (verCompact.length > 1 && text.toLowerCase().includes(`v${verCompact}`)));
    const cause = CAUSE[g.kind].test(text);
    const otherCause = OTHER_CAUSES.test(text) && !cause;
    let level: Level = 'possible'; const why: string[] = ['names the tool'];
    if (branch) why.push('same branch'); if (lang && version) why.push(`${ctx.language} ${ver}`); if (cause) why.push('same cause'); if (otherCause) why.push('describes a different cause');
    if (!otherCause) {
      if (g.kind === 'planning' && (branch || (lang && version && cause))) level = 'confident';
      else if (g.kind === 'runner' && cause) level = 'confident';
      else if (g.kind === 'other' && branch && lang && version) level = 'confident';
    }
    cands.push({ key: is.key, score: 1 + (branch ? 3 : 0) + (lang && version ? 2 : 0) + (cause ? 2 : 0) - (otherCause ? 3 : 0), why: why.join(', '), level });
  }
  cands.sort((a, b) => b.score - a.score || b.key.localeCompare(a.key));
  const best = cands.find((c) => c.level === 'confident');
  const view = cands.slice(0, 3).map((c) => ({ key: c.key, score: c.score, why: c.why }));
  if (best) return { tool, level: 'confident', key: best.key, score: best.score, why: best.why, candidates: view };
  if (cands.length) return { tool, level: 'possible', score: cands[0].score, why: cands[0].why, candidates: view };
  return { tool, level: 'none', score: 0, why: 'no open ticket names this tool', candidates: [] };
}

export interface FiledRecord { runId: string; tool: string; key: string; action: string; at: string }

/** the actions for one group: comment per ticket, one create for the uncovered tools, one review for the doubtful ones */
export function planGroup(g: Group, ctx: MatchCtx, issues: JiraIssue[], runId: string, filed: FiledRecord[] = []): Action[] {
  const actions: Action[] = []; const toCreate: string[] = []; const byKey = new Map<string, string[]>(); const review = new Map<string, string[]>(); const done: string[] = [];
  const byKeyUrl = new Map(issues.map((i) => [i.key, i.url] as const));
  for (const b of g.tools) {
    const f = filed.find((x) => x.runId === runId && x.tool === b.tool);
    if (f) { done.push(`${b.tool} (${f.key})`); continue; }
    const m = matchTool(b.tool, g, ctx, issues);
    if (m.level === 'confident' && m.key) byKey.set(m.key, [...(byKey.get(m.key) || []), b.tool]);
    else if (m.level === 'possible') { const k = m.candidates.map((c) => c.key).join(', '); review.set(k, [...(review.get(k) || []), b.tool]); }
    else toCreate.push(b.tool);
  }
  if (done.length) actions.push({ type: 'skip', tools: done.map((d) => d.split(' ')[0]), why: `already logged for this run: ${done.join(', ')}` });
  for (const [key, tools] of byKey) actions.push({ type: 'comment', key, url: byKeyUrl.get(key), tools, why: `open ticket ${key} already covers ${tools.join(', ')} (same cause${g.kind === 'planning' ? ', same branch or ' + ctx.language + ' ' + ctx.version : ''})` });
  for (const [keys, tools] of review) actions.push({ type: 'review', tools, keys: keys.split(', '), why: `${tools.join(', ')}: ticket(s) ${keys} name the tool but are not clearly the same bug; a person decides` });
  if (toCreate.length) actions.push({ type: 'create', tools: toCreate, why: `no open ticket names ${toCreate.join(', ')}` });
  return actions;
}

/**
 * One ticket per branch run (TP-6335): is there an OPEN ticket for this branch that names this run's tools or causes?
 *  - confident: it names the branch AND (names one of the bug tools OR one of the cause codes) and does not describe a different cause -> comment
 *  - possible : it names 2+ of the tools but not the branch (same language/version only)                                    -> a person decides
 *  - none                                                                                                                   -> create
 */
export function planRun(f: RunFacts, issues: JiraIssue[], filed: FiledRecord[] = []): Action[] {
  const tools = f.bugs.map((b) => b.tool); if (!tools.length) return [];
  const f1 = filed.filter((x) => x.runId === f.runId && tools.includes(x.tool));
  if (tools.every((t) => f1.some((x) => x.tool === t))) return [{ type: 'skip', tools, key: f1[0]?.key, why: `already logged for this run (${[...new Set(f1.map((x) => x.key))].join(', ')})` }];
  const causes = [...new Set(f.bugs.flatMap((b) => [b.placement?.reason, b.failure?.errorCode].filter(Boolean) as string[]))];
  const conf: { key: string; url?: string; why: string; score: number }[] = []; const poss: { key: string; why: string; score: number }[] = [];
  for (const is of issues) {
    const text = `${is.summary}\n${is.description}\n${is.attachments.join(' ')}`; const low = text.toLowerCase();
    const branch = !!f.branch && low.includes(f.branch.toLowerCase());
    const named = tools.filter((t) => mentions(text, t)); const cause = causes.filter((c) => low.includes(c.toLowerCase()));
    const other = OTHER_CAUSES.test(text) && !cause.length;
    const why = [branch ? 'same branch' : '', named.length ? `names ${named.join(', ')}` : '', cause.length ? `same cause ${cause.join(', ')}` : '', other ? 'describes a different cause' : ''].filter(Boolean).join('; ');
    const score = (branch ? 3 : 0) + named.length + cause.length * 2 - (other ? 3 : 0);
    if (branch && (named.length || cause.length) && !other) conf.push({ key: is.key, url: is.url, why, score });
    else if (named.length >= 2 || (branch && named.length)) poss.push({ key: is.key, why, score });
  }
  conf.sort((a, b) => b.score - a.score || b.key.localeCompare(a.key)); poss.sort((a, b) => b.score - a.score || b.key.localeCompare(a.key));
  if (conf.length) return [{ type: 'comment', key: conf[0].key, url: conf[0].url, tools, why: `open ticket ${conf[0].key} already covers this branch (${conf[0].why})` }];
  if (poss.length) return [{ type: 'review', tools, keys: poss.slice(0, 3).map((x) => x.key), why: `ticket(s) ${poss.slice(0, 3).map((x) => `${x.key} (${x.why})`).join('; ')} are not clearly this branch's bug; a person decides` }];
  return [{ type: 'create', tools, why: `no open ticket covers branch ${f.branch} for ${tools.join(', ')}` }];
}
