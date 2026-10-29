"""
Dataset Preparation Script for Fine-Tuning QA-EKS-Mentor.

This script demonstrates how to format QA data into the standard ChatML / OpenAI JSONL format
required by fine-tuning frameworks like Unsloth, Hugging Face TRL, and Axolotl.
"""
import json
import pathlib

# Step 1: The System Prompt (Defines the model's persona)
SYSTEM_PROMPT = """You are a Whitebox QA defect analysis analyst. Given EKS logs and run facts, write a concise, strictly factual defect report with exact citations."""

# Step 2: Training Examples (Input Evidence -> Target Gold Standard Report)
# In a real training run, you will have 50-200+ of these examples.
EXAMPLES = [
    {
        "evidence": """TOOL: crosshair
RUN ID: bbbd08e3-c9ea-40e8-a68e-519f44d9f156
EKS LOG:
2026-10-27T18:52:35.109530+00:00 cell-001-wb-orchestrator activities.planning: planning.compatibility_excluded
Tool: crosshair 0.0.60 | Verdict: INCOMPATIBLE | Reason: CUSTOMER_CODE_INCOMPATIBLE_WITH_EXECUTION_ENV
Detail: customer code version is unresolved; a provider that executes customer code may not run against an unproven environment
POD STATE: All pods running with 0 restarts.""",
        "expected_output": """# crosshair - Not Triggered (Run bbbd08e3)
**Verdict:** Planning defect   **Priority:** Medium   **Confidence:** High

## 1. Summary
wb-orchestrator excluded crosshair 0.0.60 during planning because the customer code version was unresolved and could not be verified against available execution environments.

## 2. Run Metadata
- Run ID: bbbd08e3-c9ea-40e8-a68e-519f44d9f156
- Tool: crosshair (0.0.60)
- Tenant: d606c2bf-6761-4df3-b33c-00f32026c165

## 3. Evidence from QA EKS
- `2026-10-27T18:52:35.109530+00:00` `activities.planning` `planning.compatibility_excluded` (cell-001-wb-orchestrator)
    - crosshair 0.0.60: INCOMPATIBLE / CUSTOMER_CODE_INCOMPATIBLE_WITH_EXECUTION_ENV
    - detail: customer code version is unresolved; a provider that executes customer code may not run against an unproven environment

## 4. Root Cause
wb-orchestrator excluded crosshair 0.0.60 during planning: verdict INCOMPATIBLE, reason CUSTOMER_CODE_INCOMPATIBLE_WITH_EXECUTION_ENV.

## 5. Recommended Fix
- **Owner:** Platform (wb-orchestrator environment resolution)
- **Action:** Fix the customer code version resolution in the orchestrator or pin exact versions in repo lockfiles.

## 6. QA Acceptance Criteria
- On re-run, a worker task is created for crosshair.
- S3 receives a valid crosshair output JSON.
- Taxonomy gate changes from FAIL to PASS."""
    },
    {
        "evidence": """TOOL: crosshair
RUN ID: 86a8ebb0-b28e-411e-82f2-74b467dfdf63
EKS LOG:
No orchestrator planning events found for crosshair in the last 72 hours.
Earliest log on cluster: 2026-10-27T15:27:34+00:00.
POD STATE: All pods running with 0 restarts.""",
        "expected_output": """# crosshair - Not Triggered (Run 86a8ebb0)
**Verdict:** Insufficient evidence   **Priority:** Low   **Confidence:** Low

## 1. Summary
No log lines for this run or tool were found in the retained QA EKS logs. The root cause cannot be determined without archived logs.

## 2. Run Metadata
- Run ID: 86a8ebb0-b28e-411e-82f2-74b467dfdf63
- Tool: crosshair

## 3. Evidence from QA EKS
- No decisive events found in retained log window.
- Pod health: all pods Running with 0 restarts.

## 4. Root Cause
No log line for this run was found. The cause cannot be determined from active QA EKS logs.

## 5. Recommended Fix
- **Owner:** Unknown
- **Action:** Re-run the pipeline and extract logs immediately, or check S3/CloudWatch log archives.

## 6. QA Acceptance Criteria
- Fresh logs captured within retention window showing planning decision."""
    }
]


def generate_jsonl(output_file: str):
    """Converts raw examples into standard ChatML conversation format."""
    dataset = []
    for ex in EXAMPLES:
        conversation = {
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"EVIDENCE:\n{ex['evidence']}"},
                {"role": "assistant", "content": ex["expected_output"]}
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

