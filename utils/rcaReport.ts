import * as fs from 'fs';
import * as path from 'path';
import { FactPack, buildFactPack, defectiveTools } from './rcaFacts';

/**
 * One RCA report per defective tool, in a fixed 7-part format a person can read in a minute:
 *   in one sentence · what happened · why · impact · who fixes it · what to do · confidence
 * reportFromRules() writes it from the fact pack by rules (always available). A model, when one is switched on later, only REWORDS these
 * parts from the same fact pack; the evidence line and the owner always come from the facts.
 * Files: <branch folder>/RCA Report/RCA_<tool>.md and index.json. The folder goes to SharePoint with the rest of the branch folder (day/branch/RCA Report).
 * It is only created when there is a defective tool to report on. Never throws.
 */
export interface RcaReport {
  tool: string; kind: 'defect' | 'expected' | 'unknown'; source: 'rules' | 'model';
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

export function reportFromRules(p: FactPack): RcaReport {
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
  else if (/Planning Defect/.test(p.classification) && !p.attempts.length) { why = 'The tool is expected for this language version, but no S3 folder and no pod exist for it and no log line mentions it: no task was ever created. That points at the planning step, before any worker started. This is inferred from what is missing; no log line states it.'; owner = 'Platform (orchestrator planning), inferred'; fix = 'Check why planning left this tool out for this version (version ceiling / compatibility entry), then re-run.'; confidence = 'Inferred from the S3 result and the absence of pods; no log line.'; }
  else { why = 'There are no log lines for this tool, so no cause can be stated.'; owner = 'Not decided'; fix = 'Capture the run live (EKS_AUTO=on) so the pod and service lines exist next time.'; confidence = 'No evidence: nothing is guessed.'; }
  const oneLine = kind === 'expected' ? `${p.tool} shows "Error" only because it found something; nothing is broken.`
    : r ? `${p.tool}${ver ? ` (${ver})` : ''}: ${r.title.charAt(0).toLowerCase()}${r.title.slice(1)}.`
      : `${p.tool}${ver ? ` (${ver})` : ''} ${d ? `stopped with exit code ${d.exitCode ?? '?'} and the cause is not known yet` : 'has a defect and the cause is not known yet'}.`;
  return { tool: p.tool, kind, source: 'rules', oneLine, whatHappened: what, why, evidence: evLine ? `${evLine} (${where})` : '(none)', impact: impactOf(p, kind), owner, fix, confidence };
}

export function renderMarkdown(r: RcaReport, p: FactPack): string {
  return [
    `# RCA: ${r.tool}`, '', `Run ${p.runId || '-'} · branch ${p.branch || '-'}${p.language ? ` · ${p.language} ${p.version}` : ''} · written by ${r.source}`, '',
    '## In one sentence', r.oneLine, '', '## What happened', ...r.whatHappened.map((x) => `- ${x}`), '', '## Why', r.why, '', '## Evidence', `> ${r.evidence}`, '',
    '## Impact', r.impact, '', '## Who fixes it', r.owner, '', '## What to do', r.fix, '', '## Confidence', r.confidence, ''].join('\n');
}

/** a writer turns one fact pack into a report; the default is the rule writer, rcaWriter.writeReport is the model writer (it falls back to the rules itself) */
export type ReportWriter = (p: FactPack) => Promise<{ report: RcaReport; used: 'model' | 'rules'; model?: string; ms?: number; note?: string }>;
const ruleWriter: ReportWriter = async (p) => ({ report: reportFromRules(p), used: 'rules' });
export const RCA_DIR = 'RCA Report';
export interface ReportRow { tool: string; kind: string; file: string; rule: string; source: string; model?: string; ms?: number; note?: string }

export async function writeReports(branchDir: string, only?: string[], writer: ReportWriter = ruleWriter): Promise<ReportRow[]> {
  const list = only?.length ? only : defectiveTools(branchDir);
  const out = path.join(branchDir, RCA_DIR);
  if (!list.length) { fs.rmSync(out, { recursive: true, force: true }); return []; } // nothing defective: no empty folder, and no old one from an earlier attempt
  fs.mkdirSync(out, { recursive: true });
  const rows: ReportRow[] = [];
  for (const tool of list) {
    const p = buildFactPack(branchDir, tool); const w = await writer(p); const file = `RCA_${safe(tool)}.md`;
    fs.writeFileSync(path.join(out, file), renderMarkdown(w.report, p));
    rows.push({ tool, kind: w.report.kind, file, rule: p.rule?.id || '', source: w.used, model: w.model, ms: w.ms, note: w.note });
  }
  fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ reports: rows }, null, 2));
  return rows;
}
