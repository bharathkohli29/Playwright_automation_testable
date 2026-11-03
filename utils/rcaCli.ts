import * as fs from 'fs';
import * as path from 'path';
import './env'; // loads .env
import { writeReports, RCA_DIR } from './rcaReport';
import { rcaModelEnabled, writeReport } from './rcaWriter';

/**
 * npm run rca -- "<branch folder>" [tool ...]   one RCA report per defective tool, written to <branch folder>/RCA Report/ (reads only).
 * The local model rewords (RCA_MODEL=off in .env switches it off) each report in plain English (rcaWriter.ts); off or any problem: the rule-written report.
 */
const [dir, ...tools] = process.argv.slice(2);
if (!dir || !fs.existsSync(dir)) { console.log('Usage: npm run rca -- "<branch folder with eks-live/ and, if available, s3-check.json>" [tool ...]'); process.exit(1); }
(async () => {
  const on = rcaModelEnabled();
  const rows = await writeReports(path.resolve(dir), tools, on ? writeReport : undefined);
  console.log(`${rows.length} report(s) in ${path.join(path.resolve(dir), RCA_DIR)}  (wording: ${on ? 'local model, rules as fallback' : 'rules; RCA_MODEL=off is set'})`);
  for (const r of rows) console.log(`  ${r.tone === 'green' ? 'GREEN' : 'RED  '} ${r.tool.padEnd(26)} ${r.state.padEnd(42)} ${r.source.padEnd(6)} ${(r.rule || '(no known pattern)').padEnd(34)}${r.ms ? ` ${(r.ms / 1000).toFixed(1)}s` : ''}${r.note ? `  ← ${r.note}` : ''}`);
})();
