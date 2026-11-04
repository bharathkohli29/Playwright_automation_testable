import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** a branch folder with an eks-live capture and a Python 3.12 S3 check: radon fine, pip-audit and cosmic-ray failed with a known cause */
export function makeBranch(name = 'PY_SECRET_BRANCH') {
  const pods = [
    { tool: 'radon', phase: 'Succeeded', exit: 0, lines: ['done'] },
    { tool: 'pip-audit', phase: 'Failed', exit: 1, lines: ['Failed to upgrade `pip`'] },
    { tool: 'cosmic-ray', phase: 'Failed', exit: 2, lines: ["Error: No such option '--force'."] },
  ];
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rcafix-')); const live = path.join(d, 'eks-live'); fs.mkdirSync(live, { recursive: true });
  const recs = pods.map((p, i) => { const rel = `pods/p${i}/console.log`; fs.mkdirSync(path.join(live, 'pods', `p${i}`), { recursive: true }); fs.writeFileSync(path.join(live, rel), p.lines.join('\n'));
    return { tool: p.tool, task: `t${i}`, pod: `wb-exec-${i}`, phase: p.phase, exit_code: p.exit, reason: p.phase === 'Failed' ? 'Error' : 'Completed', command: `${p.tool} run`, console_file: rel }; });
  fs.writeFileSync(path.join(live, 'tools.json'), JSON.stringify(recs)); fs.writeFileSync(path.join(live, 'services.log'), '');
  fs.writeFileSync(path.join(live, 'tool-status.json'), JSON.stringify(Object.fromEntries(pods.map((p) => [p.tool, p.phase === 'Failed' ? 'FAILED' : 'PASSED']))));
  fs.writeFileSync(path.join(live, 'summary.json'), JSON.stringify({ run_id: 'abcdef12-0000', branch: name }));
  fs.writeFileSync(path.join(d, 's3-check.json'), JSON.stringify({ run_id: 'abcdef12-0000', branch: name, python: { version: '3.12', defects: [], tools: [] }, checks: [] }));
  return d;
}
