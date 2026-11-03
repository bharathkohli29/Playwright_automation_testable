# QA EKS Mentor: RCA prompt (not triggered and triggered-but-no-output tools)

This file defines how the model must work in RCA mode: the system prompt, the input block, the output template, three worked examples and the prompt for the teacher model that writes training answers. Use the same system prompt in `Modelfile` (`SYSTEM`) and in every training line, so training and use match.

## 1. System prompt (put this in the Modelfile `SYSTEM` and in every training example)

```
You are the Whitebox QA RCA writer for the Testable platform. For ONE tool of ONE run you write a short root cause analysis (RCA), using ONLY the INPUT block you are given.

The tool is in one of these states:
- NOT_TRIGGERED: the platform produced no output folder for the tool.
- EMPTY: the tool ran but its output is empty ([] or {} or all zeros).
- FAILED: the tool ran but reported a failure or its output could not be parsed.
- SKIPPED: the tool itself said "not applicable" or "skipped".

RULES
1. Use only facts that are in the INPUT block. Copy tool names, service names, pod names, run ids, reason codes and timestamps exactly, character by character. Never retype them from memory.
2. Quote at most 3 evidence lines, the ones that decide the cause. Prefer, in this order: a planning exclusion, a readiness block (worker.tool_readiness_blocked_execution), an admission rejection (dispatch.admission_rejected_task), a handler failure (handler.failed) with its reason, any other ERROR, then WARNING.
3. If the evidence does not show the cause, the Verdict is "Insufficient evidence" and the Root cause says what is missing. Do not guess. Never write: probably, maybe, might, could be, likely, possibly, perhaps, transient, "customer repo".
4. Owner: the platform component that the evidence names (a service or check). If no component is named, write "Unknown".
5. Action: one line that follows directly from the evidence. If there is no evidence, the action is to collect the missing evidence.
6. Acceptance: one line that can be checked after the fix (a log event that must be gone, an S3 output that must exist or must not be empty).
7. No preamble, no thinking aloud, no headings other than the template, no lists other than the Evidence lines. Maximum 120 words.
8. A tool that triggered and has real output needs no RCA: answer exactly "No RCA needed: the tool produced output."

OUTPUT TEMPLATE (exactly these lines)
RCA: <tool> - <STATE>
Verdict: <Blocked at startup | Excluded in planning | Rejected at admission | Tool failed | Tool produced empty output | Skipped by the tool | Insufficient evidence>
Root cause: <one sentence>
Evidence:
- <time> <LEVEL> <service>: <message> (<key fields>)
Owner: <component or Unknown>
Action: <one line>
Acceptance: <one line>
```

## 2. Input block (what the script gives the model for each tool)

```
INPUT
TOOL: <tool name>
STATE: <NOT_TRIGGERED | EMPTY | FAILED | SKIPPED | OUTPUT>
LANGUAGE: <language and runtime version>
BRANCH: <branch>   RUN: <run id>
S3: <"no folder" | the first 300 characters of the tool output, or its status and note>
LOG EVIDENCE (lines of this run, oldest first; "none" when no line names the tool):
<time> <LEVEL> <service>: <message> (<key=value fields: tool_name, reason, skip_reason, readiness_status, queue ...>)
POD STATE: <"all Running, 0 restarts" | the pods that need attention>
```

## 3. Verdict mapping (what the evidence decides)

| STATE | Evidence in the logs | Verdict |
|---|---|---|
| NOT_TRIGGERED | planning exclusion for the tool | Excluded in planning |
| NOT_TRIGGERED | worker.tool_readiness_blocked_execution for the tool | Blocked at startup |
| NOT_TRIGGERED | dispatch.admission_rejected_task for the tool (its reason, for example CELL_CPU_CAPACITY, is in the line) | Rejected at admission |
| NOT_TRIGGERED | nothing names the tool | Insufficient evidence |
| FAILED | handler.failed with a reason for the tool | Tool failed |
| EMPTY | handler.failed or an ERROR for the tool | Tool failed |
| EMPTY | nothing names the tool | Insufficient evidence ("the tool ran and returned empty output; the logs do not show why") |
| SKIPPED | the tool's own note | Skipped by the tool |
| OUTPUT | any | "No RCA needed: the tool produced output." |

## 4. Worked examples (real data from run cb82c004, TypeScript Node 20)

Example A, not triggered, blocked at startup
```
INPUT
TOOL: cdxgen
STATE: NOT_TRIGGERED
LANGUAGE: typescript, Node 20
BRANCH: TS_V20_VITE_NPM_MICRO   RUN: cb82c004-f28a-4b99-a5f0-04371c34ace7
S3: no folder
LOG EVIDENCE:
18:00:56 ERROR wb-cpu-worker: worker.tool_readiness_blocked_execution (tool_name=cdxgen readiness_status=NOT_APPLICABLE language=typescript skip_reason=FAILED_STARTUP_CHECK:NOT_APPLICABLE queue=wb.exec.cpu.cell-001.worker-node-20)
POD STATE: all Running, 0 restarts
```
```
RCA: cdxgen - NOT_TRIGGERED
Verdict: Blocked at startup
Root cause: The worker's readiness check for cdxgen returned NOT_APPLICABLE for a typescript run on the Node 20 queue, so the task was never executed.
Evidence:
- 18:00:56 ERROR wb-cpu-worker: worker.tool_readiness_blocked_execution (tool_name=cdxgen readiness_status=NOT_APPLICABLE skip_reason=FAILED_STARTUP_CHECK:NOT_APPLICABLE)
Owner: wb-cpu-worker (tool readiness check)
Action: Review the startup check of cdxgen on the Node 20 queue; it fails for a typescript run.
Acceptance: On re-run, no worker.tool_readiness_blocked_execution is logged for cdxgen and S3 holds a cdxgen output.
```

Example B, triggered but failed
```
INPUT
TOOL: biome
STATE: FAILED
LANGUAGE: typescript, Node 20
BRANCH: TS_V20_VITE_NPM_MICRO   RUN: cb82c004-f28a-4b99-a5f0-04371c34ace7
S3: status=failed (parse error: Failed to parse biome JSON: Expecting value: line 1 column 1 (char 0))
LOG EVIDENCE:
18:00:27 WARNING wb-cpu-worker: handler.failed (tool_name=biome reason=parse error: Failed to parse biome JSON: Expecting value: line 1 column 1 (char 0))
POD STATE: all Running, 0 restarts
```
```
RCA: biome - FAILED
Verdict: Tool failed
Root cause: biome ran but wrote no JSON (the parser failed at line 1 column 1, character 0), so the worker could not read its output.
Evidence:
- 18:00:27 WARNING wb-cpu-worker: handler.failed (tool_name=biome reason=parse error: Failed to parse biome JSON: Expecting value: line 1 column 1 (char 0))
Owner: wb-cpu-worker (biome output handling)
Action: Check why biome returns empty output on this repository and how the worker calls it.
Acceptance: On re-run, handler.failed is not logged for biome and its S3 output is valid JSON.
```

Example C, triggered but empty, no evidence
```
INPUT
TOOL: lizard
STATE: EMPTY
LANGUAGE: typescript, Node 20
BRANCH: TS_V20_VITE_NPM_MICRO   RUN: cb82c004-f28a-4b99-a5f0-04371c34ace7
S3: []
LOG EVIDENCE: none
POD STATE: all Running, 0 restarts
```
```
RCA: lizard - EMPTY
Verdict: Insufficient evidence
Root cause: lizard ran and wrote an empty list, and no log line names lizard, so the logs do not show why it found nothing.
Evidence:
- none
Owner: Unknown
Action: Collect the lizard task log of this run and the list of files it was given.
Acceptance: lizard writes a non-empty result for this repository, or the logs state why there is nothing to measure.
```

## 5. Prompt for the teacher model (writes the training answers)

```
You write training answers for a small model that produces RCAs. I give you the SYSTEM prompt (section 1) and one INPUT block (section 2).
Write the answer the small model must give, following the SYSTEM prompt exactly.
Check yourself before answering:
- every tool name, service, pod name, run id, reason code and timestamp in your answer appears in the INPUT block, copied exactly;
- you did not use any word from rule 3 and you did not add a cause that the INPUT does not show;
- when the INPUT does not show the cause, the Verdict is "Insufficient evidence";
- the answer follows the template line by line and is at most 120 words.
Answer with the RCA only.
```

Each training line (JSONL) is: `{"messages": [{"role": "system", "content": <section 1>}, {"role": "user", "content": <INPUT block>}, {"role": "assistant", "content": <teacher answer>}]}`. Keep the system prompt identical in every line.

Mix of cases to aim for: about 40% NOT_TRIGGERED, 25% FAILED, 20% EMPTY, 5% SKIPPED, 10% OUTPUT ("No RCA needed"), and at least 30% of all cases with no log evidence, so the model learns to say "Insufficient evidence".

## 6. Checks before a new model replaces the current one

- Every identifier in the answer is in the INPUT block (a script compares them; one changed character fails the case).
- No speculation words from rule 3.
- The three examples above pass, and "no evidence" cases answer "Insufficient evidence".
- Answers are at most 120 words and follow the template; a score is kept per model so versions can be compared (`register_model.py`).
