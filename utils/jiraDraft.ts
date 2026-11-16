import * as crypto from 'crypto';
import * as path from 'path';
import type { BugFact, RunFacts } from './jiraFacts';
import type { Group } from './jiraMatch';

/**
 * The text of a bug in the layout of the hand-written ones (TP-6370): Environment, Summary, Affected tools, Evidence, Root cause, Suggested fix,
 * Acceptance criteria, Attachments. Jira wiki markup (REST v2): ||head|| / |cell| tables, h2. headings, * bullets, {{mono}}.
 */
const cell = (s: string) => String(s || '-').replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '-';
const row = (...c: string[]) => `|${c.map(cell).join('|')}|`;
const head = (...c: string[]) => `||${c.map(cell).join('||')}||`;
const tick = (s: string) => `{{${s}}}`;

export const fingerprint = (f: RunFacts, g: Group, tools: string[]): string =>
  'wb-fp-' + crypto.createHash('sha1').update([f.langKey, f.version, f.branch, g.kind === 'planning' ? 'planning' : g.key, [...tools].sort().join(',')].join('|')).digest('hex').slice(0, 10);

const REASON_FIX: Record<string, string> = {
  EXECUTION_RUNTIME_UNAVAILABLE: 'Make an execution runtime available for the tool\'s coupling (DECOUPLED or TARGET_COMPATIBLE) in the cell, so the planner can place it.',
  HOST_RUNTIME_UNAVAILABLE: 'Register the missing runtime family (see the detail in the log line), or correct the tool\'s compatibility rule.',
};

const reasonOf = (b: BugFact) => b.placement ? `${b.placement.reason}${b.placement.coupling ? ` (${b.placement.coupling})` : ''}` : b.failure?.errorCode || b.observed;

export function titleFor(f: RunFacts, g: Group, tools: BugFact[]): string {
  const lang = `${f.language} ${f.version}`;
  if (g.kind === 'planning') {
    const reasons = [...new Set(tools.map((t) => t.placement?.reason).filter(Boolean))] as string[];
    return `${lang} ${f.branch.replace(/^(PY|JS|TS|CS|JV|JAVA)_V?\d+_?/i, '') || f.branch}: ${tools.map((t) => t.tool).join(' / ')} not executed on whitebox run ${f.short}${reasons.length ? ` (${reasons.join(' / ')})` : ' (planning gap)'}`;
  }
  const b = tools[0]; if (b.summary) return `${b.summary} (run ${f.short})`;
  return `[Whitebox][${lang}][${b.tool}] ${/Runner/i.test(b.tag) ? 'Tool failed to run on the worker' : b.tag}${b.failure?.reason ? `: ${b.failure.reason.slice(0, 80)}` : ''} (run ${f.short})`;
}

function envTable(f: RunFacts): string {
  return [head('Field', 'Value'), row('Repo', tick(f.repo || '-')), row('Branch', tick(f.branch)), row('Run ID', tick(f.runId)), row('Commit', tick(f.commit || '-')), row(f.language, f.version), row('Build', f.buildLine || '-'),
    row('Cluster', f.cluster), ...(f.runLine ? [row('Run result', f.runLine)] : []), row('Evidence', 'S3 run folder, taxonomy gate HTML, qa-eks orchestrator and worker logs, RCA reports (attached)')].join('\n');
}

/** the evidence lines of one tool */
function evidence(b: BugFact, f: RunFacts): string[] {
  const out: string[] = [];
  if (b.placement) out.push(`* QA-EKS ({{wb-orchestrator}}): {{planning.${b.placement.via}}}: ${tick(b.placement.reason)}${b.placement.detail ? ` - ${cell(b.placement.detail)}` : ''}${b.placement.version ? ` (tool version ${b.placement.version})` : ''}`);
  if (b.failure) out.push(`* S3 {{${b.tool}/.../failure.json}}: ${tick(b.failure.errorCode || 'failed')} - ${cell(b.failure.reason)}${b.failure.version ? ` (tool version ${b.failure.version})` : ''}`);
  if (!b.failure) out.push(`* S3: no {{${b.tool}/}} folder in run ${f.short}${b.placement ? '; the task was never started' : ''}.`);
  out.push(`* Our check: ${cell(b.note).slice(0, 400)}`);
  return out;
}

/** TP-6370 style description for the tools of one group that nobody has a ticket for */
export function createText(f: RunFacts, g: Group, tools: BugFact[]): { summary: string; description: string; labels: string[] } {
  const names = tools.map((t) => t.tool);
  const reasons = [...new Set(tools.map((t) => t.placement?.reason).filter(Boolean))] as string[];
  const parts: string[] = [];
  parts.push('h2. Environment', envTable(f), '');
  parts.push('h2. Summary');
  if (g.kind === 'planning') parts.push(`${tools.length} tool(s) that the platform lists as expected for ${f.language} ${f.version} produced no S3 folder in this run: ${names.map((n) => `*${n}*`).join(', ')}. ${reasons.length ? `The QA-EKS orchestrator log shows why: the planner could not place them (${reasons.map(tick).join(', ')}), so no task was started.` : 'No task was started for them.'} This is a planning / placement defect on the platform, not a repository problem.`);
  else parts.push(`*${names[0]}* ${/Runner/i.test(g.tag) ? 'ran as a task but failed on the worker' : `has a ${g.tag}`}. ${tools[0].failure ? `The run has {{failure.json}} instead of a report: ${cell(tools[0].failure.reason)}.` : cell(tools[0].note)}`);
  parts.push('', 'h2. Affected tools', head('Tool', 'Role in our matrix', 'S3 folder', 'Reason', 'Valid defect?'),
    ...tools.map((t) => row(t.tool, [t.kind, t.metrics].filter(Boolean).join(': ') || '-', t.failure ? 'failure.json only' : 'none', reasonOf(t), 'Yes')));
  if (g.kind === 'planning' && f.placementOnly.length) parts.push('', `Also not placed in this run but *not a bug* (their primary or secondary tool ran): ${f.placementOnly.map((p) => p.tool).join(', ')}.`);
  parts.push('', 'h2. Evidence');
  for (const t of tools) parts.push(`h3. ${t.tool}`, ...evidence(t, f));
  parts.push('', 'h2. Root cause (evidence-based)');
  if (g.kind === 'planning') parts.push(`The orchestrator planning step found the tools eligible but could not place them on an available runtime${reasons.length ? ` (${reasons.map(tick).join(', ')})` : ''}, so nothing was dispatched. Code references are in the attached RCA reports (platform {{qa}} checkout, read-only).`);
  else parts.push(/127/.test(tools[0].failure?.reason || '') ? `Exit 127 means the command was not found: the binary is missing from the analyzer job image. The tool is registered but cannot start there. See the attached RCA report.` : 'See the attached RCA report: it lists the pod attempts, the log lines and the platform code that raises the error.');
  parts.push('', 'h2. Suggested fix');
  if (g.kind === 'planning') { const fixes = [...new Set(reasons.map((r) => REASON_FIX[r]).filter(Boolean))]; (fixes.length ? fixes : ['Make the planner place these tools (runtime availability / compatibility), then re-run.']).forEach((x) => parts.push(`# ${x}`)); parts.push(`# Re-run branch ${tick(f.branch)} on qa-eks and confirm the S3 folders: ${names.map((n) => tick(n + '/')).join(', ')}.`); }
  else { parts.push(/127/.test(tools[0].failure?.reason || '') ? `# Install or expose the tool's binary (and its runtime, if it needs one) in the analyzer job image.` : '# Fix the cause shown in the attached RCA report.'); parts.push(`# Re-run branch ${tick(f.branch)} and check that ${tick(names[0] + '/')} holds a report, not {{failure.json}}.`); }
  parts.push('', 'h2. Acceptance criteria', ...names.map((n) => `* ${tick(n + '/')} is present with valid output on a re-run of this branch.`));
  if (g.kind === 'planning') parts.push(`* {{planning.tools_unplaceable}} lists none of: ${names.join(', ')}.`);
  parts.push('', 'h2. Attachments', ...tools.map((t) => `* ${[t.defectPdf, t.rcaPdf, t.screenshot].filter(Boolean).map((p) => `[^${attName(p as string, f.short)}]`).join(' ') || `(no files for ${t.tool})`}`));
  parts.push('', '_Filed by the White-box tool-validation script. Run ' + f.runId + '._');
  return { summary: titleFor(f, g, tools), description: parts.join('\n'), labels: ['whitebox', f.langKey, 'tool-trigger', 'platform-defect', fingerprint(f, g, names)] };
}

/** a comment for an existing open ticket: this run saw the same bug again */
export function commentText(f: RunFacts, g: Group, tools: BugFact[]): string {
  const lines: string[] = [`*Seen again* on run {{${f.runId}}} (branch {{${f.branch}}}, ${f.language} ${f.version}, commit {{${(f.commit || '').slice(0, 10)}}}).`, '', head('Tool', 'This run', 'Detail')];
  for (const t of tools) lines.push(row(t.tool, t.failure ? 'failed (failure.json)' : 'no S3 folder', [t.placement ? `${t.placement.reason}${t.placement.detail ? ': ' + t.placement.detail : ''}` : '', t.failure ? t.failure.reason : ''].filter(Boolean).join(' ') || cell(t.note).slice(0, 200)));
  lines.push('', 'The RCA report and the defect report of each tool are attached. This comment was added by the White-box tool-validation script.');
  return lines.join('\n');
}

/** the name a file gets in Jira: the run id is added, so a ticket that gets files of several runs does not hold several files with one name */
export const attName = (file: string, short: string): string => { const b = path.basename(file); if (b.includes(short)) return b; const e = path.extname(b); return `${b.slice(0, b.length - e.length)}_${short}${e}`; };

export const attachmentsOf = (tools: BugFact[]): string[] => [...new Set(tools.flatMap((t) => [t.defectPdf, t.rcaPdf, t.screenshot]).filter((x): x is string => !!x))];

/* ---------- one ticket per branch run (the layout of TP-6335) ---------- */

/** what really happened to a tool: failed (failure.json) / skipped (it ran and reported not_applicable) / notRun (no S3 folder) */
export type Outcome = 'failed' | 'skipped' | 'notRun';
export const outcomeOf = (f: RunFacts, b: BugFact): Outcome => { const st = f.rows.find((r) => r.tool === b.tool)?.state; return b.failure || st === 'FAILED' ? 'failed' : st === 'SKIPPED' ? 'skipped' : 'notRun'; };
const skipReason = (b: BugFact): string => { const m = /reported (\w+) \(([^)]+)\)/.exec(b.note); return m ? `${m[1]} (${m[2]})` : 'not_applicable'; };
const causeOf = (f: RunFacts, b: BugFact): string => b.placement?.reason || b.failure?.errorCode || (/127/.test(b.failure?.reason || '') ? 'exit 127' : '') || (outcomeOf(f, b) === 'skipped' ? skipReason(b) : outcomeOf(f, b) === 'failed' ? 'failure.json' : 'no S3 folder');
export const runCauses = (f: RunFacts): string[] => [...new Set(f.bugs.map((b) => causeOf(f, b)))];
const plain = (f: RunFacts) => f.version;

/** `Python 3.12 – 7/26 tools not triggered or failed due to A / B in run <run id>` */
export function runTitle(f: RunFacts): string {
  const c = runCauses(f); return `${f.language} ${plain(f)} – ${f.bugs.length}/${f.expected} tools not triggered or failed due to ${c.join(' / ') || 'platform defects'} in run ${f.runId}`;
}

const stateOf = (f: RunFacts, tool: string) => f.rows.find((r) => r.tool === tool);

export function runAttachments(f: RunFacts): string[] {
  return [...new Set([f.resultsXlsx, f.taxonomyHtml, ...f.bugs.flatMap((b) => [b.rcaPdf, b.defectPdf])].filter((x): x is string => !!x))];
}

export function runText(f: RunFacts): { summary: string; description: string; labels: string[] } {
  const bugSet = new Set(f.bugs.map((b) => b.tool)); const failed = f.bugs.filter((b) => outcomeOf(f, b) === 'failed'); const skipped = f.bugs.filter((b) => outcomeOf(f, b) === 'skipped'); const notRun = f.bugs.filter((b) => outcomeOf(f, b) === 'notRun');
  const reasons = [...new Set(notRun.map((t) => t.placement?.reason).filter(Boolean))] as string[];
  const names = (a: BugFact[]) => a.map((t) => `*${t.tool}*`).join(', ');
  const triggered = f.rows.filter((r) => !bugSet.has(r.tool) && r.state !== 'NOT_TRIGGERED' && r.state !== 'FAILED');
  const p: string[] = [];
  p.push('h2. Environment', head('Field', 'Value'), row('Repo', tick(f.repo || '-')), row('Branch', tick(f.branch)), row('Run ID', tick(f.runId)), row('Commit', tick(f.commit || '-')), row(f.language, f.fullVersion), row('Build', f.buildLine || '-'), row('Cluster', f.cluster),
    ...(f.runLine ? [row('Run result', f.runLine)] : []), row('Evidence', 'Attached: Tool execution results (xlsx), taxonomy gate HTML, RCA and Defect Reports (PDF) of each affected tool'), '');
  p.push('h2. Summary');
  const parts = [`On this run only _${f.okTools} of ${f.expected}_ expected tools produced valid output on S3.`];
  if (notRun.length) parts.push(`_${notRun.length}_ tool(s) were *never started* (no S3 folder): ${names(notRun)}.${reasons.length ? ` The QA-EKS orchestrator log shows why: the planner could not place them (${reasons.map(tick).join(', ')}).` : ''}`);
  if (failed.length) parts.push(`_${failed.length}_ tool(s) *ran but failed* with {{failure.json}} instead of a report: ${names(failed)}.`);
  if (skipped.length) parts.push(`_${skipped.length}_ tool(s) *ran but reported not applicable* and produced no result: ${names(skipped)} (${[...new Set(skipped.map(skipReason))].map(tick).join(', ')}).`);
  p.push(parts.join(' '));
  if (f.prior) p.push('', `Same branch on the earlier run {{${f.prior.short}}} (${f.prior.date}) had _${f.prior.ok}/${f.prior.expected}_ tools OK, this run has _${f.okTools}/${f.expected}_${f.prior.ok > f.okTools ? ' — worse, which points at the platform / runtime and not at a new repository change' : ''}.`);
  p.push('', `_Totals:_ ${f.expected} tools · _${f.okTools} triggered_ · _${f.bugs.length} not triggered or failed (bugs)_${f.notBugs.length ? ` · ${f.notBugs.length} not triggered but covered (not a bug)` : ''}`, '', '----', '');
  p.push('h2. Tools - triggered (output on S3)', head('#', 'Tool', 'Role', 'State'), ...triggered.map((r, i) => row(String(i + 1), r.tool, r.kind, r.state)), '');
  if (failed.length) p.push('h2. Tools - dispatched but failed (failure.json on S3)', head('#', 'Tool', 'S3 folder', 'Error code', 'Reason'), ...failed.map((t, i) => row(String(i + 1), t.tool, `${t.tool}/`, t.failure?.errorCode || '-', t.failure?.reason || t.note)), '');
  if (skipped.length) p.push('h2. Tools - ran but reported not applicable (no result on S3)', head('#', 'Tool', 'S3 folder', 'Reported', 'Detail'), ...skipped.map((t, i) => row(String(i + 1), t.tool, `${t.tool}/`, skipReason(t), t.note)), '');
  if (notRun.length) p.push('h2. Tools - not triggered (no S3 folder)', head('#', 'Tool', 'Role', 'Planner reason', 'Detail'), ...notRun.map((t, i) => row(String(i + 1), t.tool, stateOf(f, t.tool)?.kind || t.kind, t.placement ? `${t.placement.reason}${t.placement.coupling ? ` (${t.placement.coupling})` : ''}` : 'not captured', t.placement?.detail || t.note)), '');
  if (f.notBugs.length) p.push('h3. Not a bug (primary or secondary of the same metric ran)', head('Tool', 'Why'), ...f.notBugs.map((n) => row(n.tool, n.why)), '');
  p.push('----', '', 'h2. Root cause (evidence-based)');
  if (notRun.length && reasons.length) p.push(`_Planning:_ the orchestrator found ${names(notRun)} eligible but could not place them on an available runtime (${reasons.map(tick).join(', ')}), so no task was dispatched. Evidence: {{planning.tools_unplaceable}} / {{planning.compatibility_excluded}} in the {{wb-orchestrator}} log of {{qa-eks}}.`);
  else if (notRun.length) p.push(`_Not triggered:_ ${names(notRun)} are expected for ${f.language} ${f.version} but have no S3 folder in this run. The orchestrator log of this run was not captured, so the planner reason is not shown here; see the attached RCA report${notRun.length > 1 ? 's' : ''}.`);
  for (const t of skipped) p.push(`_${t.tool}:_ the tool ran and reported {{${skipReason(t)}}}: it found no input it could analyse. Whether the repository lacks the input or the platform did not hand it over is in the attached RCA report. ${cell(t.note).slice(0, 200)}`);
  for (const t of failed) p.push(`_${t.tool}:_ ${/127/.test(t.failure?.reason || '') ? `exit 127 = command not found: the binary is missing from the analyzer job image` : cell(t.failure?.reason || t.note)}. S3 {{${t.tool}/.../failure.json}}${t.failure?.version ? `, tool version ${t.failure.version}` : ''}.`);
  p.push('', 'Details, log lines and the platform code that raises each error are in the attached RCA reports (platform {{qa}} checkout, read-only). ' + (skipped.length ? 'The not_applicable results need a look at the repository input as well as the platform.' : 'This is a platform defect, not a repository problem.'), '', 'h2. Suggested Fix');
  const fixes: string[] = []; for (const t of skipped) fixes.push(`Find why ${tick(t.tool)} reported ${tick(skipReason(t))} and make its input available (see its RCA report).`); if (notRun.length) { for (const r of reasons) fixes.push(REASON_FIX[r] || `Fix the planner placement for ${tick(r)}.`); if (!reasons.length) fixes.push('Make the planner place these tools (runtime availability / compatibility), then re-run.'); }
  for (const t of failed) fixes.push(/127/.test(t.failure?.reason || '') ? `Install or expose the binary of ${tick(t.tool)} (and its runtime, if needed) in the analyzer job image.` : `Fix the cause shown in the RCA report of ${tick(t.tool)}.`);
  fixes.push(`Re-run branch ${tick(f.branch)} on qa-eks and confirm the tool count returns toward the baseline${f.prior ? ` (earlier run ${f.prior.short}: ${f.prior.ok}/${f.prior.expected})` : ''}.`);
  p.push(...[...new Set(fixes)].map((x) => `* ${x}`), '', 'h2. Acceptance criteria', ...f.bugs.map((b) => `* ${tick(b.tool + '/')} holds valid output on a re-run of this branch.`), '');
  p.push('h2. Attachments', ...runAttachments(f).map((a) => `* [^${attName(a, f.short)}]`), '', `_Filed by the White-box tool-validation script. Run ${f.runId}._`);
  return { summary: runTitle(f), description: p.join('\n'), labels: [] };
}

/** a comment for an open ticket of the same branch: this run saw it again */
export function runComment(f: RunFacts): string {
  const lines = [`*Seen again* on run {{${f.runId}}} (branch {{${f.branch}}}, ${f.language} ${f.fullVersion}, commit {{${(f.commit || '').slice(0, 10)}}}): _${f.okTools}/${f.expected}_ tools OK${f.prior ? ` (earlier run ${f.prior.short}: ${f.prior.ok}/${f.prior.expected})` : ''}, ${f.bugs.length} not triggered or failed.`, '', head('Tool', 'This run', 'Detail')];
  for (const t of f.bugs) lines.push(row(t.tool, outcomeOf(f, t) === 'failed' ? 'failed (failure.json)' : outcomeOf(f, t) === 'skipped' ? `reported ${skipReason(t)}` : 'no S3 folder', [t.placement ? `${t.placement.reason}${t.placement.detail ? ': ' + t.placement.detail : ''}` : '', t.failure ? t.failure.reason : ''].filter(Boolean).join(' ') || cell(t.note).slice(0, 200)));
  lines.push('', 'The tool execution results, taxonomy gate HTML and RCA / Defect Reports of this run are attached. This comment was added by the White-box tool-validation script.');
  return lines.join('\n');
}
