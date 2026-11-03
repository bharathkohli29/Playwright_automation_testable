"""
Dataset Preparation Script for Fine-Tuning QA-EKS-Mentor.

Converts Whitebox QA RCA examples into the standard ChatML / OpenAI JSONL format
conforming to RCA_PROMPT.md.
"""
import json
import pathlib

# System prompt exactly matching Section 1 of RCA_PROMPT.md
SYSTEM_PROMPT = """You are the Whitebox QA RCA writer for the Testable platform. For ONE tool of ONE run you write a short root cause analysis (RCA), using ONLY the INPUT block you are given.

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
Acceptance: <one line>"""

EXAMPLES = [
    # Example A: NOT_TRIGGERED, Blocked at startup (Section 4 Example A)
    {
        "input": """INPUT
TOOL: cdxgen
STATE: NOT_TRIGGERED
LANGUAGE: typescript, Node 20
BRANCH: TS_V20_VITE_NPM_MICRO   RUN: cb82c004-f28a-4b99-a5f0-04371c34ace7
S3: no folder
LOG EVIDENCE:
18:00:56 ERROR wb-cpu-worker: worker.tool_readiness_blocked_execution (tool_name=cdxgen readiness_status=NOT_APPLICABLE language=typescript skip_reason=FAILED_STARTUP_CHECK:NOT_APPLICABLE queue=wb.exec.cpu.cell-001.worker-node-20)
POD STATE: all Running, 0 restarts""",
        "output": """RCA: cdxgen - NOT_TRIGGERED
Verdict: Blocked at startup
Root cause: The worker's readiness check for cdxgen returned NOT_APPLICABLE for a typescript run on the Node 20 queue, so the task was never executed.
Evidence:
- 18:00:56 ERROR wb-cpu-worker: worker.tool_readiness_blocked_execution (tool_name=cdxgen readiness_status=NOT_APPLICABLE skip_reason=FAILED_STARTUP_CHECK:NOT_APPLICABLE)
Owner: wb-cpu-worker (tool readiness check)
Action: Review the startup check of cdxgen on the Node 20 queue; it fails for a typescript run.
Acceptance: On re-run, no worker.tool_readiness_blocked_execution is logged for cdxgen and S3 holds a cdxgen output."""
    },
    # Example B: FAILED, Tool failed (Section 4 Example B)
    {
        "input": """INPUT
TOOL: biome
STATE: FAILED
LANGUAGE: typescript, Node 20
BRANCH: TS_V20_VITE_NPM_MICRO   RUN: cb82c004-f28a-4b99-a5f0-04371c34ace7
S3: status=failed (parse error: Failed to parse biome JSON: Expecting value: line 1 column 1 (char 0))
LOG EVIDENCE:
18:00:27 WARNING wb-cpu-worker: handler.failed (tool_name=biome reason=parse error: Failed to parse biome JSON: Expecting value: line 1 column 1 (char 0))
POD STATE: all Running, 0 restarts""",
        "output": """RCA: biome - FAILED
Verdict: Tool failed
Root cause: biome ran but wrote no JSON (the parser failed at line 1 column 1, character 0), so the worker could not read its output.
Evidence:
- 18:00:27 WARNING wb-cpu-worker: handler.failed (tool_name=biome reason=parse error: Failed to parse biome JSON: Expecting value: line 1 column 1 (char 0))
Owner: wb-cpu-worker (biome output handling)
Action: Check why biome returns empty output on this repository and how the worker calls it.
Acceptance: On re-run, handler.failed is not logged for biome and its S3 output is valid JSON."""
    },
    # Example C: EMPTY, Insufficient evidence (Section 4 Example C)
    {
        "input": """INPUT
TOOL: lizard
STATE: EMPTY
LANGUAGE: typescript, Node 20
BRANCH: TS_V20_VITE_NPM_MICRO   RUN: cb82c004-f28a-4b99-a5f0-04371c34ace7
S3: []
LOG EVIDENCE: none
POD STATE: all Running, 0 restarts""",
        "output": """RCA: lizard - EMPTY
Verdict: Insufficient evidence
Root cause: lizard ran and wrote an empty list, and no log line names lizard, so the logs do not show why it found nothing.
Evidence:
- none
Owner: Unknown
Action: Collect the lizard task log of this run and the list of files it was given.
Acceptance: lizard writes a non-empty result for this repository, or the logs state why there is nothing to measure."""
    },
    # Example D: NOT_TRIGGERED, Excluded in planning
    {
        "input": """INPUT
TOOL: crosshair
STATE: NOT_TRIGGERED
LANGUAGE: python, 3.10
BRANCH: PY_V310_POETRY   RUN: bbbd08e3-c9ea-40e8-a68e-519f44d9f156
S3: no folder
LOG EVIDENCE:
18:52:35 INFO cell-001-wb-orchestrator: planning.compatibility_excluded (tool_name=crosshair tool_version=0.0.60 verdict=INCOMPATIBLE reason=CUSTOMER_CODE_INCOMPATIBLE_WITH_EXECUTION_ENV detail=customer code version is unresolved)
POD STATE: all Running, 0 restarts""",
        "output": """RCA: crosshair - NOT_TRIGGERED
Verdict: Excluded in planning
Root cause: wb-orchestrator excluded crosshair 0.0.60 during planning because the customer code version was unresolved.
Evidence:
- 18:52:35 INFO cell-001-wb-orchestrator: planning.compatibility_excluded (tool_name=crosshair tool_version=0.0.60 reason=CUSTOMER_CODE_INCOMPATIBLE_WITH_EXECUTION_ENV)
Owner: cell-001-wb-orchestrator
Action: Resolve the customer code version in the orchestrator or pin exact versions in the repository lockfile.
Acceptance: On re-run, planning.compatibility_excluded is not logged for crosshair and a task is scheduled."""
    },
    # Example E: OUTPUT, produced real output
    {
        "input": """INPUT
TOOL: eslint
STATE: OUTPUT
LANGUAGE: typescript, Node 20
BRANCH: TS_V20_VITE_NPM_MICRO   RUN: cb82c004-f28a-4b99-a5f0-04371c34ace7
S3: [{"filePath": "index.ts", "messages": []}]
LOG EVIDENCE: none
POD STATE: all Running, 0 restarts""",
        "output": """No RCA needed: the tool produced output."""
    },
]


def generate_jsonl(output_file: str):
    """Converts raw examples into standard ChatML conversation format."""
    dataset = []
    for ex in EXAMPLES:
        conversation = {
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": ex["input"]},
                {"role": "assistant", "content": ex["output"]}
            ]
        }
        dataset.append(conversation)

    out_path = pathlib.Path(output_file)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        for item in dataset:
            f.write(json.dumps(item) + "\n")

    print(f"Dataset generated successfully: {out_path} ({len(dataset)} examples)")


if __name__ == "__main__":
    out = pathlib.Path(__file__).parent / "dataset.jsonl"
    generate_jsonl(str(out))
