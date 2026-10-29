import type { Page, Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Flow (recorded live 29 Sep with the user):
 *   Execution Assistant home → "Change repository / branch" → "Connect / Import repository"
 *   → wait for repo sync → click the repo name → "Configure repository" card:
 *        pick branch via "+N branches" → search → tick → Done; make sure "On PR merge" is ticked
 *   → "Confirm repository" → "Review branches" card: wait for the tick, then "Continue"
 *   → run plan → "Execute run" (may answer "Couldn't start the run · Admission delayed:
 *        guarantee_packing_exceeded" → "Retry execute").
 *
 * Steps after Execute run (wait for completion, UI score, taxonomy report, logout) are still
 * placeholders until the user shows them.
 */
export class MergeFlowPage {
  private runsUrl = '';
  constructor(private page: Page) {
    // remember the runs-list request the app makes (same one you see in DevTools → Network → runs?tenant_id=…)
    page.on('request', (r) => { if (/\/views-api\/v1\/runs\?/.test(r.url())) this.runsUrl = r.url(); });
  }

  /** Saves this run's record from the runs API (run_id, status, scores, timings…) to run-details.json. */
  async saveRunRecord(destDir: string, branch: string, runId?: string): Promise<string> {
    const fs = await import('fs');
    for (let i = 0; i < 20 && !this.runsUrl; i++) await this.page.waitForTimeout(1000);
    if (!this.runsUrl) throw new Error('The app has not called the runs API (views-api/v1/runs)');
    const body = await this.page.evaluate(async (u) => (await fetch(u, { credentials: 'include' })).json(), this.runsUrl);
    const all: any[] = [];
    const walk = (x: any) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (x.run_id && x.branch_name) all.push(x); else Object.values(x).forEach(walk); } };
    walk(body);
    const mine = all.filter((r) => (runId ? r.run_id === runId || r.root_run_id === runId : r.branch_name === branch));
    if (!mine.length) throw new Error(`Run ${runId || branch} not found in the runs API response (${all.length} runs)`);
    mine.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    fs.mkdirSync(destDir, { recursive: true });
    const file = `${destDir}/run-details.json`;
    fs.writeFileSync(file, JSON.stringify(mine[0], null, 2));
    return file;
  }

  btn = (name: string | RegExp) => this.page.getByRole('button', { name, exact: typeof name === 'string' });
  dialog = () => this.page.getByRole('dialog');

  /**
   * Messages the site shows when a branch can NOT go on (e.g. 'Branch JS_V21_… could not be established for this repository' /
   * "Branch unavailable — Select a valid branch"). When one is on the page there is no point waiting for the next step: stop this branch.
   */
  private siteErrorBox = () => this.page.getByText(/Branch unavailable|could not be established for this repository|Select a valid branch/i).last();

  // The chat keeps OLD messages: a "Branch unavailable" of an earlier branch can still be in the thread when the next branch starts.
  // So only a message that is NEW since this branch began counts (the count at the start is remembered by markSiteErrorBaseline()).
  private siteErrBase = 0;
  async markSiteErrorBaseline() {
    this.siteErrBase = await this.siteErrorBox().count().catch(() => 0);
  }

  /** The text of the blocking message, or null when the page shows none (that is new for this branch). */
  async siteError(): Promise<string | null> {
    const box = this.siteErrorBox();
    const n = await box.count().catch(() => 0);
    if (n < this.siteErrBase) this.siteErrBase = n; // a fresh thread / page: nothing old is left
    if (n <= this.siteErrBase || !(await box.isVisible().catch(() => false))) return null;
    const txt = (await box.locator('xpath=ancestor::*[self::div or self::section][2]').innerText().catch(() => '')) || (await box.innerText().catch(() => ''));
    return txt.replace(/\s+/g, ' ').trim().slice(0, 300) || 'blocking message on the page';
  }

  /** Throws BLOCKED (→ this branch stops at once, the error is saved, the next branch starts) when the page shows a blocking message. */
  async failIfSiteError(where: string) {
    const msg = await this.siteError();
    if (msg) throw new Error(`BLOCKED by the site (${where}): ${msg}`);
  }

  /** Looks for a blocking message for up to `sec` seconds (messages like "Branch unavailable" show a few seconds after Confirm). */
  async watchSiteError(sec: number, where: string) {
    const end = Date.now() + sec * 1000;
    do { await this.failIfSiteError(where); await this.page.waitForTimeout(1_000); } while (Date.now() < end);
  }

  async currentCrumb(): Promise<string> {
    return (await this.page.locator('[aria-current="page"], .breadcrumb-current').last().innerText().catch(() => '')).trim();
  }

  async openHome() {
    await this.page.goto('/execution-assistant');
    await expect(this.btn('Change repository / branch')).toBeVisible({ timeout: 45_000 });
  }

  /** Chat Execution Assistant. For the 2nd+ branch use the sidebar chat icon (falls back to the URL). */
  async openChat(useSidebar: boolean) {
    const side = this.page.locator('a[href*="/execution-assistant"]').first();
    if (useSidebar && (await side.isVisible().catch(() => false))) await side.click();
    else await this.gotoWithRetry('/execution-assistant');
    await expect(this.btn('Change repository / branch')).toBeVisible({ timeout: 45_000 });
    await this.markSiteErrorBaseline(); // messages already in the chat belong to earlier branches
  }

  /** The QA site sometimes times out / drops the connection: retry the navigation with a back-off. */
  async gotoWithRetry(url: string) {
    const waitSec = [15, 30, 60, 90, 120];
    for (let i = 0; ; i++) {
      try {
        await this.page.goto(url, { timeout: 60_000 });
        return;
      } catch (e) {
        if (i >= waitSec.length) throw new Error(`ENVIRONMENT: ${url} not reachable after retries — ${(e as Error).message.split('\n')[0]}`);
        console.log(`  ⏳ ${url} not reachable (${(e as Error).message.split('\n')[0]}); retrying in ${waitSec[i]}s…`);
        await this.page.waitForTimeout(waitSec[i] * 1000);
      }
    }
  }

  /**
   * Plan steps 4–6 (selectors NOT verified live yet): click "Can I safely deploy this commit?" under the
   * chat bar; then "New analysis" if the latest whitebox execution is shown, else "Refresh repos".
   */
  async startNewAnalysis() {
    const prompt = this.page.getByText(/Can I safely deploy this commit/i).last();
    if (await prompt.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false)) await prompt.click();
    const newAnalysis = this.page.getByRole('button', { name: /new analysis/i }).last();
    const refresh = this.page.getByRole('button', { name: /refresh repos/i }).last();
    const which = await Promise.race([
      newAnalysis.waitFor({ state: 'visible', timeout: 15_000 }).then(() => 'new' as const),
      refresh.waitFor({ state: 'visible', timeout: 15_000 }).then(() => 'refresh' as const),
    ]).catch(() => 'none' as const);
    if (which === 'new') await newAnalysis.click();
    else if (which === 'refresh') await refresh.click();
    console.log(`  start-of-analysis: ${which === 'new' ? 'clicked New analysis' : which === 'refresh' ? 'clicked Refresh repos' : 'neither button found — using Change repository / branch'}`);
  }

  /** Waits for a coverage-preview section, but stops at once (BLOCKED by the site) when the page says "Analysis is blocked on …" instead of waiting the full time. */
  async waitSectionOrBlocked(section: Locator, what: string, ms: number) {
    const blockedBox = this.page.getByText(/Analysis is blocked on/i).last();
    const end = Date.now() + ms; let since = 0;
    while (Date.now() < end) {
      if (await section.isVisible().catch(() => false)) return;
      await this.failIfSiteError(what);
      if (await blockedBox.isVisible().catch(() => false)) {
        since ||= Date.now();
        if (Date.now() - since > 10_000) {
          const why = (await blockedBox.locator('xpath=..').innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);
          throw new Error(`BLOCKED by the site (${what}): ${why || 'Analysis is blocked'}`);
        }
      } else since = 0;
      await this.page.waitForTimeout(1_000);
    }
  }

  /**
   * Plan steps 10–12 (selectors NOT verified live yet): open each coverage-preview section and screenshot it.
   * Throws BLOCKED if the preview never appears (e.g. assessment stuck on "Checking…").
   */
  async coveragePreview(dir: string) {
    // Screens the user asked for (29 Sep): 1) "Repository details" accordion opened, 2) "What we'll analyze"
    // accordion opened, 3) "View uncovered areas →" modal ("Uncovered areas").
    const accordions: [string, RegExp][] = [
      ['01_repo_structure.png', /^repository details$|repo(sitory)? structure/i],
      ['02_what_we_will_analyze.png', /^what we.ll analy[sz]e$/i],
    ];
    // The site skips the coverage preview when the commit was analyzed before ("This commit is already analyzed … Analyze latest commit").
    // Don't wait 5 minutes for sections that will never come.
    const first = this.page.getByText(accordions[0][1]).last();
    // On this screen the site says "Repository ready · <repo> · <branch> · <sha> · Source already available" (build is reused);
    // "This commit is already analyzed" only shows later. Either one, or a ready "Review branches → Continue" card with no
    // Repository details section after a short grace time, means the preview is skipped.
    const already = this.page.getByText(/already analy[sz]ed|source already available/i).last();
    const reviewContinue = this.page.getByRole('button', { name: /^continue$/i }).last();
    const seen = await Promise.race([
      first.waitFor({ state: 'visible', timeout: 90_000 }).then(() => 'preview' as const),
      already.waitFor({ state: 'visible', timeout: 90_000 }).then(() => 'already' as const),
      this.siteErrorBox().waitFor({ state: 'visible', timeout: 90_000 }).then(() => 'error' as const),
    ]).catch(() => 'none' as const);
    if (seen === 'error') await this.failIfSiteError('coverage preview');
    if (seen !== 'preview') {
      // give a real preview a moment to show up before deciding it was skipped
      await first.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
      const previewShown = await first.isVisible().catch(() => false);
      const canContinue = await reviewContinue.isVisible().catch(() => false);
      if (!previewShown && (seen === 'already' || canContinue)) {
        console.log('  coverage preview skipped — the site reuses an earlier analysis of this commit ("Source already available" / already analyzed), so there are no repository-details / uncovered-areas screens for it');
        return;
      }
    }
    for (const [file, re] of accordions) {
      const head = this.page.getByText(re).last();
      await this.waitSectionOrBlocked(head, `coverage preview section ${re}`, 60_000); // 1 minute (was 5); a blocked branch stops after ~10 s anyway
      await expect(head, `BLOCKED: coverage preview section ${re} did not appear`).toBeVisible({ timeout: 5_000 });
      await head.scrollIntoViewIfNeeded();
      await head.click();
      await this.page.waitForTimeout(1_000);
      // heading at the top of the view so the opened content is in the picture
      await head.evaluate((el) => el.scrollIntoView({ block: 'start' })).catch(() => {});
      await this.page.waitForTimeout(500);
      await this.page.screenshot({ path: `${dir}/${file}` });
      if (file.startsWith('01_')) await this.saveRepoDetails(dir).catch((e) => console.log(`  (repo details not saved: ${e instanceof Error ? e.message : e})`));
    }
    const uncovered = this.page.getByRole('button', { name: /view uncovered areas/i }).last();
    await expect(uncovered, 'BLOCKED: "View uncovered areas" did not appear').toBeVisible({ timeout: 60_000 });
    await uncovered.scrollIntoViewIfNeeded();
    await uncovered.click();
    await expect(this.page.getByRole('dialog').getByText(/uncovered areas/i).first()).toBeVisible({ timeout: 15_000 });
    await this.page.waitForTimeout(800);
    await this.page.screenshot({ path: `${dir}/03_uncovered_areas.png` });
    await this.page.keyboard.press('Escape');
    await this.page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 10_000 }).catch(async () => {
      await this.page.getByRole('dialog').getByRole('button', { name: /close/i }).first().click().catch(() => {});
    });
  }

  /** Reads Build type / Language(s) / … from the opened "Repository details" accordion → repo-details.json */
  async saveRepoDetails(dir: string) {
    const fs = await import('fs');
    const d = await this.page.evaluate(() => {
      const labels = ['Build type', 'Language', 'Language version', 'Project type', 'Repository size', 'Files'];
      const leaves = Array.from(document.querySelectorAll('*')).filter((e) => e.children.length === 0);
      const out: Record<string, string> = {};
      for (const l of labels) {
        const el = leaves.filter((e) => (e.textContent || '').trim() === l).pop();
        if (!el) continue;
        const v = (el.nextElementSibling?.textContent || (el.parentElement?.textContent || '').replace(l, '')).trim();
        if (v) out[l] = v;
      }
      return out;
    });
    const languages = (d['Language'] || '').split(/,|&|\band\b/i).map((x) => x.trim()).filter(Boolean);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/repo-details.json`, JSON.stringify({ ...d, languages }, null, 2));
    console.log(`  Repository details: ${JSON.stringify(d)}`);
  }

  async screenshotPrScore(file: string) {
    const score = this.page.getByText(/PR Confidence/i).first();
    await score.scrollIntoViewIfNeeded().catch(() => {});
    await this.page.screenshot({ path: file, fullPage: true });
  }

  /** Step 2–3: Change repository / branch → Connect / Import repository → wait for the repo list. */
  async connectRepo() {
    // hard cap: normal retries take at most ~9 min; a browser call that never returns must not hold the whole run
    const capMs = Number(process.env.REPO_SYNC_CAP_MIN || 14) * 60_000;
    let t: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.connectRepoSteps(),
        new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`ENVIRONMENT: the repository step did not return within ${capMs / 60000} min — the browser stopped answering (frozen page or browser). This branch is marked failed and the run continues.`)), capMs); }),
      ]);
    } finally { if (t) clearTimeout(t); }
  }

  private async connectRepoSteps() {
    const repoListReady = this.page
      .getByText(/Synced \d+ repositories|Here are \d+ to start|pick one, or open View all/i)
      .or(this.page.locator('button').filter({ hasText: /^View all \d+ repositories$/ }))
      .first();
    const syncFailed = this.page.getByText(/Repository sync failed|couldn.t reach source control|Testable service issue/i).last();
    const backOnHome = this.page.getByText('Know before you deploy.');
    const open = () =>
      this.btn('Change repository / branch')
        .click()
        .then(() => this.dialog().getByRole('button', { name: 'Connect / Import repository' }).click());
    if (!(await repoListReady.isVisible().catch(() => false))) await open();
    const backoffSec = [20, 40, 60, 90, 120];
    for (let attempt = 1; attempt <= backoffSec.length + 1; attempt++) {
      const outcome = await Promise.race([
        repoListReady.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'ready' as const),
        syncFailed.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'failed' as const),
        backOnHome.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'home' as const),
      ]).catch(() => 'timeout' as const);
      if (outcome === 'ready') return;
      if (attempt === backoffSec.length + 1) {
        throw new Error(`ENVIRONMENT: repo sync did not finish after retries (last outcome: "${outcome}"). QA backend flakiness — retry later.`);
      }
      console.log(`  ⏳ repo sync attempt ${attempt} → "${outcome}"; waiting ${backoffSec[attempt - 1]}s before retry…`);
      await this.page.waitForTimeout(backoffSec[attempt - 1] * 1000);
      await open();
    }
  }

  /** Step 4: click the repo name in the list (the list may hide it behind "View all N repositories"). */
  async chooseRepo(repo: string) {
    const name = repo.split('/').pop()!.replace(/\.git$/i, '');
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // owner from "owner/name" or "https://github.com/owner/name…" — used to tell apart two repos with the same name
    const om = /^(?:https?:\/\/github\.com\/)?([^/\s]+)\/[^/\s]+/i.exec(repo.trim());
    const owner = om ? om[1] : '';
    // The repo LIST rows are buttons like "C-_Stack Public — 13 Discovered". Matching plain text is wrong: when the repo was run before,
    // its name is also printed in the "Latest White Box execution" card / header, and clicking that does nothing.
    const listRow = () => this.page.getByRole('button', { name: new RegExp(`^${esc}\\s+(Public|Private|Internal)\\b`, 'i') });
    const findRows = async () => {
      if (!(await listRow().first().isVisible({ timeout: 3_000 }).catch(() => false))) {
        const viewAll = this.page.locator('button').filter({ hasText: /^View all \d+ repositories$/ }).last();
        if (await viewAll.isVisible().catch(() => false)) await viewAll.click();
      }
      if (!(await listRow().first().isVisible({ timeout: 5_000 }).catch(() => false))) {
        // still not listed → search for it
        const search = this.page.getByRole('textbox', { name: /search all repositories/i }).last();
        if (await search.isVisible().catch(() => false)) { await search.fill(name); await this.page.waitForTimeout(1_000); }
      }
      return listRow();
    };
    let rows = await findRows();
    const n = await rows.count();
    if (n > 1) console.log(`  note: ${n} repositories in the list are named "${name}"${owner ? ` — looking for the one owned by ${owner}` : ' — using the first one'}`);
    for (let i = 0; i < Math.max(n, 1); i++) {
      const row = n > 0 ? rows.nth(i) : this.page.getByText(name, { exact: true }).last(); // old way as last resort
      await row.scrollIntoViewIfNeeded();
      await row.click();
      await expect(this.page.getByText('Configure repository').last()).toBeVisible({ timeout: 30_000 });
      if (!owner || n <= 1) return;
      // the Configure card prints "<owner>/<repo>" — is this the right one?
      const right = await this.page.getByText(new RegExp(`^\\s*${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${esc}\\s*$`, 'i')).last().isVisible({ timeout: 5_000 }).catch(() => false);
      if (right) { if (i > 0) console.log(`  repository #${i + 1} of ${n} is ${owner}/${name} — using it`); return; }
      if (i === n - 1) throw new Error(`None of the ${n} repositories named "${name}" is owned by ${owner} (the Configure card showed a different owner)`);
      const other = (await this.page.getByText(new RegExp(`^[^/\\s]+/${esc}$`)).last().innerText().catch(() => '')).trim();
      console.log(`  repository #${i + 1} of ${n} is ${other || 'another owner'}, not ${owner}/${name} — choosing another`);
      await this.page.getByRole('button', { name: 'Choose another' }).click();
      rows = await findRows();
    }
  }

  /** Step 5a: "+N branches" → search → tick the branch → Done. */
  async chooseBranch(branch: string) {
    // Verified live 29 Sep: the button is `<button>+128 branches</button>` on the Configure card.
    // (The "TRIGGERS" label is CSS-uppercased — the DOM text is "Triggers" — so don't match on it.)
    const more = this.page.getByRole('button', { name: /^\+\d+ branches?$/ }).last();
    // repos with only a few branches (e.g. 4) have no "+N branches" button — every branch is shown as a chip on the Configure card
    await more.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    if (!(await more.isVisible().catch(() => false))) {
      const nameRe = new RegExp(`^\\s*${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s+default)?\\s*$`);
      // the branches are a radio group (role "radio"); older layouts used plain buttons
      const chip = this.page.getByRole('radio', { name: nameRe }).or(this.page.getByRole('button', { name: nameRe })).last();
      await expect(chip, `branch "${branch}" is listed on the Configure card`).toBeVisible({ timeout: 15_000 });
      const already = (await chip.getAttribute('aria-checked').catch(() => null)) === 'true' || (await chip.isChecked().catch(() => false));
      if (!already) await chip.click();
      await expect(chip, `branch "${branch}" is the selected branch`).toBeChecked({ timeout: 10_000 }).catch(() => {});
      console.log(`  branch "${branch}" ${already ? 'was already selected' : 'selected'}`);
      return;
    }
    await more.click();
    const dlg = this.dialog().filter({ hasText: 'Choose a branch' });
    await expect(dlg).toBeVisible();
    await dlg.getByPlaceholder(/Search branches/i).fill(branch);
    const row = dlg.getByText(branch, { exact: true }).first();
    await expect(row, `branch ${branch} found in search`).toBeVisible({ timeout: 15_000 });
    await row.click();
    await expect(dlg.getByText(`${branch} selected`), `${branch} is the selected branch`).toBeVisible();
    await dlg.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(dlg).toBeHidden();
  }

  /** Step 5b: "On PR merge" must be ticked. Click it only if it is not ticked yet. */
  async ensurePrMergeTicked() {
    // Verified live 29 Sep: both triggers are `<button aria-pressed="true|false">`. On a fresh flow
    // "On push" starts pressed and "On PR merge" starts NOT pressed — so click only when false.
    const prMerge = this.page.getByRole('button', { name: 'On PR merge', exact: true }).last();
    await prMerge.scrollIntoViewIfNeeded();
    if ((await prMerge.getAttribute('aria-pressed')) !== 'true') {
      await prMerge.click();
    }
    await expect(prMerge, '"On PR merge" is ticked').toHaveAttribute('aria-pressed', 'true');
  }

  /** Step 6: "Confirm repository" — just click it (no "Repository ready" / branch check). */
  async confirmRepo(_branch?: string) {
    await this.btn('Confirm repository').last().click();
    await this.watchSiteError(8, 'after Confirm repository');
  }

  /** Step 7: wait for "Review branches" to finish checking (Continue turns enabled), then Continue. */
  async continueFromReview() {
    const continueBtn = this.btn('Continue').last();
    const pill = this.page.getByText(/New messages/i).last();
    const deadline = Date.now() + 5 * 60_000;
    const blockedBox = this.page.getByText(/Analysis is blocked on/i).or(this.page.getByText(/^Blocked$/)).last();
    let blockedSince = 0;
    while (Date.now() < deadline) {
      await this.failIfSiteError('Review branches');
      // the site itself says the branch can't continue (e.g. "Language version must be detected before analysis can run") → stop now, don't wait 5 min
      if (await blockedBox.isVisible().catch(() => false)) {
        blockedSince ||= Date.now();
        if (Date.now() - blockedSince > 15_000) {
          const why = (await blockedBox.locator('xpath=..').innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);
          throw new Error(`BLOCKED by the site: ${why || 'Analysis is blocked'}`);
        }
      } else blockedSince = 0;
      if ((await continueBtn.isVisible().catch(() => false)) && (await continueBtn.isEnabled().catch(() => false))) break;
      if (await pill.isVisible().catch(() => false)) await pill.click().catch(() => {});
      else await this.page.mouse.wheel(0, 2000).catch(() => {});
      await this.page.waitForTimeout(1_000);
    }
    await expect(continueBtn, '"Review branches" finished — Continue is enabled').toBeEnabled({ timeout: 5_000 });
    await continueBtn.click();
  }

  /** Step 8: "Execute run"; if the backend says "Couldn't start the run", wait and "Retry execute". */
  async executeRun() {
    const exec = this.btn('Execute run').last();
    // The run plan can take minutes to build ("Building run plan…" seen 29 Sep) — wait up to 10 min.
    const planEnd = Date.now() + 10 * 60_000;
    while (!(await exec.isVisible().catch(() => false))) {
      await this.failIfSiteError('run plan');
      if (Date.now() > planEnd) throw new Error('"Execute run" appears once the run plan is built — not visible after 10 min');
      await this.page.waitForTimeout(2_000);
    }
    await exec.click();

    const started = this.btn(/Open Confidence Engine/).or(this.page.getByText(/Executing|Running|Execution status/i)).first();
    const failed = this.page.getByText("Couldn't start the run").last();
    const waitSec = [30, 60, 120, 180, 300];
    for (let attempt = 0; attempt <= waitSec.length; attempt++) {
      const outcome = await Promise.race([
        started.waitFor({ state: 'visible', timeout: 45_000 }).then(() => 'started' as const),
        failed.waitFor({ state: 'visible', timeout: 45_000 }).then(() => 'failed' as const),
      ]).catch(() => 'unknown' as const);
      if (outcome === 'started' || outcome === 'unknown') return;
      const reason = (await failed.locator('xpath=..').innerText().catch(() => '')).replace(/\s+/g, ' ');
      if (attempt === waitSec.length) throw new Error(`ENVIRONMENT: run would not start after retries — ${reason}`);
      console.log(`  ⏳ run not started (${reason}); retrying in ${waitSec[attempt]}s…`);
      await this.page.waitForTimeout(waitSec[attempt] * 1000);
      await this.btn('Retry execute').last().click();
    }
  }

  // ---------------- Not shown by the user yet — placeholders ----------------

  /**
   * Verified live 29 Sep: the "Open Confidence Engine" button is ENABLED while the run is still
   * executing, so click it right away — the Confidence Engine page opens with runId in the URL.
   */
  async openConfidenceEngine() {
    await this.btn('Open Confidence Engine').last().click();
    await this.page.waitForURL(/\/confidence-engine\?.*runId=/, { timeout: 60_000 });
  }

  /** The "Execution Status" card on the Confidence Engine page. */
  executionCard = () =>
    // Header row of the card: nearest ancestor of the "Execution Status" label that holds an icon
    // (spinner while running, green circle-check when done). Works even when the card is collapsed
    // (seen 29 Sep: collapsed card has no "Publishing projections" text).
    this.page.getByText('Execution Status', { exact: true }).first().locator('xpath=ancestor::div[.//svg][1]');

  /**
   * Polls every 15s, no fixed cap — run time has no fixed estimate (seen live: 14m 29s).
   *
   * Verified live 29 Sep — do NOT use these, they lie: the chat heading stays "In progress" after
   * the run ends, and the "N/95 tasks" counter freezes at e.g. 80/95 even when the run is done.
   * The reliable signal is the Execution Status card's header icon: a spinner while running, a
   * green `lucide-circle-check` (plus a `lucide-check` on each of the 8 stages) once finished.
   */
  /**
   * Reads the state of the Execution Status card (header "Execution Status  2m 01s  45/54", green
   * circle-check when done). "Execution Status" also appears as a column header in the gate table,
   * so table/grid/columnheader matches are skipped and the real card is recognised by its "N/M"
   * progress counter plus an icon in the same header.
   */
  private async executionState(): Promise<{ found: boolean; done: boolean; failed: boolean; spinning?: boolean; icons?: string }> {
    return this.page.evaluate(() => {
      const leaves = Array.from(document.querySelectorAll('*')).filter(
        (e) => e.children.length === 0 && (e.textContent || '').trim() === 'Execution Status' &&
          !e.closest('table,[role="columnheader"],[role="table"],[role="grid"],thead'),
      );
      for (const l of leaves) {
        let n: Element | null = l.parentElement;
        for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
          const t = n.textContent || '';
          if (/\d+\s*\/\s*\d+/.test(t) && n.querySelector('svg')) {
            const svgs = Array.from(n.querySelectorAll('svg'));
            return {
              found: true,
              spinning: svgs.some((s) => /animate-spin|lucide-loader|lucide-refresh|lucide-rotate/.test(s.getAttribute('class') || '')),
              icons: svgs.map((s) => (s.getAttribute('class') || '').split(/\s+/).filter((c) => /^lucide-/.test(c)).join('.')).join(' | '),
              done: !!n.querySelector('svg.lucide-circle-check'),
              failed: !!n.querySelector('svg.lucide-circle-x, svg.lucide-x-circle, svg.lucide-circle-alert, svg.lucide-triangle-alert'),
            };
          }
        }
      }
      return { found: false, done: false, failed: false };
    });
  }

  /** Screenshot of the Execution Status card (header + 8 stages) like the expected evidence. */
  async screenshotExecutionStatus(file: string) {
    const handle = await this.page.evaluateHandle(() => {
      const leaves = Array.from(document.querySelectorAll('*')).filter(
        (e) => e.children.length === 0 && (e.textContent || '').trim() === 'Execution Status' &&
          !e.closest('table,[role="columnheader"],[role="table"],[role="grid"],thead'),
      );
      for (const l of leaves) {
        let n: Element | null = l.parentElement;
        let header: Element | null = null;
        for (let i = 0; i < 9 && n; i++, n = n.parentElement) {
          const t = n.textContent || '';
          if (/\d+\s*\/\s*\d+/.test(t) && n.querySelector('svg')) header = header || n;
          if (header && t.includes('Publishing projections')) return n;
        }
        if (header) return header;
      }
      return null;
    });
    const el = handle.asElement();
    if (el) {
      await el.scrollIntoViewIfNeeded();
      await el.screenshot({ path: file });
    } else {
      await this.page.screenshot({ path: file, fullPage: true });
    }
  }

  async waitForRunToFinish() {
    const doneText = this.page.getByText(/Execution finished|Run complete/i).first();
    const startedAt = Date.now();
    const limitMin = Number(process.env.RUN_TIMEOUT_MIN || 35);
    const deadline = startedAt + limitMin * 60_000;
    let check = 0; let stopped = 0;
    // Check every 30 s; stop as soon as it is done (already-analysed commits are done at once).
    while (Date.now() < deadline) {
      check++;
      await this.failIfSiteError('waiting for the run');
      const st: Awaited<ReturnType<MergeFlowPage['executionState']>> = await this.executionState().catch(() => ({ found: false, done: false, failed: false }));
      if (st.done || (await doneText.isVisible().catch(() => false))) {
        console.log(`  ✅ execution PASSED (finished) after ${Math.round((Date.now() - startedAt) / 1000)}s`);
        return;
      }
      if (st.failed) throw new Error('Run ended in a failed state (Execution Status card shows an error icon).');
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      // A run that ends with failed tasks gets no green tick. When the header spinner is gone for 3 checks in a row (90 s), the run has ended anyway → carry on.
      stopped = st.found && !st.spinning && elapsed >= 60 ? stopped + 1 : 0;
      if (stopped >= 3) {
        console.log(`  ⚠ execution ENDED without the green tick (header icon: ${st.icons || 'none'}) after ${elapsed}s — the run most likely has failed tasks; continuing with the results`);
        return;
      }
      console.log(`  ⏳ check #${check} @ ${elapsed}s — not finished yet${st.found ? ` (header icon: ${st.icons || 'none'}${st.spinning ? ', spinning' : ', not spinning'})` : ' (Execution Status card not found yet)'}`);
      await this.page.waitForTimeout(30_000);
    }
    throw new Error(`Execution did not complete within ${limitMin} minutes (no tick / "Execution finished").`);
  }

  // ---------------- UI score: walk every category → technique → sub-item ----------------
  // Structure verified live 29 Sep on the Confidence Engine page ("Gate Analysis" card):
  //   category tabs = button.border-b-2; technique chips = button.rounded-full inside a flex-nowrap row;
  //   the row's grandparent-of-parent holds [labels+techniques, sub-item chips, gate card "<Sub> Gate"];
  //   "More (N)" is a Radix dropdown (role=menuitem) that swaps the picked item into the chip row.

  private techRow = () => this.page.locator('div.flex-nowrap:has(> button.rounded-full)').first();
  private block = () => this.techRow().locator('xpath=../../..');
  private subRow = () => this.block().locator('xpath=./*[2]');
  gateCard = () => this.block().locator('xpath=./*[3]');

  private async chipNames(row: ReturnType<MergeFlowPage['techRow']>): Promise<string[]> {
    const names: string[] = [];
    const chips = row.locator('button');
    for (let i = 0; i < (await chips.count()); i++) {
      const t = ((await chips.nth(i).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (t && !/^More\b/i.test(t)) names.push(t);
    }
    const more = row.locator('button').filter({ hasText: /^More\b/i }).first();
    if (await more.isVisible().catch(() => false)) {
      await more.click();
      const items = this.page.getByRole('menuitem');
      for (let i = 0; i < (await items.count()); i++) {
        const t = ((await items.nth(i).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        if (t && !names.includes(t)) names.push(t);
      }
      await this.page.keyboard.press('Escape');
    }
    return names;
  }

  private async pick(row: ReturnType<MergeFlowPage['techRow']>, name: string) {
    const chip = row.locator('button').filter({ hasText: new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }).first();
    if (await chip.isVisible().catch(() => false)) {
      await chip.click();
    } else {
      await row.locator('button').filter({ hasText: /^More\b/i }).first().click();
      await this.page.getByRole('menuitem', { name, exact: true }).click();
    }
    await this.page.waitForTimeout(600);
  }

  /** The gate card shows spinners / an "IN PROGRESS" badge while its evidence loads — reading it then gives empty values. Wait until it has loaded. */
  private async waitGateLoaded(card: ReturnType<MergeFlowPage['gateCard']>, label: string, maxSec = 90): Promise<boolean> {
    const loading = () => card.evaluate((el) => {
      const txt = (el as HTMLElement).innerText || '';
      const spin = el.querySelector('.animate-spin, [class*="animate-spin"], [class*="spinner"], svg[class*="loader"]');
      const rows = Array.from(el.querySelectorAll('tbody tr'));
      const blank = rows.length > 0 && rows.every((tr) => !(((tr.querySelectorAll('td')[1] as HTMLElement | undefined)?.innerText || '').trim()));
      return /IN PROGRESS|LOADING/i.test(txt) || !!spin || blank;
    }).catch(() => false);
    const start = Date.now();
    while (Date.now() - start < maxSec * 1000) {
      if (!(await loading())) { if (Date.now() - start > 1500) console.log(`  gate "${label}" loaded after ${Math.round((Date.now() - start) / 1000)}s`); await this.page.waitForTimeout(400); return true; }
      await this.page.waitForTimeout(1000);
    }
    console.log(`  ⚠ gate "${label}" still loading after ${maxSec}s — will be visited again at the end`);
    return false;
  }

  /** Reads the classification table of the open gate card as text (verified live 29 Sep: real <table>, 5 <td> per row). */
  private async readGateRows(card: ReturnType<MergeFlowPage['gateCard']>): Promise<Record<string, string>[]> {
    return card.evaluate((el) => {
      const clean = (t: string | undefined) => (t || '').replace(/\s+/g, ' ').trim();
      return Array.from(el.querySelectorAll('tbody tr'))
        .map((tr) => Array.from(tr.querySelectorAll('td')))
        .filter((tds) => tds.length >= 4)
        .map((tds) => ({
          classification: clean(tds[0].textContent),
          value: clean((tds[1] as HTMLElement).innerText),
          execution: tds[2].querySelector('svg[class*="check"]') ? '✓' : clean((tds[2] as HTMLElement).innerText) || '—',
          result: clean((tds[3] as HTMLElement).innerText),
          coverage: clean((tds[4] as HTMLElement | undefined)?.innerText),
        }));
    });
  }

  /**
   * The gate card sits inside a scrolling panel (~450px high), so a plain element screenshot cuts off
   * the lower classification rows (verified live 29 Sep: card 533px, panel 448px). Unlock the panel
   * (all ancestors: height auto, overflow visible) so the document scrolls, hide the floating support
   * bubble, take the screenshot of the WHOLE card, then put everything back.
   */
  private async screenshotFullCard(card: ReturnType<MergeFlowPage['gateCard']>, file: string) {
    await card.evaluate((el) => {
      const saved: [HTMLElement, string | null][] = [];
      let n: HTMLElement | null = el.parentElement;
      while (n && n !== document.documentElement) {
        saved.push([n, n.getAttribute('style')]);
        n.style.setProperty('height', 'auto', 'important');
        n.style.setProperty('max-height', 'none', 'important');
        n.style.setProperty('min-height', '0', 'important');
        n.style.setProperty('overflow', 'visible', 'important');
        n = n.parentElement;
      }
      const html = document.documentElement;
      saved.push([html, html.getAttribute('style')]);
      html.style.setProperty('overflow', 'visible', 'important');
      const fab = Array.from(document.querySelectorAll('button')).filter((b) => /support/i.test(b.getAttribute('aria-label') || b.textContent || ''));
      fab.forEach((b) => saved.push([b as HTMLElement, b.getAttribute('style')]));
      fab.forEach((b) => (b as HTMLElement).style.setProperty('visibility', 'hidden', 'important'));
      (window as any).__restoreLayout = () => saved.forEach(([e, st]) => (st === null ? e.removeAttribute('style') : e.setAttribute('style', st)));
    });
    try {
      await this.page.waitForTimeout(300);
      await card.screenshot({ path: file });
    } finally {
      await this.page.evaluate(() => (window as any).__restoreLayout?.()).catch(() => {});
    }
  }

  /**
   * Visits every sub-item of every technique of every category and screenshots the gate card
   * ("<Sub> Gate", COMPLETED, classification table). Returns the list of saved files.
   */
  async captureUiScore(destDir: string): Promise<string[]> {
    const fs = await import('fs');
    fs.mkdirSync(destDir, { recursive: true });
    // Gate screenshots are OFF by default (only the values are read into ui-values.json). To take them again: GATE_SHOTS=on in .env (or $env:GATE_SHOTS="on").
    const shots = /^(on|1|true|yes)$/i.test((process.env.GATE_SHOTS || '').trim());
    if (!shots) console.log('  gate screenshots are OFF (default; set GATE_SHOTS=on to take them) — reading the gate values only');
    const safe = (x: string) => x.replace(/[^\w.-]+/g, ' ').trim().slice(0, 60);
    const saved: string[] = [];
    const uiRows: { category: string; technique: string; sub: string; rows: Record<string, string>[] }[] = [];
    let n = 0;
    const retry: { cat: string; tech: string; sub: string; file: string; idx: number }[] = [];
    const cats = this.page.locator('button.border-b-2');
    const catNames: string[] = [];
    for (let i = 0; i < (await cats.count()); i++) catNames.push(((await cats.nth(i).innerText()) || '').replace(/\s+/g, ' ').trim());

    for (const cat of catNames) {
      await cats.filter({ hasText: cat }).first().click();
      await this.page.waitForTimeout(800);
      const techs = await this.chipNames(this.techRow());
      for (const tech of techs) {
        await this.pick(this.techRow(), tech);
        const subs = await this.chipNames(this.subRow());
        for (const sub of subs) {
          await this.pick(this.subRow(), sub);
          const card = this.gateCard();
          await expect(card.getByText(new RegExp(`${sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*Gate`, 'i')).first(), `gate card for ${cat} › ${tech} › ${sub}`).toBeVisible({ timeout: 20_000 });
          const techDir = `${destDir}/${safe(tech)}`;
          if (shots) fs.mkdirSync(techDir, { recursive: true });
          let file = `${techDir}/${safe(sub)}.png`;
          if (shots && fs.existsSync(file)) file = `${techDir}/${safe(sub)}__${safe(cat)}.png`;
          n++;
          const loaded = await this.waitGateLoaded(card, `${tech} › ${sub}`);
          if (shots) await this.screenshotFullCard(card, file);
          if (!loaded) retry.push({ cat, tech, sub, file, idx: uiRows.length });
          uiRows.push({ category: cat, technique: tech, sub, rows: await this.readGateRows(card) });
          saved.push(file);
        }
      }
    }
    // gates that were still loading when first visited (the evidence keeps loading while we move on): visit them again, now with a long wait
    for (const r of retry) {
      try {
        await cats.filter({ hasText: r.cat }).first().click();
        await this.page.waitForTimeout(800);
        await this.pick(this.techRow(), r.tech);
        await this.pick(this.subRow(), r.sub);
        const card = this.gateCard();
        await expect(card.getByText(new RegExp(`${r.sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*Gate`, 'i')).first()).toBeVisible({ timeout: 20_000 });
        const ok = await this.waitGateLoaded(card, `${r.tech} › ${r.sub} (2nd visit)`, 240);
        if (shots) await this.screenshotFullCard(card, r.file);
        uiRows[r.idx].rows = await this.readGateRows(card);
        console.log(`  re-read "${r.tech} › ${r.sub}": ${ok ? 'loaded' : 'still not loaded'}`);
      } catch (e) { console.log(`  could not re-read "${r.tech} › ${r.sub}": ${e instanceof Error ? e.message.split('\n')[0] : e}`); }
    }
    fs.writeFileSync(`${destDir}/../ui-values.json`, JSON.stringify(uiRows, null, 2));
    console.log(`  UI score: ${shots ? `${saved.length} gate screenshots + ` : `${saved.length} gates read (no screenshots) → `}ui-values.json (${uiRows.reduce((a, g) => a + g.rows.length, 0)} classification rows read from the page)${shots ? ` saved under ${destDir}` : ''}`);
    return saved;
  }

  /** The download icon in the "Gate Analysis" header (aria-label "Download full taxonomy gate report"). */
  async downloadTaxonomyReport(destDir: string): Promise<string> {
    const button = this.page.locator('button[aria-label*="taxonomy" i]:has(svg.lucide-download), button:has(svg.lucide-download)').first();
    // the button stays disabled ("Available after gate evidence loads and the run snapshot is exportable") for a while after the run finishes — wait for it, reloading now and then
    const deadline = Date.now() + 6 * 60_000;
    let waited = 0;
    while (Date.now() < deadline) {
      if ((await button.isVisible().catch(() => false)) && (await button.isEnabled().catch(() => false))) break;
      await this.page.waitForTimeout(10_000); waited += 10;
      if (waited % 90 === 0) { console.log(`  ⏳ taxonomy download not ready after ${waited}s — reloading the page`); await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); }
    }
    if (waited) console.log(`  taxonomy download button ready after ~${waited}s`);
    await button.scrollIntoViewIfNeeded();
    const downloadPromise = this.page.waitForEvent('download', { timeout: 60_000 });
    await button.click();
    const download = await downloadPromise;
    const savePath = `${destDir}/${download.suggestedFilename()}`;
    await download.saveAs(savePath);
    return savePath;
  }

  /** Verified live 29 Sep: sidebar "Sign out" button → confirm dialog (Cancel / Sign out). */
  async logout() {
    await this.page.getByRole('button', { name: 'Sign out', exact: true }).first().click();
    await this.page.getByRole('alertdialog').getByRole('button', { name: 'Sign out', exact: true }).click();
    await this.page.waitForURL((u) => !/execution-assistant|dashboard|confidence-engine|account/.test(u.pathname), { timeout: 30_000 }).catch(() => {});
  }
}
