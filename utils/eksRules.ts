import { matchToolPattern } from './eksPatterns';
import type { ToolFacts, ToolPattern } from './eksPatterns';

/**
 * Known-pattern rules for ONE defective tool, added on top of the ones in eksPatterns.ts (that file is left as it is).
 * The rules here run first; when none matches, eksPatterns.ts answers. Rules that name a tool match only the line that names exactly that tool.
 * A rule is added here, with a unit test, each time the team solves a new case.
 */
export interface ToolRuleFacts extends ToolFacts { observed?: string }

export function matchToolRules(f: ToolRuleFacts): ToolPattern | null {
  const t = f.text || '';
  if (/admission_rejected_task[^\n]*reason=CELL_CPU_CAPACITY/i.test(t)) return { id: 'cell-cpu-capacity', title: 'Task rejected at admission: CELL_CPU_CAPACITY', rootCause: 'The orchestrator\'s admission step rejected this tool\'s task (dispatch.admission_rejected_task, reason CELL_CPU_CAPACITY), so the tool was never started. This is the cell\'s CPU capacity at that time, not a problem of the repository.', owner: 'Platform (cell CPU capacity / admission)', fix: 'Check the CPU capacity of the cell during the run (other runs, replicas) and re-run when capacity is free; raise the capacity if this repeats.' };
  // planning.tools_unplaceable lists every tool the orchestrator could not place, each with its reason: only the line that names THIS tool counts
  const me = f.tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const unplaced = new RegExp(`[^\\n]*planning\\.tools_unplaceable[^\\n]*tool_name=${me}(?![A-Za-z0-9_-])[^\\n]*reason=EXECUTION_RUNTIME_UNAVAILABLE[^\\n]*`, 'i').exec(t); // the whole line: detail= comes after reason=
  if (unplaced) {
    const detail = /detail=([^\s)]+)/.exec(unplaced[0])?.[1]?.replace(/_/g, ' ');
    return { id: 'runtime-unavailable-unplaceable', title: 'Tool not placed: no execution runtime available', rootCause: `The orchestrator's planning found this tool eligible but could not place it (planning.tools_unplaceable, reason EXECUTION_RUNTIME_UNAVAILABLE${detail ? `: ${detail}` : ''}), so the tool was never started. This is the platform's runtime availability for the tool, not a problem of the repository.`, owner: 'Platform (orchestrator planning / execution runtime availability)', fix: 'Check that an execution runtime that satisfies the tool\'s coupling (DECOUPLED or TARGET_COMPATIBLE) is available in the cell during the run, then re-run.' };
  }
  // the worker's own startup check refused the tool (worker.tool_readiness_blocked_execution ... readiness_status=NOT_INSTALLED skip_reason=MISSING_BINARY)
  const blocked = new RegExp(`[^\\n]*worker\\.tool_readiness_blocked_execution[^\\n]*tool_name=${me}(?![A-Za-z0-9_-])[^\\n]*`, 'i').exec(t);
  if (blocked) {
    const rs = /readiness_status=([^\s)]+)/.exec(blocked[0])?.[1]; const sr = /skip_reason=([^\s)]+)/.exec(blocked[0])?.[1];
    return { id: 'tool-readiness-blocked', title: 'Tool blocked by the worker\'s startup check', rootCause: `The worker's readiness check blocked this tool before it ran (worker.tool_readiness_blocked_execution${rs ? `, readiness_status ${rs}` : ''}${sr ? `, skip_reason ${sr}` : ''}), so the task was never executed. This is the tool's installation or startup on the worker, not a problem of the repository.`, owner: 'Platform (worker startup check / tool installation)', fix: `Fix the startup check of this tool on the worker${sr ? ` (${sr})` : ''}, for example install the missing binary in the worker image, then re-run.` };
  }
  // the orchestrator's planning skipped the tool because of the startup readiness check: planning.tools_skipped_startup_readiness lists it in skipped_tools
  if (new RegExp(`planning\\.tools_skipped_startup_readiness[^\\n]*tool_name=${me}(?![A-Za-z0-9_-])[^\\n]*listed_in=`, 'i').test(t))
    return { id: 'planning-skipped-startup-readiness', title: 'Tool skipped in planning: startup readiness', rootCause: 'The orchestrator\'s planning skipped this tool because its startup readiness check did not pass (planning.tools_skipped_startup_readiness lists it), so the tool was never started. This is the tool\'s readiness on the platform, not a problem of the repository.', owner: 'Platform (orchestrator planning / tool startup readiness)', fix: 'Check why the startup readiness check of this tool fails on the workers (missing binary or runtime), then re-run.' };
  // the tool's pod ended Completed, but no result folder reached S3
  if (/pod [^:\n]+: Completed/i.test(t) && /not triggered|no folder|NOT_TRIGGERED|NOT_APPLICABLE|empty/i.test(f.observed || ''))
    return { id: 'pod-completed-no-output', title: 'Tool pod completed, but no result reached S3', rootCause: 'The tool\'s pod ended Completed (exit code 0), yet the S3 check found no result for it: the tool ran, and its output was not saved or not uploaded (or it wrote nothing).', owner: 'Platform (tool runner result upload)', fix: 'Check the runner\'s result upload for this tool in the pod\'s log, and where it writes its output.' };
  // the checker says the tool RAN although the tool matrix of this language version excludes it (observed = RAN_BUT_EXCLUDED)
  if (/RAN_BUT_EXCLUDED/i.test(f.observed || ''))
    return { id: 'ran-but-excluded', title: 'Tool ran although the matrix excludes it', rootCause: 'The tool ran (its pod was started and ended), but the tool matrix for this language version says it is not expected: the platform\'s planning scheduled a tool that should have been excluded.', owner: 'Platform (planning / tool compatibility matrix)', fix: 'Align the planning\'s compatibility entry for this tool with the expected-tool matrix of this version, or update the matrix if the tool is meant to run.' };
  return matchToolPattern(f);
}
