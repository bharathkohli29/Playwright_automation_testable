import * as fs from 'fs';
import * as path from 'path';
import type { Page } from '@playwright/test';

export function runDir(): string {
  const dir = process.env.RUN_DIR || path.join(process.cwd(), 'results', 'latest');
  fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  return dir;
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, '_');

function record(entry: Record<string, unknown>) {
  fs.appendFileSync(path.join(runDir(), 'evidence.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

export async function capturePass(page: Page | undefined, id: string, url?: string) {
  if (!page || page.isClosed()) return record({ id, status: 'Pass' });
  const file = path.join(runDir(), 'evidence', `${safe(id)}_PASS.png`);
  await page.screenshot({ path: file, fullPage: true, timeout: 10_000 }).catch(() => {});
  record({ id, status: 'Pass', file, url: url ?? page.url() });
}

const manualIds = new Set<string>();

export async function snap(page: Page | undefined, id: string) {
  await capturePass(page, id);
  manualIds.add(id);
}

export function consumeManual(id: string): boolean {
  const had = manualIds.has(id);
  manualIds.delete(id);
  return had;
}

export async function captureFail(page: Page | undefined, id: string, error: string) {
  const ev = path.join(runDir(), 'evidence');
  const pageFile = path.join(ev, `${safe(id)}_FAIL.png`);
  let url = '';
  if (page && !page.isClosed()) {
    url = page.url();
    await page.screenshot({ path: pageFile, fullPage: true, timeout: 10_000 }).catch(() => {});
  }
  record({ id, status: 'Fail', file: pageFile, url, error: error.slice(0, 500) });
}

export function recordSkip(id: string, status: 'Blocked' | 'Not Run', reason: string) {
  record({ id, status, reason });
}

export const safeBranch = (b: string) => b.replace(/[\\/:*?"<>|]+/g, '__');

/** results/<run>/<branch>/ — everything for one branch lives here. */
export function branchDir(branch: string, ...sub: string[]): string {
  const d = path.join(runDir(), safeBranch(branch), ...sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Collects every 4xx/5xx response and failed request (the "network tab" for a bug report). */
export function watchNetwork(page: Page) {
  const bad: Record<string, unknown>[] = [];
  page.on('response', async (r) => {
    if (r.status() >= 400) {
      let body = '';
      try { body = (await r.text()).slice(0, 2000); } catch { /* ignore */ }
      bad.push({ at: new Date().toISOString(), method: r.request().method(), url: r.url(), status: r.status(), body });
    }
  });
  page.on('requestfailed', (r) => bad.push({ at: new Date().toISOString(), url: r.url(), failure: r.failure()?.errorText }));
  return bad;
}

export function addSummary(entry: Record<string, unknown>) {
  const f = path.join(runDir(), 'summary.json');
  let all: unknown[] = [];
  try { all = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* first entry */ }
  all.push(entry);
  fs.writeFileSync(f, JSON.stringify(all, null, 2));
}
