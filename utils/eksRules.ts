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
  // bandit and gitleaks end with exit code 1 when they FOUND something: the pod shows "Error", the tool did its job
  if (/^(bandit|gitleaks)$/i.test(f.tool) && (f.exitCode === 1 || /exit code 1\b/.test(f.podReason || ''))) {
    const leaks = /leaks found:\s*(\d+)/i.exec(t)?.[1];
    if ((/^bandit$/i.test(f.tool) && /JSON output written/i.test(t)) || (/^gitleaks$/i.test(f.tool) && leaks))
      return { id: 'findings-exit-code', title: 'Exit code 1 means the tool reported findings', rootCause: `${f.tool} ran to the end and wrote its result${leaks ? ` (${leaks} leak(s) found)` : ''}. It ends with exit code 1 when it has findings, so the pod shows "Error" although nothing crashed. This is the tool's normal way to say "findings exist", not a platform problem.`, owner: 'None (expected behaviour); the findings belong to the repository', fix: 'Nothing to fix in the platform. Read the findings in the tool\'s result; make sure the platform treats exit code 1 of this tool as a successful run.' };
  }
  // pip-audit builds a temporary virtual environment first; when its pip upgrade fails it stops before auditing anything
  if (/pip_audit[^\n]*Failed to upgrade `?pip`?/i.test(t) || /Failed to upgrade `pip`/i.test(t))
    return { id: 'pip-audit-env-setup-failed', title: 'pip-audit could not prepare its environment', rootCause: 'pip-audit creates a temporary virtual environment and runs "pip install --upgrade pip wheel setuptools" in it. That command failed, so the tool stopped before it audited any dependency. The log does not say why pip failed; the usual causes are no access to the package index from the runner, or a temp folder the runner cannot use.', owner: 'Platform (runner network / package index access)', fix: 'Run the same pip command inside the runner pod and read pip\'s own error; give the runner access to the package index (or a mirror), then re-run.' };
  // the runner passed an option the installed version of the tool does not know
  const opt = /No such option:?\s*['"]?(-{1,2}[\w-]+)['"]?/i.exec(t);
  if (opt) {
    const usage = /Usage:\s*([^\n]+)/i.exec(t)?.[1]?.replace(/\s*\[OPTIONS\].*/i, '').trim();
    return { id: 'unsupported-cli-option', title: 'The runner used an option the tool does not have', rootCause: `The tool printed "No such option: ${opt[1]}"${usage ? ` (usage: ${usage})` : ''}. The runner calls the tool with this option, but the version installed in the image does not accept it, so the tool stopped at once. The runner command and the tool version in the image do not match.`, owner: 'Platform (runner command vs tool version in the image)', fix: `Remove ${opt[1]} from the runner command, or install the tool version that supports it, then re-run.` };
  }
  // the orchestrator's planning refused the whole run: a tool it wanted to schedule has no wave (run-order group) in the tenant's active execution policy
  if (/(?:failure_)?reason"?\s*[:=]\s*"?WAVE_IDENTITY_MISMATCH/i.test(t)) return { id: "wave-identity-mismatch", title: "Run refused in planning: WAVE_IDENTITY_MISMATCH", rootCause: "The planning activity of the orchestrator failed the whole run at once (failure_reason WAVE_IDENTITY_MISMATCH, not retryable): a tool it wanted to schedule has no wave (run-order group) in the active execution policy of the tenant, and the platform refuses to guess. No tool was started, and the run status can later be overwritten to cancelled when the retry supervisor times out. This is the execution policy of the platform, not a problem of the repository.", owner: "Platform (execution policy / tool wave assignment)", fix: "Find the tool without a wave in the active execution policy of this tenant, assign it, then trigger a new run; restarting a worker does not help." };
  // the tool's failure.json: the runtime environment the plan froze is not the one of the worker that took the task (RUNTIME_IMAGE_DRIFT)
  const drift = /RUNTIME_IMAGE_DRIFT[^\n]*?plan froze environment\s+([0-9a-f]+)[^\n]*?this worker is\s+([0-9a-f]+)/i.exec(t);
  if (drift) return { id: 'runtime-image-drift', title: 'Worker runs another environment than the plan', rootCause: `The plan froze the runtime environment ${drift[1]}, but the worker that took the task runs environment ${drift[2]} (failure.json: RUNTIME_IMAGE_DRIFT). The platform refuses to run a tool on another environment than the one planned, so the task failed at once. This is a version mismatch between the plan and the workers, typically a rollout or image update between planning and execution, not a problem of the repository.`, owner: 'Platform (deployment: plan environment vs worker image)', fix: 'Check that every worker runs the image version of the plan (a rollout or image update during the run is the usual cause), then re-run the branch once the rollout is finished.' };
  return matchToolPattern(f);
}
