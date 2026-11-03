import * as fs from 'fs';
import * as path from 'path';
import { buildRunReport, type ToolStatus } from './eksReport';
import { liveDiagnosis } from './eksDiagnose';
import type { EksAiDiagnosis } from './eksMentor';

/**
 * Root causes for a run whose S3 check FAILED (expired AWS keys, no S3 access) but whose live QA EKS capture (<branch folder>/eks-live) exists.
 * The tools that did not pass are taken from the EKS records only (pod states, orchestrator lines, planned tools); every one gets the same
 * answer path as the bug drafts: known pattern -> Ollama model -> quoted-line check (liveDiagnosis). Written to <branch folder>/eks-rca/
 *   RCA_<tool>.md · eks_rca_summary.md · eks_rca.json
 * and returned as short lines for the Teams card. Never throws; returns null when there is no eks-live of this run.
 */
const BAD: ToolStatus[] = ['FAILED', 'EMPTY_OUTPUT', 'STUCK_WAITING', 'NEVER_DISPATCHED'];
const safe = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 80);
const one = (s?: string, n = 400) => (s || '-').replace(/\s+/g, ' ').trim().slice(0, n);

/** tool -> status for every tool a WARNING / ERROR service line names as rejected, blocked or failed (tool_name=... in the JSON of the line) */
export function serviceProblems(file: string): Map<string, string> {
  const out = new Map<string, string>();
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const l of text.split(/\r?\n/)) {
    const i = l.indexOf('{'); if (i < 0) continue;
    let j: any; try { j = JSON.parse(l.slice(i)); } catch { continue; }
    const tool = String(j.tool_name || ''); const msg = String(j.message || '');
    if (!tool || !/^(WARNING|ERROR|CRITICAL)$/i.test(String(j.level || ''))) continue;
    if (/rejected|blocked/i.test(msg)) { if (!out.has(tool)) out.set(tool, 'NEVER_DISPATCHED'); }
    else if (/failed/i.test(msg)) out.set(tool, 'FAILED');
  }
  return out;
}

export interface EksOnlyResult { tools: number; lines: string[]; dir: string }

export async function writeEksOnlyRca(branchDir: string, why = 'S3 check not available'): Promise<EksOnlyResult | null> {
  try {
    const live = path.join(branchDir, 'eks-live'); const sf = path.join(live, 'summary.json');
    if (!fs.existsSync(sf)) return null;
    const summary = JSON.parse(fs.readFileSync(sf, 'utf8')); const runId = String(summary.run_id || '');
    const rd = (() => { try { return JSON.parse(fs.readFileSync(path.join(branchDir, 'run-details.json'), 'utf8')); } catch { return {}; } })();
    if (!runId || (rd.run_id && rd.run_id !== runId)) return null; // not the capture of this run
    const rep = buildRunReport(branchDir); if (!rep) return null;
    const rec = (t: string) => { try { return JSON.parse(fs.readFileSync(path.join(live, 'tools', safe(t), 'record.json'), 'utf8')); } catch { return null; } };
    const bad: { tool: string; status: string }[] = Object.entries(rep.statuses).filter(([, s]) => BAD.includes(s)).map(([t, s]) => ({ tool: t, status: s }));
    // Without S3 a tool that was never started has no pod and no result row, so it cannot be told apart from one that ran on a standing worker.
    // The orchestrator and the workers say it themselves, though: a service line that names the tool and says rejected / blocked / failed.
    const seen = new Set(bad.map((b) => b.tool.toLowerCase()));
    for (const [tool, status] of serviceProblems(path.join(live, 'services.log'))) if (!seen.has(tool.toLowerCase())) { seen.add(tool.toLowerCase()); bad.push({ tool, status }); }
    const out = path.join(branchDir, 'eks-rca'); fs.mkdirSync(out, { recursive: true });
    console.log(`  QA EKS (no S3): ${bad.length} tool(s) did not pass in the live capture, writing the root causes ...`);
    const rows: { tool: string; status: string; d: EksAiDiagnosis | null }[] = [];
    for (const b of bad) {
      const r = rec(b.tool);
      const d = await liveDiagnosis(b.tool, runId, branchDir, { observed: `${b.status}: ${r?.whyFailed || ''}`, note: why });
      rows.push({ tool: b.tool, status: b.status, d });
      fs.writeFileSync(path.join(out, `RCA_${safe(b.tool)}.md`), [
        `# ${b.tool} — ${b.status}`, '', `Run ${runId} · branch ${summary.branch || rd.branch_name || ''}`, `S3: ${why}; this analysis uses the live QA EKS capture only.`, '',
        `Verdict: ${one(d?.verdict)}`, `Summary: ${one(d?.summary)}`, `Root cause: ${one(d?.rootCause, 900)}`, `Evidence (log line captured from the pod): ${one(d?.evidence, 600)}`,
        `Owner: ${one(d?.owner)}`, `Action: ${one(d?.suggestedFix || d?.action)}`, d?.acceptance ? `Acceptance: ${one(d.acceptance)}` : '', '',
        `Observed by the collector: ${one(r?.whyFailed, 600)}`].filter((x) => x !== '').join('\n') + '\n');
    }
    const counts: Record<string, number> = {}; for (const s of Object.values(rep.statuses)) counts[s] = (counts[s] || 0) + 1;
    const md = ['# Root causes from the live QA EKS capture (S3 not available)', '', `Branch: ${summary.branch || rd.branch_name || ''}`, `Run: ${runId}`, `Reason S3 is missing: ${why}`, '',
      `Tools by status: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`, '', `## Tools that did not pass (${rows.length})`,
      ...rows.map((r) => `- **${r.tool}** (${r.status}) — ${one(r.d?.verdict, 90)}: ${one(r.d?.rootCause, 260)} Owner: ${one(r.d?.owner, 80)}`), '',
      '_Details per tool: RCA_<tool>.md. These results do not include the S3 tool results; run npm run post again with valid AWS keys for the full report._'];
    fs.writeFileSync(path.join(out, 'eks_rca_summary.md'), md.join('\n') + '\n');
    fs.writeFileSync(path.join(out, 'eks_rca.json'), JSON.stringify({ run_id: runId, why, tools: rows }, null, 2));
    const lines = rows.map((r) => `${r.tool}: ${one(r.d?.rootCause || r.d?.summary, 150)}${r.d?.verdict ? ` [${one(r.d.verdict, 28).replace(/\s*\(.*$/, '')}]` : ''}`);
    console.log(`  QA EKS (no S3): root causes for ${rows.length} tool(s) written to ${out}`);
    return { tools: rows.length, lines, dir: out };
  } catch (e) { console.log(`  QA EKS (no S3): not written (${e instanceof Error ? e.message : e})`); return null; }
}
