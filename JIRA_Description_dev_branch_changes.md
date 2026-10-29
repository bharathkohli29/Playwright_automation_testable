# [Whitebox Automation] Background post-processing, permanent SharePoint upload and live logging (dev branch)

## Summary
The merge-flow automation on the `dev` branch now runs the S3 check, SharePoint upload and Teams message of a finished branch in a **separate background worker**, while the next branch is already executing on Testable. SharePoint upload no longer depends on a per-developer OneDrive shortcut that had to be changed every day. Network failures are retried, and the worker's progress is visible live.

## Background / problem
- After each branch the script did the S3 check, bug drafts, SharePoint copy and Teams message **before** starting the next branch, so the Testable platform sat idle between branches (extra cost).
- The SharePoint copy used a OneDrive shortcut with a local path and a daily folder name, which each developer had to edit in `.env`. It could not be shared by a team.
- A short network or DNS outage during the post-processing lost the whole result of a branch (S3, bug drafts, SharePoint and Teams), and the status file still said the Teams step was `done`.
- There was no live view of what the post-processing was doing.

## What was done
Commits on `dev` (28 Oct 2026): `1c1d6b9`, `7c6f15b`, `d7207bc`, `00ab5b5`, `68bf61d`, `707f5da`, `f3a7f75`, `6c8a16e`.

1. **Merged `merge-flow` into `dev`** (`1c1d6b9`). Brings the Java, TypeScript, C# and JavaScript tool validation, bug drafts for all languages, the Teams tool summary, the freeze tracker and keep-awake. Conflicts in `bugReport.ts` and `s3Evidence.ts` were resolved to the newer `merge-flow` versions.
2. **Background post-processing worker** (`7c6f15b`).
   - After step 15 (taxonomy download + `run-details.json`) a passed branch is handed over through a job file in `results/<run>/.postprocess/`; the next branch starts at once.
   - The worker (`tsx utils/postprocessWorker.ts`) handles one branch at a time: S3 check + validators + bug drafts, then SharePoint, then Teams.
   - Jobs are plain files, so a crashed worker is recovered. Per-branch status is written to `postprocess.json`.
   - A final test, `Background post-processing finishes`, waits for the worker after Logout.
   - `POSTPROCESS=inline` restores the old one-after-the-other behaviour.
3. **Permanent SharePoint upload** (`d7207bc`, `00ab5b5`).
   - Target: `Automation Evidences Dump / <DD-MM-YYYY> / <branch>` in the Testable-ExecutionTeam library; a repeat run the same day goes to `<branch>_RUN2`, `_RUN3`. The Teams card gets the real folder link.
   - **Own-sign-in mode (no admin needed):** `npm run sp:login` once per developer; the session is saved in `.auth/` and used through the SharePoint REST API.
   - **Microsoft Graph mode:** used when `SP_CLIENT_ID` and `SP_TENANT_ID` are set (needs an Entra app registration; token refreshes by itself).
   - The old OneDrive copy (`SHAREPOINT_DIR`) stays as the last fallback.
4. **Reliability fixes** (`68bf61d`).
   - Network-type failures (ENOTFOUND, timeouts, fetch failed, HTTP 5xx) are retried after 30 s, 90 s and 3 min.
   - A Teams message that could not be sent is now reported as `failed`, not `done`.
   - Fixed an endless loop in the SharePoint folder check (SharePoint answers `200 {"Exists": false}` for a missing folder) and a request-URL-length failure for deep `s3-evidence` paths.
   - New command `npm run post -- "<branch folder>" --repo owner/name` repeats the post-processing of one finished branch.
   - `SP_DEBUG=1` prints every SharePoint call.
5. **Live logging** (`707f5da`). The worker's lines are copied into the test output every 3 seconds with the branch name on each line (`[post] [<branch>] ...`), so branch N's post-processing can be watched while branch N+1 runs.
6. **Housekeeping.** Two TypeScript type errors in `utils/awsS3.ts` fixed (`tsc --noEmit` is clean); `.env.example` documents `GATE_SHOTS`, `POSTPROCESS`, `SP_*`.
7. **Documentation** (`f3a7f75`, `6c8a16e`). `README.md` and `Workflow_Guide_dev_branch.pdf` (15 pages: diagrams, the 15 browser steps, worker, step-by-step use, file map, `.env` reference, results folders, troubleshooting).

## Files
| File | Change |
|---|---|
| `utils/postprocess.ts` | The three worker steps, retries, per-branch `postprocess.json` |
| `utils/postprocessQueue.ts` | Hand-off from the test, starts the worker, live log tail, final wait |
| `utils/postprocessWorker.ts` | The worker process, one job at a time, branch prefix on log lines |
| `utils/postprocessCli.ts` | `npm run post` (redo one branch) |
| `utils/sharepointSession.ts` | SharePoint upload with the developer's own sign-in (REST) |
| `utils/sharepointGraph.ts` | SharePoint upload through Microsoft Graph, URL parser, day-folder naming |
| `utils/spLogin.ts` | `npm run sp:login` |
| `utils/teams.ts` | `notifyTeams` now returns whether the message was sent |
| `tests/merge-flow.spec.ts` | Hand-off after step 15, final wait test, inline fallback |
| `utils/awsS3.ts` | Type fixes |
| `package.json`, `.env.example` | `tsx` dev dependency, scripts `sp:login` and `post`, new settings |
| `README.md`, `Workflow_Guide_dev_branch.pdf` | Documentation |

## How to use
1. `git checkout dev`, `npm install`, copy `.env.example` to `.env` and fill it (Testable login, AWS keys, Teams webhook).
2. Once per developer: `npm run sp:login` (sign in with the Microsoft work account).
3. Run: set `BRANCHES` (comma-separated GitHub `/tree/` links) or fill `builds.json`, then `npm test` or run the `flow` project in the Test Explorer.
4. The last test, `Background post-processing finishes`, turning green means everything is done. Redo a branch with `npm run post`.

## Verification
- `npx tsc --noEmit` clean; `playwright test --list` shows the new tests.
- Dry runs of the worker and of both SharePoint modes against local mock servers (without `.env`).
- Real runs on QA, 28 Oct 2026:
  - Two C# branches (`CS_VNETFX45_...`): branch 1 passed at 13:25:17, the worker started in the same second and had S3, SharePoint and Teams `done` at 13:28:28 while branch 2 was still executing; both branches ended `done`.
  - Two Java branches (`JV_V16_...` was blocked by the site, `JV_V12_...` passed): the SharePoint step of the passed branch revealed the endless folder-check loop and the URL-length problem; after the fixes all 82 files were uploaded and the Teams card was sent.
  - Two further branches (`JV_V11_...`): worker started for branch 1 while branch 2 executed.

## Known limitations / follow-ups
- The SharePoint own-sign-in session lasts as long as the company's sign-in policy allows; when it ends, `npm run sp:login` must be run again. Files over 240 MB are not uploaded (listed in `sharepoint-copy-errors.txt`).
- Microsoft Graph mode needs an Entra app registration created by an admin; app-only (unattended) Graph is not implemented.
- The queue server page does not yet show a "post-processing" state per branch.
- Ideas discussed, **not** built: an account-aware queue for two Testable accounts (next branch goes to the free account), and running the flow in a GitHub Actions pipeline (needs app-only SharePoint, AWS OIDC role, and a check that the QA site is reachable from GitHub runners).
- A branch blocked by the site ("Branch unavailable") is a Testable-side issue and is not handled by the script.

## Acceptance criteria
- [ ] When a branch passes, the next branch starts without waiting for the S3 check, SharePoint upload or Teams message of the previous one.
- [ ] Each passed branch gets its Teams card and its SharePoint folder (`<DD-MM-YYYY>/<branch>`) with the whole branch folder, including `s3-evidence` and `bugs`.
- [ ] A short network outage does not lose a branch's post-processing; a step that still fails is reported as `failed` in `postprocess.json`.
- [ ] `[post] [<branch>]` lines appear in the test output while the next branch is executing.
- [ ] `npm run post -- "<branch folder>"` redoes the post-processing of one branch.
- [ ] `POSTPROCESS=inline` gives the previous behaviour.
