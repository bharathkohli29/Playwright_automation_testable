import { test } from '@playwright/test';
import * as fs from 'fs';
import { CaseRunner } from '../utils/cases';
import { MergeFlowPage } from '../pages/MergeFlowPage';
import { loadBuilds } from '../utils/builds';
import { branchDir, watchNetwork, addSummary } from '../utils/evidence';
import { mergeTaxonomy } from '../utils/mergeTaxonomy';
import { checkBranchS3, hasAwsCredentials } from '../utils/s3Evidence';
import { describeAwsError } from '../utils/awsS3';
import { dummyPrEnabled, pushDummyCommit } from '../utils/dummyCommit';
import { notifyTeams } from '../utils/teams';
import { shareBranch } from '../utils/postprocess';
import { attachPreviousFromSharePoint } from '../utils/sharepointHistory';
import { postprocessMode, enqueuePostProcess, echoWorkerLog, drainPostProcess } from '../utils/postprocessQueue';

const builds = loadBuilds();
test.skip(builds.length === 0, 'No branches configured — fill in builds.json');

// One branch after another; each waits for its execution to complete before the next starts.
builds.forEach((build, index) => {
  test(`Whitebox run — ${build.dir}`, async ({ page }) => {
    test.setTimeout((Number(process.env.RUN_TIMEOUT_MIN || 35) + 30) * 60_000); // wait limit + room for the rest of the steps
    const cases = new CaseRunner(test, page);
    const flow = new MergeFlowPage(page);
    const network = watchNetwork(page);
    const id = (n: number) => `${build.id}/${n}`;
    const started = Date.now();
    let status = 'passed';
    let note = '';
    let handedOff = false; // true = the background worker does this branch's S3 check, SharePoint copy and Teams message

    // step 0 (only when DUMMY_PR=yes in .env): push a dummy README comment so this branch has a NEW commit to analyse
    if (dummyPrEnabled()) pushDummyCommit(build.repo, build.branch);
    else console.log('  dummy PR: off (set DUMMY_PR=yes in .env to push a new commit before the run)');

    try {
      await cases.run(id(1), 'Chat Execution Assistant opens' + (index ? ' (sidebar chat icon)' : ''), async () => {
        await flow.openChat(index > 0);
      }, { critical: true });

      if (index === 0) {
        await cases.run(id(2), '"Can I safely deploy this commit?" → New analysis / Refresh repos', async () => {
          await flow.startNewAnalysis();
        });
      }

      await cases.run(id(3), 'Change repository / branch → Connect / Import repository → repo list', async () => {
        await flow.connectRepo();
      }, { critical: true });

      await cases.run(id(4), `Click repo ${build.repo} → Configure repository`, async () => {
        await flow.chooseRepo(build.repo);
      }, { critical: true });

      await cases.run(id(5), `Select branch ${build.branch} ("+N branches" → search → tick → Done)`, async () => {
        await flow.chooseBranch(build.branch);
      }, { critical: true });

      await cases.run(id(6), '"On PR merge" trigger is ticked', async () => {
        await flow.ensurePrMergeTicked();
        await cases.snap(id(6));
      }, { critical: true });

      await cases.run(id(7), 'Confirm repository', async () => {
        await flow.confirmRepo(build.branch);
      }, { critical: true });

      await cases.run(id(8), 'Coverage preview: Repo structure / What we\'ll analyze / View uncovered areas screenshots', async () => {
        await flow.coveragePreview(branchDir(build.dir));
      });

      await cases.run(id(9), 'Continue from the coverage preview / Review branches', async () => {
        await flow.continueFromReview();
      }, { critical: true });

      await cases.run(id(10), 'Run plan → Execute run', async () => {
        await flow.executeRun();
        await cases.snap(id(10));
      }, { critical: true });

      await cases.run(id(11), 'Execution status → Open Confidence Engine', async () => {
        await flow.openConfidenceEngine();
      }, { critical: true });

      await cases.run(id(12), 'Wait for the analysis to complete (Execution Status tick)', async () => {
        await flow.waitForRunToFinish();
        await flow.screenshotExecutionStatus(`${branchDir(build.dir)}/05_execution_status.png`);
        await cases.snap(id(12));
      }, { critical: true });

      await cases.run(id(13), 'Screenshot: PR Confidence Analysis score', async () => {
        await flow.screenshotPrScore(`${branchDir(build.dir)}/04_pr_confidence_score.png`);
      });

      await cases.run(id(14), 'Gate analysis: every technique × classification screenshot', async () => {
        const files = await flow.captureUiScore(branchDir(build.dir, 'gates'));
        if (files.length === 0) throw new Error('No gate screenshots were captured');
      });

      await cases.run(id(15), 'Download taxonomy report (icon, top right of Gate Analysis)', async () => {
        console.log(`  Taxonomy report saved: ${await flow.downloadTaxonomyReport(branchDir(build.dir))}`);
        mergeTaxonomy(branchDir(build.dir)); // taxonomy report + UI value column
        const rep = fs.readdirSync(branchDir(build.dir)).find((f) => /^taxonomy-gate-.*\.html$/i.test(f) && !/with-/.test(f));
        const runId = rep ? /taxonomy-gate-(.*)\.html/i.exec(rep)?.[1] : undefined;
        console.log(`  Run record saved: ${await flow.saveRunRecord(branchDir(build.dir), build.branch, runId)}`);
        // guard: the run opened on the site must be the branch we asked for (a stale / other run would be filed under the wrong name)
        const rec = JSON.parse(fs.readFileSync(`${branchDir(build.dir)}/run-details.json`, 'utf8'));
        if (rec.branch_name !== build.branch) {
          const msg = `RUN MISMATCH: folder "${build.branch}" but the run on the site is ${rec.run_id} on branch "${rec.branch_name}" (commit ${String(rec.commit_sha).slice(0, 8)})`;
          console.log(`  ⚠ ${msg}`);
          fs.writeFileSync(`${branchDir(build.dir)}/RUN-MISMATCH.txt`, msg + '\n');
        }
      });

      // POSTPROCESS=background (default): S3 evidence, SharePoint copy and Teams message run in a separate worker (no browser needed),
      // so the next branch starts at once and the platform is not left idle. POSTPROCESS=inline: done here, one branch after the other.
      const bdir = branchDir(build.dir);
      const background = postprocessMode() === 'background';
      if (!background && fs.existsSync(`${bdir}/run-details.json`)) {
        if (!hasAwsCredentials()) console.log('  S3 check skipped — no AWS keys in .env (paste the QA-S3-Readonly keys, or run npm run s3 later)');
        else {
          try { console.log('\n  S3 evidence for this branch …'); await checkBranchS3(bdir, undefined, build.repo); }
          catch (e) { console.log(`  S3 check failed (site run is not affected): ${e instanceof Error && e.message ? e.message : describeAwsError(e)}`); }
        }
      }

      cases.finish();
      if (background && fs.existsSync(`${bdir}/run-details.json`)) {
        handedOff = enqueuePostProcess({ branchDir: bdir, branch: build.branch, repo: build.repo, url: page.url(), minutes: Math.round((Date.now() - started) / 60000) });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      status = /BLOCKED/.test(msg) ? 'blocked' : /ENVIRONMENT/.test(msg) ? 'environment' : 'failed';
      note = msg.slice(0, 500);
      const err = branchDir(build.dir, 'errors');
      await page.screenshot({ path: `${err}/failure.png`, fullPage: true }).catch(() => {});
      fs.writeFileSync(`${err}/network.json`, JSON.stringify(network, null, 2));
      if (/BLOCKED by the site/.test(msg)) fs.writeFileSync(`${err}/site-error.txt`, `${msg}\n`); // exactly what the site said, so the branch can be stopped at once and the reason is kept
      if (/BLOCKED by the site/.test(msg)) console.log(`  ⛔ stopping this branch: ${msg.slice(0, 200)} — saved in errors/site-error.txt; moving on to the next branch`);
      throw e;
    } finally {
      addSummary({
        branch: build.branch, status, note, url: page.url(),
        runId: /runId=([\w-]+)/.exec(page.url())?.[1] ?? null,
        minutes: Math.round((Date.now() - started) / 60000),
      });
      // PASSED branches only: copy the folder to SharePoint through the OneDrive shortcut in .env (SHAREPOINT_DIR); empty = off; never throws. Failed / blocked branches stay local (the Teams picture is enough).
      // (handed-off branches: the background worker does the copy and the message after the S3 check)
      if (!handedOff) {
        let evidenceUrl: string | undefined;
        if (status === 'passed') await attachPreviousFromSharePoint(branchDir(build.dir)).catch(() => {}); // the earlier run for the Tool Trigger Log, from SharePoint
        if (status === 'passed') { try { evidenceUrl = (await shareBranch(branchDir(build.dir))).url; } catch (e) { console.log(`  SharePoint: not copied (${e instanceof Error ? e.message : e}) — the run is not affected`); } }
        // Teams message (add-on; only when TEAMS_WEBHOOK_URL is set; never throws)
        await notifyTeams(page, {
          branch: build.branch, repo: build.repo, status, note, url: page.url(),
          minutes: Math.round((Date.now() - started) / 60000), branchDir: branchDir(build.dir),
          evidenceUrl: status === 'passed' ? evidenceUrl : undefined,
          imagePath: status === 'passed' ? undefined : `${branchDir(build.dir, 'errors')}/failure.png`,
        });
      }
      echoWorkerLog(); // lines the background worker wrote meanwhile (earlier branches)
    }
  });
});

// Once, after the last branch.
test('Logout', async ({ page }) => {
  const flow = new MergeFlowPage(page);
  await flow.gotoWithRetry('/execution-assistant');
  await flow.logout();
});

// After the logout: wait until the background worker has finished the S3 check / SharePoint copy / Teams message of every branch.
test('Background post-processing finishes', async () => {
  test.setTimeout(75 * 60_000);
  // POSTPROCESS_WAIT=off: set by the two-account launcher (npm run parallel), which waits for every lane's worker itself at the very end
  if (postprocessMode() === 'background' && process.env.POSTPROCESS_WAIT !== 'off') await drainPostProcess(70);
});
