import type { Page, TestType } from '@playwright/test';
import { capturePass, captureFail, consumeManual, snap as snapEvidence } from './evidence';

/**
 * Wraps each step as a test.step, records Pass/Fail evidence for it, and (unless critical)
 * keeps going so one broken step doesn't stop the rest of the flow. Call finish() at the end —
 * it throws if anything failed, so the run is still reported red, but every step still got a
 * chance to run and be recorded.
 */
export class CaseRunner {
  private failures: string[] = [];
  constructor(private test: TestType<any, any>, private page: Page) {}

  async run(id: string, title: string, fn: () => Promise<void>, opts: { critical?: boolean } = {}) {
    await this.test.step(`[${id}] ${title}`, async () => {
      try {
        await fn();
        if (!consumeManual(id)) await capturePass(this.page, id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await captureFail(this.page, id, msg);
        this.failures.push(`[${id}] ${msg}`);
        if (opts.critical) throw e;
      }
    });
  }

  async snap(id: string) {
    await snapEvidence(this.page, id);
  }

  finish() {
    if (this.failures.length) {
      throw new Error(`${this.failures.length} case(s) failed:\n` + this.failures.join('\n'));
    }
  }
}
