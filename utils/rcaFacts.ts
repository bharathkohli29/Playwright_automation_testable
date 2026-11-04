import * as fs from 'fs';
import * as path from 'path';
import { ERR, compactServiceLine, liveEvidence, norm, readJson } from './eksEvidence';
import { matchToolRules } from './eksRules';
import { buildProfile, ToolProfile } from './rcaProfile';

/**
 * The FACT PACK of ONE defective tool: everything the RCA report may say, collected from the branch folder and nothing else.
 *  - every pod the tool had is kept as its own attempt (a tool can run several times; only the failed attempt explains a failure)
 *  - a known pattern is looked for in the failed pod's OWN lines first; lines of the cell services only count when they belong to the same task
 *    (a "Permission denied" in the cleanup of ANOTHER task of the same tool must not explain this failure)
 * Reads only. Never throws (a tool without any evidence gets an empty pack).
 */
export interface PodAttempt { pod: string; task: string; phase: string; exitCode: number | null; reason: string; command: string; started: string; finished: string; lines: string[] }
export interface PackRule { id: string; title: string; rootCause: string; owner: string; fix: string; scope: 'pod' | 'service' | 'run' }
export interface FactPack {
  tool: string; runId: string; branch: string; language: string; version: string;
  classification: string; observed: string; s3Note: string; status: string;
  attempts: PodAttempt[]; decisive: PodAttempt | null;
  serviceLines: { text: string; sameTask: boolean }[]; failureJson: string[];
  rule: PackRule | null; hasEvidence: boolean; profile: ToolProfile;
  /** the tool ran: a pod was seen, or its S3 folder exists, or the S3 check read a result (otherwise it was NOT TRIGGERED) */
  triggered: boolean; s3State: string;
  /** the live collector saved eks-live/ for this run (without it no pod or service line can exist) */
  captured: boolean;
  /** triggered and nothing wrong: green layout. Everything else (not triggered, failed, empty, not expected) is red. */
  healthy: boolean;
}

const ANSI = /\u001b?\[\d+(?:;\d+)*m/g;
const TS = /\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\b\s*/g;
const clean = (l: string) => l.replace(/^\[[^\]]*\]\s*/, '').replace(TS, '').replace(ANSI, '').replace(/\s+/g, ' ').trim();
const tail = (p: string, n: number): string[] => { try { return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).slice(-n); } catch { return []; } };
const LANG_KEYS = ['python', 'javascript', 'typescript', 'csharp', 'java'];

export function s3Facts(branchDir: string, tool: string): { language: string; version: string; classification: string; observed: string; note: string; runId: string; branch: string } {
  const out = { language: '', version: '', classification: '', observed: '', note: '', runId: '', branch: '' };
  const s3 = readJson(path.join(branchDir, 's3-check.json')); const live = readJson(path.join(branchDir, 'eks-live', 'summary.json'));
  out.runId = String(s3?.run_id || live?.run_id || ''); out.branch = String(s3?.branch || live?.branch || path.basename(branchDir));
  const key = LANG_KEYS.find((k) => s3?.[k]); const blk = key ? s3[key] : null;
  if (key) { out.language = key; out.version = String(blk.version || ''); }
  const d = (blk?.defects || []).find((x: any) => norm(x.tool) === norm(tool));
  if (d) { out.classification = d.tag; out.observed = d.observed; out.note = d.note; }
  return out;
}

export function buildFactPack(branchDir: string, tool: string): FactPack {
  const live = path.join(branchDir, 'eks-live'); const want = norm(tool);
  const s3 = s3Facts(branchDir, tool);
  const status = String((readJson(path.join(live, 'tool-status.json')) || {})[tool] || '');
  const recs: any[] = (readJson(path.join(live, 'tools.json')) || []).filter((x: any) => norm(x.tool) === want);
  const attempts: PodAttempt[] = recs.map((r) => {
    const all = (r.console_file ? tail(path.join(live, r.console_file), 400) : []).map(clean).filter(Boolean);
    const errs = all.filter((l) => ERR.test(l)).slice(-8);
    return { pod: r.pod, task: String(r.task || ''), phase: String(r.phase || ''), exitCode: r.exit_code ?? null, reason: [r.reason, r.message].filter(Boolean).join(' · '), command: String(r.command || ''), started: String(r.started_ist || r.started || ''), finished: String(r.finished_ist || r.finished || ''), lines: errs.length ? errs : all.slice(-4) };
  });
  const failed = attempts.filter((a) => a.phase === 'Failed' || (a.exitCode != null && a.exitCode !== 0));
  const decisive = failed[failed.length - 1] || null;
  const named = new RegExp(`(?<![A-Za-z0-9_-])${tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'i');
  const serviceLines = tail(path.join(live, 'services.log'), 4000).filter((l) => named.test(l) && (ERR.test(l) || /wait|retry|dispatch|skip/i.test(l))).slice(-6)
    .map((l) => ({ text: compactServiceLine(l, tool), sameTask: !!decisive?.task && l.includes(decisive.task) }));
  const failureJson = (liveEvidence(branchDir, tool)?.lines || []).filter((l) => l.startsWith('failure.json:'));

  // 1. the failed pod's own lines  2. service lines of the SAME task (or all of them when no pod was seen)
  let rule: PackRule | null = null;
  const observed = `${s3.observed} ${s3.note}`.trim();
  if (decisive) {
    const podText = [`pod ${decisive.pod}: ${decisive.reason}${decisive.exitCode ? ` · exit code ${decisive.exitCode}` : ''}`, ...decisive.lines].join('\n');
    const k = matchToolRules({ tool, text: podText, podReason: decisive.reason, exitCode: decisive.exitCode, observed });
    if (k) rule = { id: k.id, title: k.title, rootCause: k.rootCause, owner: k.owner, fix: k.fix, scope: 'pod' };
  }
  if (!rule) {
    const pool = decisive ? serviceLines.filter((s) => s.sameTask) : serviceLines;
    const text = [...failureJson, ...pool.map((s) => s.text)].join('\n');
    if (text) { const k = matchToolRules({ tool, text, observed }); if (k) rule = { id: k.id, title: k.title, rootCause: k.rootCause, owner: k.owner, fix: k.fix, scope: 'service' }; }
  }
  const sj = readJson(path.join(branchDir, 's3-check.json')); const sk = LANG_KEYS.find((k) => sj?.[k]);
  const entries = (sk ? sj[sk].tools || [] : []).filter((t: any) => norm(t.tool) === want);
  const s3State = String((entries.find((t: any) => t.state !== 'NOT_TRIGGERED') || entries[0])?.state || '');
  const hasFolder = Object.keys(readJson(path.join(branchDir, 's3-folders.json')) || {}).some((f) => norm(f) === want);
  // a defect that says the tool produced something (empty, failed, ran outside the matrix, reported not applicable) means it was triggered, even when no folder list or capture is saved
  const ranByS3 = ['EMPTY', 'FAILED', 'RAN_BUT_EXCLUDED', 'OUTPUT'].includes(s3.observed) || /only reported|FOREIGN_TOOL_PLANNED/.test(s3.note) || /False Empty|Runner Execution|Language Contamination/.test(s3.classification);
  const triggered = attempts.length > 0 || hasFolder || ranByS3 || ['OUTPUT', 'EMPTY', 'FAILED'].includes(s3State);
  const podOk = !decisive || rule?.id === 'findings-exit-code';
  const healthy = triggered && !s3.classification && podOk && (sk ? s3State === 'OUTPUT' || (s3State === '' && attempts.length > 0) : attempts.length > 0);
  const runDiag = readJson(path.join(live, 'run-diagnosis.json'));
  if (!rule && runDiag && (status === 'STUCK_WAITING' || status === 'NEVER_DISPATCHED')) rule = { id: runDiag.id, title: runDiag.title, rootCause: runDiag.rootCause, owner: runDiag.owner, fix: runDiag.fix, scope: 'run' };
  return { tool, runId: s3.runId, branch: s3.branch, language: s3.language, version: s3.version, classification: s3.classification, observed: s3.observed, s3Note: s3.note, status, attempts, decisive, serviceLines, failureJson, rule, hasEvidence: !!(attempts.length || serviceLines.length || failureJson.length), profile: buildProfile(branchDir, tool, recs, s3.language, s3.version), triggered, s3State, healthy, captured: fs.existsSync(path.join(live, 'summary.json')) };
}

/** Tools that need a report: the platform defects of the S3 check, plus every tool whose pod failed or that never started (when no S3 check exists). */
export function defectiveTools(branchDir: string): string[] {
  const s3 = readJson(path.join(branchDir, 's3-check.json')); const key = LANG_KEYS.find((k) => s3?.[k]);
  const out = new Set<string>(((key && s3[key].defects) || []).map((d: any) => d.tool as string));
  if (!key) for (const [t, s] of Object.entries(readJson(path.join(branchDir, 'eks-live', 'tool-status.json')) || {})) if (['FAILED', 'EMPTY_OUTPUT', 'STUCK_WAITING', 'NEVER_DISPATCHED'].includes(String(s))) out.add(t);
  return [...out];
}

/**
 * Every tool of the run, one report each: the tools the S3 check expected for this language and version (triggered or not), the defects, and every tool the
 * live capture saw (tools the capture could not place, status UNKNOWN, are left out when the S3 check exists: nothing is known about them).
 */
export function allTools(branchDir: string): string[] {
  const s3 = readJson(path.join(branchDir, 's3-check.json')); const key = LANG_KEYS.find((k) => s3?.[k]);
  const names = new Map<string, string>(); const add = (t?: string) => { if (t && !names.has(norm(t))) names.set(norm(t), t); };
  for (const t of (key && s3[key].tools) || []) add(t.tool);
  for (const d of (key && s3[key].defects) || []) add(d.tool);
  for (const [t, st] of Object.entries(readJson(path.join(branchDir, 'eks-live', 'tool-status.json')) || {})) if (st !== 'UNKNOWN') add(t);
  for (const r of readJson(path.join(branchDir, 'eks-live', 'tools.json')) || []) add(r.tool);
  return [...names.values()].filter((t) => !/^[0-9a-f]{32}-[a-z0-9]{5}$/.test(t)); // a pod id is not a tool name (the collector could not name that pod)
}
