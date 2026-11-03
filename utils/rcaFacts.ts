import * as fs from 'fs';
import * as path from 'path';
import { ERR, compactServiceLine, liveEvidence, norm, readJson } from './eksEvidence';
import { matchToolRules } from './eksRules';

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
  rule: PackRule | null; hasEvidence: boolean;
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
  const runDiag = readJson(path.join(live, 'run-diagnosis.json'));
  if (!rule && runDiag && (status === 'STUCK_WAITING' || status === 'NEVER_DISPATCHED')) rule = { id: runDiag.id, title: runDiag.title, rootCause: runDiag.rootCause, owner: runDiag.owner, fix: runDiag.fix, scope: 'run' };
  return { tool, runId: s3.runId, branch: s3.branch, language: s3.language, version: s3.version, classification: s3.classification, observed: s3.observed, s3Note: s3.note, status, attempts, decisive, serviceLines, failureJson, rule, hasEvidence: !!(attempts.length || serviceLines.length || failureJson.length) };
}

/** Tools that need a report: the platform defects of the S3 check, plus every tool whose pod failed or that never started (when no S3 check exists). */
export function defectiveTools(branchDir: string): string[] {
  const s3 = readJson(path.join(branchDir, 's3-check.json')); const key = LANG_KEYS.find((k) => s3?.[k]);
  const out = new Set<string>(((key && s3[key].defects) || []).map((d: any) => d.tool as string));
  if (!key) for (const [t, s] of Object.entries(readJson(path.join(branchDir, 'eks-live', 'tool-status.json')) || {})) if (['FAILED', 'EMPTY_OUTPUT', 'STUCK_WAITING', 'NEVER_DISPATCHED'].includes(String(s))) out.add(t);
  return [...out];
}
