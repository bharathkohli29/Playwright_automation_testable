# Handoff: testable-merge-flow (paste this first in the new chat)

Project: Playwright TypeScript project `testable-merge-flow` at `C:\Users\Work\Downloads\testable-merge-flow`. Project 1 (`testable-e2e`) is ON HOLD.

## What it does
Automates the whitebox flow on Testable (QA https://qa-frontend.testable.cc default; DEV with `TEST_ENV=dev`): reads UI gate values, downloads the taxonomy report, saves the run record, checks tool evidence in S3 (qa-bucket-us2 / dev-bucket-us2, us-east-2) and merges it into `*-with-ui-values.html`.
Run: `npm test` (VS Code Terminal), `npm run s3` (re-check: `$env:S3_RESULTS_DIR="results\<folder>"; $env:S3_FORCE=1`).
Inputs: `builds.json` ({"repo":..., "branches":[...]} or full GitHub /tree/ links). Env: LANGUAGE, REPO, BRANCHES, S3_BUCKET, TEST_ENV, BASE_URL, BUILDS_FILE, RUN_TIMEOUT_MIN, GATE_SHOTS=off.

## Flow per branch
1 open chat; 2 New analysis (first branch); 3 connect repo; 4 click repo; 5 select branch; 6 "On PR merge" ticked; 7 confirm; 8 coverage preview (skipped if site reuses analysis); 9 continue; 10 execute run; 11 open Confidence Engine; 12 wait for finish; 13 PR score screenshot; 14 gate values (+screenshots); 15 taxonomy download + run record + merge; 16 S3 check; then next branch; finally logout.

## S3 rules (must match workbook Tool_Execution_Results 1 (1).xlsx; JS, TS, Python, C#; Java excluded)
Secondary tool only when primary FOLDER missing; secondary names = catalog names; each language shows only its own files in shared folders; combined primary checks both; primary N/A rows check only secondary; `secondary` tag when used; TS must not use JS tool names; git-churn is C#'s secondary; save ALL S3 files locally.
Verdicts: PASS (data), EMPTY (triggered, empty), FAIL (no folder / no json-xml / failure.json with no data file). DONE and pushed: failure.json → FAIL.

## Status
- Pushed: all above incl. failure.json→FAIL (`utils/s3Evidence.ts`).
- NOT pushed: `GATE_SHOTS=off` in `pages/MergeFlowPage.ts` (cloud copy edited; push when user's run is finished). Gate values still read.
- Open: Java mapping (need tool list) + `JV_` prefix; language detection from S3 folders; C# real tool names; taxonomy download retry; extras tables (SOC2, FERPA, IaC, Performance, Secret Detection).

## Working rules
Edit cloud copy, typecheck, push with device_commit_files (force). Don't edit files mid-run. State understanding before edits. Give JSON only when asked ("give json"). Keep credentials out of chat; AWS temp keys expire ~1h.

Full transcript: `testable-merge-flow-conversation.md` (credentials redacted).
