import * as fs from 'fs';
import * as path from 'path';
import { chromium } from '@playwright/test';
import { FactPack, buildFactPack, allTools } from './rcaFacts';
import { dur, ist } from './rcaProfile';

/**
 * One RCA report per defective tool, in a fixed 7-part format a person can read in a minute:
 *   in one sentence · what happened · why · impact · who fixes it · what to do · confidence
 * reportFromRules() writes it from the fact pack by rules (always available). A model, when one is switched on later, only REWORDS these
 * parts from the same fact pack; the evidence line and the owner always come from the facts.
 * Files: <branch folder>/RCA Report/Triggered|Not triggered/RCA_<tool>.pdf (green layout = fine, red = needs attention) and index.json. The folder goes to SharePoint with the rest of the branch folder (day/branch/RCA Report).
 * It is only created when there is a defective tool to report on. Never throws.
 */
export interface RcaReport {
  tool: string; kind: 'ok' | 'defect' | 'expected' | 'unknown'; source: 'rules' | 'model';
  /** layout: green = triggered and fine (also exit code 1 with findings); red = not triggered, failed, empty or not expected */
  tone: 'green' | 'red'; state: string;
  oneLine: string; whatHappened: string[]; why: string; evidence: string; impact: string; owner: string; fix: string; confidence: string;
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 80);
const one = (s: string, n = 300) => s.replace(/\s+/g, ' ').trim().slice(0, n);

function impactOf(p: FactPack, kind: RcaReport['kind']): string {
  if (kind === 'expected') return 'None. The tool did its job; its findings are part of the tool result.';
  if (/Planning Defect/.test(p.classification)) return 'The tool is missing from this branch\'s quality score input: it was expected for this language version but never ran.';
  if (/False Empty/.test(p.classification)) return 'The tool\'s report is empty, so its part of the quality score is not based on real data.';
  if (/Language Contamination/.test(p.classification)) return 'A tool of another language ran on this branch; its result does not belong in this branch\'s score.';
  if (p.decisive && p.attempts.some((a) => a.phase === 'Succeeded')) return 'One step of this tool failed while its other steps ran, so its result for this branch may be incomplete: check the tool folder in S3.';
  if (p.decisive) return 'The tool did not finish, so there is no result from it for this branch.';
  return 'The tool has no usable result for this branch.';
}

/** the headline of the layout: whether the tool was triggered, and how it ended */
function stateOf(p: FactPack, kind: RcaReport['kind']): string {
  if (kind === 'ok' || kind === 'expected') return 'TRIGGERED · RESULT OK';
  if (!p.triggered) return 'NOT TRIGGERED';
  if (/Language Contamination/.test(p.classification)) return 'TRIGGERED · NOT A TOOL OF THIS LANGUAGE';
  if (/excluded|must not|outside the matrix/i.test(p.s3Note)) return 'TRIGGERED · NOT EXPECTED FOR THIS VERSION';
  if (p.s3State === 'EMPTY' || /False Empty/.test(p.classification)) return 'TRIGGERED · EMPTY RESULT';
  return 'TRIGGERED · FAILED';
}

/** the green report: the tool was triggered and nothing is wrong. Plain facts, no model needed. */
function greenReport(p: FactPack): RcaReport {
  const ver = [p.language, p.version].filter(Boolean).join(' ');
  const rows = p.profile.s3.filter((r) => r.result === 'PASS').slice(0, 4);
  const what = [...rows.map((r) => `S3 result for ${r.technique || p.tool}: ${r.result}${r.note ? `, ${one(r.note, 200)}` : ''}`), ...p.attempts.map((a) => `Pod ${a.pod.replace(/^wb-exec-/, '').slice(0, 14)}…: ${a.phase}${a.exitCode != null ? `, exit code ${a.exitCode}` : ''}${a.command ? `, command "${one(a.command, 60)}"` : ''}.`)];
  if (!what.length) what.push('The tool was triggered and nothing wrong was found.');
  const ev = rows[0] ? `S3: ${rows[0].technique || p.tool}: ${rows[0].result}${rows[0].note ? ` · ${one(rows[0].note, 200)}` : ''}` : p.attempts.length ? `pod ${p.attempts[p.attempts.length - 1].pod.replace(/^wb-exec-/, '').slice(0, 14)}…: ${p.attempts[p.attempts.length - 1].phase}, exit code ${p.attempts[p.attempts.length - 1].exitCode ?? '?'}` : '(none)';
  return { tool: p.tool, kind: 'ok', tone: 'green', state: 'TRIGGERED · RESULT OK', source: 'rules', oneLine: `${p.tool}${ver ? ` (${ver})` : ''} was triggered and produced a result; no problem was found.`, whatHappened: what,
    why: 'No fault found: the tool was triggered, its pod ended without an error and the S3 result holds data (or, without an S3 check, the pod finished with exit code 0).', evidence: ev, impact: "None. Its result counts toward this branch's quality score.", owner: 'None', fix: 'Nothing to do.', confidence: 'From the pod result and the S3 verdict of this run; no log line shows a fault.' };
}

export function reportFromRules(p: FactPack): RcaReport {
  if (p.healthy && p.rule?.id !== 'findings-exit-code') return greenReport(p);
  const d = p.decisive; const r = p.rule;
  const kind: RcaReport['kind'] = r?.id === 'findings-exit-code' ? 'expected' : r || d || p.classification ? 'defect' : 'unknown';
  const ver = [p.language, p.version].filter(Boolean).join(' ');
  const what: string[] = [];
  if (p.classification) what.push(`The S3 check marked ${p.tool} as ${p.classification}${p.observed ? ` (${p.observed})` : ''}: ${one(p.s3Note, 260)}`);
  for (const a of p.attempts) what.push(`Pod ${a.pod.replace(/^wb-exec-/, '').slice(0, 14)}…: ${a.phase}${a.exitCode != null ? `, exit code ${a.exitCode}` : ''}${a.command ? `, command "${one(a.command, 60)}"` : ''}${a.started ? `, started ${a.started}` : ''}.`);
  if (!p.attempts.length) what.push('No pod of this tool was seen by the live capture.');
  const evLine = d?.lines.find((l) => /error|exception|denied|fail|found|no such/i.test(l)) || d?.lines[d.lines.length - 1] || p.failureJson[0] || p.serviceLines.find((s) => s.sameTask)?.text || p.serviceLines[0]?.text || '';
  const where = d ? `from the failed pod ${d.pod.replace(/^wb-exec-/, '').slice(0, 14)}…` : p.failureJson[0] && evLine === p.failureJson[0] ? "from the tool's failure.json in S3" : 'from the cluster service log';
  let why: string; let owner: string; let fix: string; let confidence: string;
  if (r) { why = r.rootCause; owner = r.owner; fix = r.fix; confidence = r.scope === 'pod' ? `Known pattern "${r.id}", matched in the failed pod's own log lines.` : r.scope === 'service' ? `Known pattern "${r.id}", matched in service log lines of the same task.` : `Run-level finding "${r.id}".`; }
  else if (evLine) { why = `No known pattern matches. The tool's own last output is quoted below${d?.exitCode ? ` (it stopped with exit code ${d.exitCode})` : ''}; a person needs to read it.`; owner = 'Not decided (no known pattern)'; fix = 'Read the quoted line and the pod log in eks-live/pods; add a rule once the cause is understood.'; confidence = 'No known pattern: shown for a person to read.'; }
  else if (/Planning Defect/.test(p.classification) && !p.attempts.length) { why = 'The tool is expected for this language version, but no S3 folder and no pod exist for it and no log line mentions it: no task was ever created. That points at the planning step, before any worker started. This is inferred from what is missing; no log line states it.' + (p.profile.identity.some(([k, v]) => k === 'Planned for this run' && v.startsWith('not in')) ? " The live capture's own list of planned tools for this run does not contain it either." : ''); owner = 'Platform (orchestrator planning), inferred'; fix = 'Check why planning left this tool out for this version (version ceiling / compatibility entry), then re-run.'; confidence = 'Inferred from the S3 result and the absence of pods; no log line.'; }
  else { why = 'There are no log lines for this tool, so no cause can be stated.'; owner = 'Not decided'; fix = 'Capture the run live (EKS_AUTO=on) so the pod and service lines exist next time.'; confidence = 'No evidence: nothing is guessed.'; }
  const oneLine = kind === 'expected' ? `${p.tool} shows "Error" only because it found something; nothing is broken.`
    : r ? `${p.tool}${ver ? ` (${ver})` : ''}: ${r.title.charAt(0).toLowerCase()}${r.title.slice(1)}.`
      : `${p.tool}${ver ? ` (${ver})` : ''} ${d ? `stopped with exit code ${d.exitCode ?? '?'} and the cause is not known yet` : 'has a defect and the cause is not known yet'}.`;
  return { tool: p.tool, kind, tone: kind === 'expected' ? 'green' : 'red', state: stateOf(p, kind), source: 'rules', oneLine, whatHappened: what, why, evidence: evLine ? `${evLine} (${where})` : '(none)', impact: impactOf(p, kind), owner, fix, confidence };
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const cell = (v: unknown, cls = '') => `<td${cls ? ` class="${cls}"` : ''}>${esc(v) || '-'}</td>`;
const table = (head: string[], rows: string[][], mono: number[] = []) => rows.length ? `<table class="sm"><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c, i) => cell(c, mono.includes(i) ? 'mono' : '')).join('')}</tr>`).join('')}</table>` : '';

/** the key times on page 1: when the tool started and ended, how long, how it ended */
function strip(p: FactPack): string {
  const f = p.profile; const a = p.decisive || p.attempts[p.attempts.length - 1];
  const items: [string, string][] = [['Started', f.firstStart ? ist(f.firstStart) : 'no pod seen'], ['Finished', f.lastEnd ? ist(f.lastEnd) : '-'], ['Ran for', dur(f.seconds.task ?? f.seconds.pods)], ['Waited in queue', dur(f.seconds.queueWait)], ['Attempts', String(p.attempts.length || 0)], ['Last exit', a ? `${a.phase}${a.exitCode != null ? `, ${a.exitCode}` : ''}` : '-']];
  return `<div class="strip">${items.map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('')}</div>`;
}

/** page 2 on: everything the logs and the S3 result say about the tool, as facts */
function profileHtml(p: FactPack): string {
  const f = p.profile; const none = (t: string) => `<p class="none">${esc(t)}</p>`;
  const att = f.attempts.map((a) => [a.pod.replace(/^wb-exec-/, '').slice(0, 16) + '…', a.task.slice(0, 8), a.node.split('.')[0], `${a.phase}${a.exitCode != null ? `, exit ${a.exitCode}` : ''}${a.restarts ? `, ${a.restarts} restart(s)` : ''}`, ist(a.started).replace(' IST', ''), ist(a.finished).replace(' IST', ''), dur(a.seconds)]);
  return `<div class="p2"><div class="banner" style="background:#334155"><h1>Tool profile: ${esc(p.tool)}</h1><div>everything the logs and the S3 result say about this tool</div></div>
<h2>Identity</h2><table class="sm">${f.identity.map(([k, v]) => `<tr><th style="width:24%">${esc(k)}</th>${cell(v)}</tr>`).join('')}</table>
<h2>Timeline (IST)</h2>${f.timeline.length ? table(['Time', 'What happened', 'Detail'], f.timeline.map((e) => [e.ist.replace(' IST', ''), e.label, e.detail])) : none('No event of this tool was captured (no pod and no task line): it never reached a worker.')}
<h2>Pod attempts</h2>${att.length ? table(['Pod', 'Task', 'Node', 'Result', 'Started', 'Finished', 'Duration'], att, [0, 1, 2]) + f.attempts.map((a, i) => `<p class="mono" style="font-size:9px;margin:2px 0">#${i + 1} image ${esc(a.image)}<br>#${i + 1} command ${esc(a.command)}</p>`).join('') : none('No tool pod was seen by the live capture.')}
<h2>S3 result</h2>${f.s3.length ? table(['Testing type', 'Technique', 'Result', 'Note'], f.s3.map((r) => [r.testingType, `${r.technique}${r.classifications ? ` › ${r.classifications}` : ''}`, r.result, r.note])) : none('No S3 row for this tool (the S3 check is not part of this folder, or the tool has no folder in the run).')}
${f.s3Files.length ? `<p class="mono" style="font-size:9px">Files in its S3 folder: ${esc(f.s3Files.slice(0, 8).join(', '))}${f.s3Files.length > 8 ? ` … (${f.s3Files.length} files)` : ''}</p>` : ''}
<h2>Warnings and errors of its task</h2>${f.warnings.length ? table(['Time', 'Service', 'Message', 'Detail'], f.warnings.map((w) => [w.ist.replace(' IST', ''), w.where, w.message, w.detail])) : none('None in the captured service log.')}
${f.orchestrator.length ? `<h2>What the orchestrator said about this tool</h2><div class="ev">${esc(f.orchestrator.join('\n'))}</div>` : ''}
${f.logTail.length ? `<h2>Last output of the tool pod</h2><div class="ev">${esc([...f.logHead, ...(f.logHead.length ? ['…'] : []), ...f.logTail].join('\n'))}</div>` : ''}
${f.run.length ? `<h2>The run</h2><table class="sm">${f.run.map(([k, v]) => `<tr><th style="width:24%">${esc(k)}</th>${cell(v)}</tr>`).join('')}</table>` : ''}
</div>`;
}

/** the report as A4 pages (HTML for the PDF): the summary on page 1, the tool profile from page 2 */
export function reportHtml(r: RcaReport, p: FactPack): string {
  const tone = r.tone === 'green' ? { bar: '#047857', soft: '#ecfdf5', edge: '#34d399', label: r.state } : { bar: '#b91c1c', soft: '#fef2f2', edge: '#f87171', label: r.state };
  const meta: Array<[string, string]> = [['Tool', p.tool], ['Run', p.runId || '-'], ['Branch', p.branch || '-'], ['Language', [p.language, p.version].filter(Boolean).join(' ') || '-'], ['Classification', p.classification || '-'], ['Written by', r.source === 'model' ? 'local model (facts and evidence from the logs and rules)' : 'rules (known patterns)']];
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{font:11.5px/1.5 "Segoe UI",Arial,sans-serif;color:#1f2937;margin:0}
.banner{background:${tone.bar};color:#fff;padding:13px 16px;border-radius:6px}.banner h1{margin:0;font-size:18px}.banner div{font-size:10.5px;opacity:.92;margin-top:3px;letter-spacing:.04em}
.one{margin:12px 0;padding:11px 14px;border:2px solid ${tone.edge};background:${tone.soft};border-radius:6px;font-size:13px;font-weight:600}
h2{font-size:12.5px;margin:14px 0 5px;color:#111827;border-bottom:1px solid #e5e7eb;padding-bottom:3px}
p{margin:4px 0}ul{margin:4px 0 4px 18px;padding:0}li{margin:2px 0}
.ev{background:#0f172a;color:#e2e8f0;padding:9px 11px;border-radius:5px;font:10px/1.45 Consolas,monospace;white-space:pre-wrap;word-break:break-all}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #e5e7eb;padding:4px 7px;text-align:left;vertical-align:top;font-size:10.5px}th{background:#f3f4f6;width:24%}
.foot{margin-top:14px;font-size:9.5px;color:#6b7280}
.strip{display:flex;gap:8px;margin:0 0 4px}.strip div{flex:1;border:1px solid #e5e7eb;border-radius:5px;padding:5px 8px;background:#f9fafb}.strip b{display:block;font-size:9px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em}.strip span{font-size:11.5px;font-weight:600}
h2{break-after:avoid}tr{break-inside:avoid}.p2{page-break-before:always}.sm td,.sm th{font-size:9.5px}.sm th{width:auto}.mono{font-family:Consolas,monospace;word-break:break-all}.none{color:#6b7280;font-style:italic}
</style></head><body>
<div class="banner"><h1>ROOT CAUSE ANALYSIS: ${esc(p.tool)}</h1><div>${esc([tone.label, [p.language, p.version].filter(Boolean).join(' '), p.branch && `branch ${p.branch}`, p.runId && `run ${p.runId.slice(0, 8)}`].filter(Boolean).join(' · '))}</div></div>
<div class="one">${esc(r.oneLine)}</div>
${strip(p)}
<h2>What happened</h2><ul>${r.whatHappened.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
<h2>Why</h2><p>${esc(r.why)}</p>
<h2>Evidence</h2><div class="ev">${esc(r.evidence)}</div>
<h2>Impact</h2><p>${esc(r.impact)}</p>
<h2>Who fixes it</h2><p>${esc(r.owner)}</p>
<h2>What to do</h2><p>${esc(r.fix)}</p>
<h2>Confidence</h2><p>${esc(r.confidence)}</p>
<h2>Run details</h2><table>${meta.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
${profileHtml(p)}
<div class="foot">Generated automatically from the QA EKS logs and the S3 result of this run. A draft for people to check.</div>
</body></html>`;
}

/** a writer turns one fact pack into a report; the default is the rule writer, rcaWriter.writeReport is the model writer (it falls back to the rules itself) */
export type ReportWriter = (p: FactPack) => Promise<{ report: RcaReport; used: 'model' | 'rules'; model?: string; ms?: number; note?: string }>;
const ruleWriter: ReportWriter = async (p) => ({ report: reportFromRules(p), used: 'rules' });
export const RCA_DIR = 'RCA Report';
export interface ReportRow { tool: string; kind: string; tone: string; state: string; triggered: boolean; file: string; rule: string; source: string; model?: string; ms?: number; note?: string }

/**
 * Writes one PDF per tool of the run into <branch folder>/RCA Report/Triggered/ or /Not triggered/ (the folder is rebuilt, so an earlier attempt leaves nothing behind).
 * Green layout = triggered and fine, red layout = not triggered, failed, empty or not expected. Only the red ones are worded by the model.
 */
export async function writeReports(branchDir: string, only?: string[], writer: ReportWriter = ruleWriter): Promise<ReportRow[]> {
  const list = only?.length ? only : allTools(branchDir);
  const out = path.join(branchDir, RCA_DIR);
  fs.rmSync(out, { recursive: true, force: true });
  if (!list.length) return []; // nothing to report on: no empty folder
  const rows: ReportRow[] = [];
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    for (const tool of list) {
      const p = buildFactPack(branchDir, tool); const base = reportFromRules(p);
      const w = base.tone === 'green' ? { report: base, used: 'rules' as const } : await writer(p); // a healthy tool needs no wording help
      const sub = p.triggered ? 'Triggered' : 'Not triggered'; fs.mkdirSync(path.join(out, sub), { recursive: true });
      const file = `${sub}/RCA_${safe(tool)}.pdf`;
      const page = await ctx.newPage();
      try {
        await page.setContent(reportHtml(w.report, p), { waitUntil: 'load' });
        await page.pdf({ path: path.join(out, file), format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '14mm', left: '12mm', right: '12mm' }, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: `<div style="font-size:8px;color:#6b7280;width:100%;text-align:center">RCA · ${esc(tool)} · page <span class="pageNumber"></span> of <span class="totalPages"></span></div>` });
      } finally { await page.close().catch(() => {}); }
      rows.push({ tool, kind: w.report.kind, tone: w.report.tone, state: w.report.state, triggered: p.triggered, file, rule: p.rule?.id || '', source: 'model' in w && w.used === 'model' ? 'model' : w.used, model: (w as any).model, ms: (w as any).ms, note: (w as any).note });
    }
  } finally { await browser.close().catch(() => {}); }
  fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ reports: rows }, null, 2));
  return rows;
}
