/**
 * Known failure patterns of the QA platform. A pattern is matched on REAL captured data (log lines, pod status, replica snapshots, failure.json),
 * never guessed, and answers WITHOUT the model. Add a rule here each time the team solves one: the next run that hits it is explained at once.
 * Two kinds:  run-level (explains many tools at once, e.g. a stuck run)  and  tool-level (one tool's failure text / pod status).
 */
export interface RunFacts {
  runId: string;
  waits: number;                       // RUNTIME_UNAVAILABLE "wait" decisions about this run
  waitFirst?: string; waitLast?: string; waitSample?: string;
  waitRuntimes: string[];              // worker-python-3-12, worker-node-20 ...
  reasons: string[];                   // e.g. ANALYZER_JOBS_REPLACE_FAMILY_WORKERS
  toolPods: number;                    // tool pods seen in the -exe namespace
  planned: number;                     // tasks seen in the orchestrator log
  scaledToZero: string[];              // runtime deployments with desired 0 / ready 0 in the snapshots
  lastProgressMinutesAgo?: number;     // minutes since the last line about this run that was not a wait / polling line
}
export interface RunPattern { id: string; title: string; summary: string; rootCause: string; evidence: string[]; owner: string; fix: string; short: string }

export function matchRunPattern(f: RunFacts): RunPattern | null {
  // Stuck run: the orchestrator waits forever because the runtimes have no live (heartbeating) worker
  if (f.waits >= 5 && f.toolPods === 0) {
    const jobPath = f.reasons.some((r) => /ANALYZER_JOBS_REPLACE_FAMILY_WORKERS/i.test(r));
    const rt = f.waitRuntimes.length ? f.waitRuntimes.join(', ') : 'the needed runtimes';
    const ev = [
      `${f.waits} "wait" decisions with reason RUNTIME_UNAVAILABLE for run ${f.runId.split('-')[0]}${f.waitFirst ? ` (first ${f.waitFirst}, last ${f.waitLast || f.waitFirst})` : ''}`,
      `runtimes waiting: ${rt}`,
      f.scaledToZero.length ? `runtime deployments scaled to 0 (desired 0, ready 0): ${f.scaledToZero.join(', ')}` : '',
      jobPath ? 'scale-down reason in the log: ANALYZER_JOBS_REPLACE_FAMILY_WORKERS (analyzer Jobs through execution-control are meant to run this work)' : '',
      `no tool pod was ever started for this run (${f.planned || 'the'} planned task${f.planned === 1 ? '' : 's'} stayed pending)`,
      f.waitSample ? `sample: ${f.waitSample}` : '',
    ].filter(Boolean);
    return {
      id: 'runtime-unavailable-heartbeat-loop',
      title: 'Run stuck in planning: RUNTIME_UNAVAILABLE loop',
      summary: `The run never starts: all tasks stay pending while the orchestrator retries about every 2 s and always gets "wait, RUNTIME_UNAVAILABLE".`,
      rootCause: jobPath || f.scaledToZero.length
        ? `The runtimes (${rt}) no longer have standing worker pods: they are scaled to 0 on purpose because analyzer Jobs submitted through execution-control should do the work. The orchestrator does not hand the work to execution-control. Before it dispatches, it checks that each runtime has a live worker sending heartbeats (shared/admission/controller.py:347 -> decide.py:213); that check is switched off only when no worker in the cell sends heartbeats. Another worker in the cell (for example wb-cpu-worker) still does, so the check stays active, and the Job-path runtimes never count as live because Jobs send no heartbeats. Every task therefore waits forever. The earlier fixes for this design (55b8e5f6a, 56c14271f) cover cold start and how runtime-api reports scaled-down pools, but this heartbeat check still has no exception for the Job path.`
        : `The orchestrator keeps answering "wait, RUNTIME_UNAVAILABLE" for ${rt}, and no tool pod is ever started. Check whether those runtimes have ready workers (the replica snapshots in eks-live) and whether execution-control received the tasks.`,
      evidence: ev, owner: 'Dev (Surendiran / Vinod): platform bug, not a QA mistake. Any run that needs one of these runtimes hangs the same way.',
      fix: 'Dev: make the heartbeat/liveness check in the admission controller skip runtimes that run through the Job path (or make the orchestrator hand those tasks to execution-control). QA: nothing to change; do not re-run until Dev confirms.',
      short: `platform bug: ${f.waits}x RUNTIME_UNAVAILABLE, runtimes ${rt} have no live worker (Dev: heartbeat check has no exception for the Job path)`,
    };
  }
  return null;
}

export interface ToolFacts { tool: string; text: string; podReason?: string; exitCode?: number | null }
export interface ToolPattern { id: string; title: string; rootCause: string; owner: string; fix: string }

export function matchToolPattern(f: ToolFacts): ToolPattern | null {
  const t = `${f.text} ${f.podReason || ''}`;
  if (/admission_rejected_task[^\n]*reason=CELL_CPU_CAPACITY/i.test(t)) return { id: 'cell-cpu-capacity', title: 'Task rejected at admission: CELL_CPU_CAPACITY', rootCause: 'The orchestrator\'s admission step rejected this tool\'s task (dispatch.admission_rejected_task, reason CELL_CPU_CAPACITY), so the tool was never started. This is the cell\'s CPU capacity at that time, not a problem of the repository.', owner: 'Platform (cell CPU capacity / admission)', fix: 'Check the CPU capacity of the cell during the run (other runs, replicas) and re-run when capacity is free; raise the capacity if this repeats.' };
  if (/OOMKilled/i.test(t) || f.exitCode === 137) return { id: 'oom-killed', title: 'Tool pod ran out of memory', rootCause: 'The tool pod was killed for exceeding its memory limit (OOMKilled / exit code 137).', owner: 'Platform (runner resource limits)', fix: 'Raise the memory limit of this tool\'s runner, or reduce what the tool loads for this repository size.' };
  if (/ImagePullBackOff|ErrImagePull/i.test(t)) return { id: 'image-pull', title: 'Tool image could not be pulled', rootCause: 'The tool pod could not start because its image could not be pulled (ImagePullBackOff / ErrImagePull).', owner: 'Platform (image registry / tag)', fix: 'Check that the image tag exists in the registry and the cluster can pull it.' };
  if (/Evicted/i.test(t)) return { id: 'evicted', title: 'Tool pod was evicted', rootCause: 'The node evicted the tool pod (resource pressure), so the tool did not finish.', owner: 'Platform (node capacity)', fix: 'Check node memory/disk pressure at that time; re-run after capacity is back.' };
  if (/Permission denied[\s\S]{0,160}\/workspaces\//i.test(t) || /\/workspaces\/[^\s'"]*[\s\S]{0,80}Permission denied/i.test(t) || /Errno 13[\s\S]{0,120}\/workspaces\//i.test(t))
    return { id: 'workspace-permission-denied', title: 'Tool cannot write in the checked-out repository (/workspaces)', rootCause: 'The tool\'s runner got "Permission denied" (Errno 13) on a file inside the checked-out repository under /workspaces/<cell>/…/source (for example .git/config.lock or a baseline file). The workspace is not writable for the user the tool runs as, so tools that write into the checkout fail. This is the same error text in every tool that hit it, so it is one platform problem, not a problem of the repository.', owner: 'Platform (workspace permissions of the runner / checkout)', fix: 'Make the checkout under /workspaces writable for the runner user (or run those tools on a copy of the checkout).' };
  if (/Failed to parse [\w-]+ report[\s\S]{0,60}Expecting value: line 1 column 1/i.test(t)) return { id: 'empty-report', title: 'Tool wrote an empty report', rootCause: 'The platform could not parse the tool\'s report ("Expecting value: line 1 column 1"), which means the report file was empty: the tool produced no output (it may have crashed or printed to the wrong place).', owner: 'Platform or tool owner (check the tool\'s console log)', fix: 'Open the tool pod\'s console log from the live capture; the tool\'s own error is there. If the tool succeeded but wrote nothing, fix the tool\'s output step.' };
  if (/deadline exceeded|timed out|timeout/i.test(t) && /(tool|task|execution)/i.test(t)) return { id: 'timeout', title: 'Tool timed out', rootCause: 'The tool or its task hit a time limit before it finished.', owner: 'Platform (task time limit) or tool owner', fix: 'Compare the tool\'s duration with the task time limit; raise the limit or speed the tool up for this repository size.' };
  return null;
}
