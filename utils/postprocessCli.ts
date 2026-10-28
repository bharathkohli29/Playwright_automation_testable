// Run the post-processing of ONE finished branch again (S3 check, bug drafts, SharePoint copy, Teams message), e.g. after a network problem:
//   npm run post -- "results\merge-flow_2026-10-28_1156\JV_V12_GRADLEGROOVYDSL_THINJAR_MONO" --repo VISVANTHA/Java_Corpus_Tool_Triggering
import * as fs from 'fs';
import * as path from 'path';
import { runPostProcess } from './postprocess';

(async () => {
  const args = process.argv.slice(2);
  const ri = args.indexOf('--repo');
  const repoArg = ri >= 0 ? args.splice(ri, 2)[1] : '';
  const dir = path.resolve(args[0] || '');
  if (!args[0] || !fs.existsSync(path.join(dir, 'run-details.json'))) {
    console.log('Usage: npm run post -- "<results\\...\\branch folder>" [--repo owner/name]   (the folder must contain run-details.json)');
    process.exit(1);
  }
  const rd = JSON.parse(fs.readFileSync(path.join(dir, 'run-details.json'), 'utf8'));
  let repo = repoArg;
  if (!repo) { try { repo = JSON.parse(fs.readFileSync(path.join(dir, 's3-check.json'), 'utf8')).repo || ''; } catch { /* none */ } }
  const ok = await runPostProcess({ branchDir: dir, branch: rd.branch_name || path.basename(dir), repo });
  process.exit(ok ? 0 : 1);
})();
