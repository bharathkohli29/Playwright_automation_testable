import { defineConfig } from '@playwright/test';
import * as path from 'path';
import { TEST_ENV, baseUrl, authFile } from './utils/env'; // also loads .env (override: true)

if (!process.env.RUN_DIR) {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  process.env.RUN_DIR = path.join(__dirname, 'results', `merge-flow_${TEST_ENV === 'dev' ? 'dev_' : ''}${stamp}`);
}
const RUN_TIMEOUT_MIN = Number(process.env.RUN_TIMEOUT_MIN || 35);

export default defineConfig({
  testDir: './tests',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: (RUN_TIMEOUT_MIN + 5) * 60_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: baseUrl,
    browserName: 'chromium',
    headless: process.env.HEADLESS === '1',
    viewport: null,
    // --force-device-scale-factor ignores the Windows display scaling (125% / 150%), so the page is not "zoomed" and screenshots show the normal layout.
    // Change it with $env:PAGE_SCALE="0.9" (default 1; lower shows more of the page).
    launchOptions: { args: ['--start-maximized', `--force-device-scale-factor=${process.env.PAGE_SCALE || '1'}`, ...(process.env.HEADLESS === '1' ? ['--window-size=1920,1080'] : [])] },
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'flow',
      testMatch: /merge-flow\.spec\.ts/,
      dependencies: ['setup'],
      use: { storageState: authFile },
    },
    // third part: runs only after setup and flow have PASSED (it needs the run-details.json that flow writes).
    // To re-check S3 for an old results folder without running flow again:  npx playwright test --project=s3 --no-deps
    { name: 's3', testMatch: /s3-evidence\.spec\.ts/, dependencies: ['flow'] },
  ],
});
