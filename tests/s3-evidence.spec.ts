import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { S3Reader } from '../utils/awsS3';
import { checkBranchS3 } from '../utils/s3Evidence';
import { loadBuilds } from '../utils/builds';

/**
 * For every branch folder of a results run that has run-details.json:
 *   qa-bucket-us2 / development / cell-001 / tenant / project / repository / branch_id / branch_name / commit_sha / run_id / <tool> / … / *.json
 * Languages come from the coverage preview (repo-details.json → "Language": C#, JavaScript, TypeScript).
 * For each language and technique the primary tool's folder is opened and its json files are read:
 *   PASS  = triggered, has data      EMPTY = triggered but empty ({} / 0)      FAIL = not triggered (no folder / no json)
 * When two languages share a tool folder (eslint-security, lizard, pydriller …) the file names inside the json
 * (.js / .ts / .py / .cs) decide which language the run was for.
 * Writes  <branch folder>/s3-evidence/…  and  <branch folder>/s3-check.json
 *
 * Results folder: S3_RESULTS_DIR, else the newest results/merge-flow_*.   Languages: LANGUAGE="javascript,typescript" overrides the coverage preview.
 */
const hasDetails = (d: string) => fs.existsSync(d) && fs.readdirSync(d).some((b) => fs.existsSync(path.join(d, b, 'run-details.json')));

/** The results folder to check. If the site test of THIS run has started (its folder exists), wait until it has written run-details.json. */
async function resultsDir(): Promise<string> {
  if (process.env.S3_RESULTS_DIR) return process.env.S3_RESULTS_DIR;
  const current = process.env.RUN_DIR;
  if (current && fs.existsSync(current) && !hasDetails(current)) {
    console.log(`  Waiting for the site run to finish (needs run-details.json in ${current}) …`);
    const until = Date.now() + 50 * 60_000;
    const planned = (() => { try { return (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'builds.json'), 'utf8')).branches || []).length; } catch { return 1; } })();
    const finished = () => { try { return JSON.parse(fs.readFileSync(path.join(current, 'summary.json'), 'utf8')).length >= planned; } catch { return false; } };
    while (Date.now() < until && !hasDetails(current) && !finished()) await new Promise((r) => setTimeout(r, 15_000));
  }
  if (current && hasDetails(current)) return current;
  const root = path.join(__dirname, '..', 'results');
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => /^merge-flow_/.test(d) && hasDetails(path.join(root, d))) : [];
  if (!dirs.length) throw new Error('No results folder with run-details.json found. Run the site test (flow) first and let it finish — run-details.json is written by it — or set S3_RESULTS_DIR.');
  return path.join(root, dirs.sort().pop()!);
}
test('S3 evidence — tool folders per language and technique', async () => {
  test.setTimeout(120 * 60_000);
  const dir = await resultsDir();
  const branches = fs.readdirSync(dir).filter((b) => fs.existsSync(path.join(dir, b, 'run-details.json')));
  console.log(`  Results: ${dir}\n  Branches: ${branches.join(', ')}`);
  const s3 = new S3Reader();
  for (const b of branches) {
    const bd = path.join(dir, b);
    // the site test already checked S3 right after this branch finished — only redo when asked
    const done = path.join(bd, 's3-check.json');
    if (fs.existsSync(done) && !process.env.S3_FORCE) {
      const same = JSON.parse(fs.readFileSync(path.join(bd, 'run-details.json'), 'utf8')).run_id === JSON.parse(fs.readFileSync(done, 'utf8')).run_id;
      if (same) { console.log(`  ${b}: S3 already checked during the site run (set S3_FORCE=1 to redo)`); continue; }
    }
    const repoOf = (() => { try { return loadBuilds().find((x) => x.dir === b)?.repo; } catch { return undefined; } })();
    await checkBranchS3(bd, s3, repoOf);
  }
});
