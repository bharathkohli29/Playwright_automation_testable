import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { eksEnv } from './eksAnalyze';
import { redact } from './eksCollector';
import { liveEvidence, liveDiagnosis } from './eksDiagnose';

/**
 * Re-checks a FINISHED run:   npm run eks:history -- "results\<round>\<branch folder>"
 *  1. if the cluster is reachable it reads what the cell services still hold about this run (their logs live as long as the pod; the tool pods
 *     themselves are already gone) and saves the lines to <branch folder>\eks-live\services.log
 *  2. for every tool the S3 check marked FAIL / EMPTY it gathers the real evidence (the tool's failure.json from S3, those service lines) and answers it with
 *     the rules of eksPatterns.ts, exactly like the bug drafts do
 *  3. prints the result and writes <branch folder>\eks-live\diagnosis-history.md
 * Read-only. Never changes the branch's reports.
 */
const clean = (s?: string) => (s || '').trim().replace(/^["']|["']$/g, '');
const CTX = 'qa-eks-ro';
const kc = (args: string[], t = 60_000): Promise<{ code: number; out: string }> => new Promise((res) => {
  try { execFile(clean(process.env.EKS_KUBECTL) || 'kubectl', ['--context', CTX, ...args], { env: eksEnv(), timeout: t, windowsHide: true, maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32' }, (e, so, se) => res({ code: e ? 1 : 0, out: `${so || ''}${e ? se || '' : ''}` })); } catch { res({ code: 127, out: '' }); }
});

async function main() {
  const dir = path.resolve(process.argv[2] || '');
  const s3p = path.join(dir, 's3-check.json');
  if (!process.argv[2] || !fs.existsSync(s3p)) { console.log('Usage: npm run eks:history -- "results\\<round>\\<branch folder>"   (the folder must hold s3-check.json)'); process.exit(1); }
  const s3 = JSON.parse(fs.readFileSync(s3p, 'utf8')); const runId: string = s3.run_id; const short = runId.split('-')[0];
  const live = path.join(dir, 'eks-live'); fs.mkdirSync(live, { recursive: true });
  console.log(`\nRe-checking ${s3.branch} · run ${short} · ${(s3.languages || []).join(', ')}\n`);

  // 1. what the cluster still knows
  const ns = await kc(['get', 'ns', '-o', 'name', '--request-timeout=15s'], 30_000);
  if (ns.code !== 0) console.log('  cluster: not reachable (sign in with aws sso login --profile qa-eks-ro, or the cluster was removed) — using the saved S3 evidence only');
  else {
    let lines = 0; const out: string[] = [];
    for (const n of ns.out.split(/\r?\n/).map((x) => x.replace(/^namespace\//, '').trim()).filter((x) => /cell-\d+$/.test(x) || x === 'testable-qa-global')) {
      const pods = await kc(['get', 'pods', '-n', n, '-o', 'name', '--request-timeout=15s'], 30_000);
      for (const p of pods.out.split(/\r?\n/).map((x) => x.trim()).filter((x) => /orchestrator|execution-control|runtime-api|cpu-worker|io-worker|scoring-worker|admission|control-plane|runtime-reconciler/i.test(x))) {
        const r = await kc(['logs', '-n', n, p, '--timestamps', `--since=${process.env.EKS_HISTORY_SINCE || '96h'}`, '--all-containers=true'], 120_000);
        for (const l of r.out.split(/\r?\n/)) if (l.includes(runId) || l.includes(short)) { out.push(`[${p.replace(/^pod\//, '')}] ${redact(l)}`); lines++; }
      }
    }
    fs.writeFileSync(path.join(live, 'services.log'), out.join('\n') + (out.length ? '\n' : ''));
    console.log(`  cluster: ${lines} service log line(s) about this run still available${lines ? '' : ' (the pods were restarted or the cluster was rebuilt since)'}`);
  }

  // 2. defective tools from the S3 check
  const rows: any[] = (s3.checks || []).filter((r: any) => r.result !== 'PASS');
  const tools = [...new Set(rows.flatMap((r) => String(r.tool).split(/\s*\+\s*/)))];
  const md: string[] = [`# Root cause re-check — ${s3.branch} (run ${short})`, ''];
  let n = 0;
  for (const tool of tools) {
    const note = rows.filter((r) => String(r.tool).split(/\s*\+\s*/).includes(tool)).map((r) => r.note).join(' | ').slice(0, 200);
    const ev = liveEvidence(dir, tool);
    if (!ev) continue;
    n++;
    const d = await liveDiagnosis(tool, runId, dir, { observed: note });
    const block = [`## ${tool}`, `Observed: ${note}`, `Verdict: ${d?.verdict || '-'}`, `Root cause: ${d?.rootCause || '-'}`, `Owner: ${d?.owner || '-'}`, `Fix: ${d?.suggestedFix || '-'}`, `Evidence lines (${ev.sources.join(', ')}):`, ...ev.lines.map((l) => `  - ${l}`), ''];
    md.push(...block); console.log(block.join('\n'));
  }
  if (!n) { const m = 'No tool had log evidence to explain (no failure.json in the S3 evidence and no service lines). Nothing was guessed.'; md.push(m); console.log(m); }
  fs.writeFileSync(path.join(live, 'diagnosis-history.md'), md.join('\n'));
  console.log(`\nSaved: ${path.join(live, 'diagnosis-history.md')}`);
}
main().catch((e) => console.log(`eks:history stopped: ${e instanceof Error ? e.message : e}`)).finally(() => process.exit(0));
