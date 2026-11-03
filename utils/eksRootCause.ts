import * as path from 'path';
import { ERR, liveEvidence, readJson } from './eksEvidence';
import { matchToolRules } from './eksRules';

/**
 * The root cause of one defective tool, by RULES (no model), from the real evidence (eksEvidence.ts):
 *  1. a run-level finding (the whole run was stuck) explains a tool that was never started;
 *  2. a known pattern (eksRules.ts, then eksPatterns.ts) in the tool's own log lines answers with the real line quoted;
 *  3. otherwise the real lines are returned, marked NO_KNOWN_PATTERN, for a person to read.
 * No lines for the tool at all: null (nothing is guessed). Never throws.
 */
export interface EksAiDiagnosis {
  summary?: string;
  rootCause?: string;
  evidence?: string;
  owner?: string;
  suggestedFix?: string;
  verdict?: string;
  action?: string;
  acceptance?: string;
  state?: string;
  /** 'live' = from the lines the live collector saved (and the tool's failure.json) */
  source?: 'live';
}

export async function liveDiagnosis(tool: string, runId: string, branchDir: string, ctx?: { observed?: string; note?: string; version?: string }): Promise<EksAiDiagnosis | null> {
  try {
    if (/^(off|no|0|false)$/i.test((process.env.EKS_LIVE || '').trim())) return null;
    void runId;
    const runDiag = readJson(path.join(branchDir, 'eks-live', 'run-diagnosis.json')); const st = (readJson(path.join(branchDir, 'eks-live', 'tool-status.json')) || {})[tool];
    if (runDiag && (st === 'STUCK_WAITING' || st === 'NEVER_DISPATCHED'))
      return { source: 'live', summary: `${tool} never started: ${runDiag.title}`, rootCause: runDiag.rootCause, evidence: (runDiag.evidence || []).slice(0, 2).join(' | '), owner: runDiag.owner, suggestedFix: runDiag.fix, verdict: `KNOWN PATTERN (run-level): ${runDiag.id}` };
    const ev = liveEvidence(branchDir, tool); if (!ev) return null;
    const best = ev.lines.find((l) => ERR.test(l)) || ev.lines[0];
    const kp = matchToolRules({ tool, text: ev.lines.join('\n'), podReason: ev.podReason, observed: `${ctx?.observed || ''} ${ctx?.note || ''}` });
    if (kp) return { source: 'live', summary: `${tool}: ${kp.title}`, rootCause: kp.rootCause, evidence: best, owner: kp.owner, suggestedFix: kp.fix, verdict: `KNOWN PATTERN: ${kp.id}` };
    return {
      source: 'live', evidence: best, summary: `${tool}: ${ctx?.observed || 'tool problem'}${ev.podReason ? ` (${ev.podReason.slice(0, 80)})` : ''}`.slice(0, 200),
      rootCause: 'No known pattern matches these log lines; the real lines are attached for a person to read.', verdict: 'NO_KNOWN_PATTERN (the real log lines are attached)',
    };
  } catch { return null; }
}
