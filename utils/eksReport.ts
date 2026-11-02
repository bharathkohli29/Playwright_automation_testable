import * as fs from 'fs';
import * as path from 'path';
import { matchToolPattern } from './eksPatterns';

/**
 * Turns what the live collector saved (eks-live/) + the S3 check into ONE record per tool of the run, with a status and the reason:
 *   PASSED · FAILED · EMPTY_OUTPUT (pod ok, result empty) · NEVER_DISPATCHED · STUCK_WAITING (run-level cause, see run-diagnosis.json) · UNKNOWN
 * Writes in <branch folder>/eks-live/ :  run_summary.md · tools.csv · tool-status.json · tools/<tool>/record.md + record.json
 * Never throws. Nothing here calls the model: patterns are rules (eksPatterns.ts).
 */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const rj = (p: string): any => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const rt = (p: string): string => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const csv = (v: unknown) => { const s = String(v ?? '').replace(/\r?\n/g, ' '); return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const ist = (d?: string | number) => { if (!d) return ''; try { return new Date(d).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }).replace(',', '') + ' IST'; } catch { return String(d); } };
const safe = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 80);

export type ToolStatus = 'PASSED' | 'FAILED' | 'EMPTY_OUTPUT' | 'NEVER_DISPATCHED' | 'STUCK_WAITING' | 'UNKNOWN';
export interface ToolRecord {
  tool: string; status: ToolStatus; runtime: string; pods: any[]; s3: { result: string; note: string }[]; failure: string;
  pattern?: { id: string; title: string; rootCause: string; owner: string; fix: string };
  whyPassed: string; whyFailed: string; missing: string[];
}

function failureTexts(branchDir: string, tool: string): string[] {
  const out: string[] = []; const root = path.join(branchDir, 's3-evidence');
  const walk = (d: string, k: number) => { if (k > 5) return; let es: fs.Dirent[] = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, k + 1); else if (e.name === 'failure.json') { const rel = path.relative(root, p).split(path.sep)[0]; if (norm(rel) === norm(tool)) { const j = rj(p); if (j) out.push([j.error_code, j.status, j.reason || j.error].filter(Boolean).join(' · ')); } } } };
  walk(root, 0); return out;
}

export function buildRunReport(branchDir: string): { statuses: Record<string, ToolStatus>; counts: Record<string, number> } | null {
  try {
    const live = path.join(branchDir, 'eks-live'); if (!fs.existsSync(live)) return null;
    const summary = rj(path.join(live, 'summary.json')) || {}; const pods: any[] = rj(path.join(live, 'tools.json')) || [];
    const diag = rj(path.join(live, 'run-diagnosis.json')); const s3 = rj(path.join(branchDir, 's3-check.json'));
    const checks: any[] = Array.isArray(s3?.checks) ? s3.checks : [];
    const planned: Record<string, string> = summary.planned_tools || {}; // tool -> runtime, from the orchestrator log
    const names = new Map<string, string>();
    const add = (t: string) => { const n = norm(t); if (n && !names.has(n)) names.set(n, t); };
    for (const c of checks) String(c.tool).split(/\s*\+\s*/).forEach(add);
    for (const p of pods) add(p.tool); for (const t of Object.keys(planned)) add(t);
    const stuck = !!diag && diag.id === 'runtime-unavailable-heartbeat-loop';
    const recs: ToolRecord[] = [];
    for (const [n, tool] of names) {
      const myPods = pods.filter((p) => norm(p.tool) === n);
      const rows = checks.filter((c) => String(c.tool).split(/\s*\+\s*/).some((x) => norm(x) === n)).map((c) => ({ result: String(c.result), note: String(c.note || '') }));
      const fail = failureTexts(branchDir, tool).join(' | ');
      const podFailed = myPods.some((p) => p.phase === 'Failed' || (p.exit_code != null && p.exit_code !== 0) || /OOMKilled|Evicted|ImagePull|ErrImage|CrashLoop/i.test(p.reason || ''));
      const podOk = myPods.some((p) => p.phase === 'Succeeded' && (p.exit_code == null || p.exit_code === 0));
      const anyPass = rows.some((r) => r.result === 'PASS'); const allNot = rows.length > 0 && rows.every((r) => r.result !== 'PASS' && /not triggered|primary tool N\/A/i.test(r.note));
      let status: ToolStatus = 'UNKNOWN';
      if (podFailed) status = 'FAILED';
      else if (podOk) status = rows.length && !anyPass && rows.every((r) => /empty/i.test(r.note) || r.result === 'EMPTY') ? 'EMPTY_OUTPUT' : 'PASSED';
      else if (anyPass) status = 'PASSED';
      else if (fail || rows.some((r) => /triggered but empty|failed/i.test(r.note))) status = 'FAILED';
      else if (stuck && (allNot || rows.length === 0)) status = 'STUCK_WAITING';
      else if (allNot || (rows.length === 0 && planned[tool])) status = 'NEVER_DISPATCHED';
      // console tail of the pod(s)
      let tail = ''; for (const p of myPods) if (p.console_file) tail += '\n' + rt(path.join(live, p.console_file)).split(/\r?\n/).slice(-60).join('\n');
      const pat = status === 'FAILED' || status === 'EMPTY_OUTPUT' ? matchToolPattern({ tool, text: `${fail}\n${rows.map((r) => r.note).join('\n')}\n${tail}`, podReason: myPods.map((p) => `${p.reason || ''} ${p.message || ''}`).join(' '), exitCode: myPods.find((p) => p.exit_code != null)?.exit_code ?? null }) : null;
      const ev = summary.task_events?.[tool]; const missing: string[] = [];
      if (!myPods.length) missing.push(status === 'PASSED' ? 'no tool pod was seen by the collector (it may have run on a standing worker, or finished between two polls)' : 'no tool pod was ever started for this tool');
      for (const p of myPods) if (!p.console_lines) missing.push(`pod ${p.pod}: no console output was captured`);
      if (!rows.length) missing.push('no S3 result row for this tool'); else if (allNot) missing.push('no S3 result folder for this tool');
      if (status === 'UNKNOWN') missing.push(ev?.last ? `no tool pod and no S3 row; last orchestrator line for this task: ${ev.last}` : 'no tool pod and no S3 row; the tool may have run on a standing worker (see services.log) or never started');
      if (status === 'FAILED' && !fail && !tail.trim()) missing.push('no failure.json and no console log: the cause cannot be shown from the data');
      const first = myPods[0];
      const whyPassed = status === 'PASSED' ? [myPods.length ? `pod ${first.pod} ended ${first.phase}${first.exit_code != null ? `, exit code ${first.exit_code}` : ''}` : 'no pod seen', rows.filter((r) => r.result === 'PASS').map((r) => r.note.replace(/^triggered — /, '')).slice(0, 2).join('; ') || ''].filter(Boolean).join(' · ') : '';
      const whyFailed = status === 'PASSED' ? '' : status === 'STUCK_WAITING' ? `never started: ${diag.short}` : status === 'NEVER_DISPATCHED' ? `never started: ${rows[0]?.note || 'planned, but the orchestrator never dispatched it'}` :
        [pat ? `${pat.title}` : '', fail, myPods.map((p) => [p.reason, p.exit_code != null && p.exit_code !== 0 ? `exit code ${p.exit_code}` : '', p.message].filter(Boolean).join(' ')).filter(Boolean).join('; '), (tail.split(/\r?\n/).reverse().find((l) => /error|exception|denied|fatal|fail|killed|traceback/i.test(l)) || '').replace(/^\[[^\]]*\]\s*/, '').slice(0, 240)].filter(Boolean).join(' · ');
      recs.push({ tool, status, runtime: planned[tool] || '', pods: myPods, s3: rows, failure: fail, pattern: pat || undefined, whyPassed, whyFailed, missing });
    }
    recs.sort((a, b) => a.tool.localeCompare(b.tool));
    // files
    const counts: Record<string, number> = {}; const statuses: Record<string, ToolStatus> = {};
    for (const r of recs) { counts[r.status] = (counts[r.status] || 0) + 1; statuses[r.tool] = r.status; }
    fs.writeFileSync(path.join(live, 'tool-status.json'), JSON.stringify(statuses, null, 2));
    const head = ['tool', 'status', 'runtime', 'pod', 'node', 'exit_code', 'reason', 'started_ist', 'finished_ist', 'duration_s', 's3_result', 'known_pattern', 'why_passed_or_failed', 'missing'];
    const lines = [head.join(',')];
    for (const r of recs) {
      const p = r.pods[0] || {}; const dur = p.started && p.finished ? Math.round((Date.parse(p.finished) - Date.parse(p.started)) / 1000) : '';
      lines.push([r.tool, r.status, r.runtime, p.pod, p.node, p.exit_code, p.reason, ist(p.started), ist(p.finished), dur, r.s3.map((x) => x.result).join('/'), r.pattern?.id || '', r.status === 'PASSED' ? r.whyPassed : r.whyFailed, r.missing.join('; ')].map(csv).join(','));
    }
    fs.writeFileSync(path.join(live, 'tools.csv'), lines.join('\n') + '\n');
    for (const r of recs) {
      const d = path.join(live, 'tools', safe(r.tool)); fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'record.json'), JSON.stringify(r, null, 2));
      fs.writeFileSync(path.join(d, 'record.md'), [`# ${r.tool} — ${r.status}`, '', `Runtime: ${r.runtime || '-'}`,
        ...r.pods.map((p) => `Pod: ${p.pod} (${p.namespace}) · node ${p.node || '-'} · ${p.phase || '-'} · exit ${p.exit_code ?? '-'} ${p.reason || ''} · ${p.started_ist || ''} → ${p.finished_ist || ''} · console: ${p.console_file ? p.console_file.replace(/\\/g, '/') : 'none'} (${p.console_lines || 0} lines)`),
        '', `## WHY PASSED`, r.whyPassed || '-', '', `## WHY FAILED`, r.whyFailed || '-', r.pattern ? `\nKnown pattern **${r.pattern.id}**: ${r.pattern.rootCause}\nOwner: ${r.pattern.owner}\nFix: ${r.pattern.fix}` : '', '',
        `## S3 results`, ...(r.s3.length ? r.s3.map((x) => `- ${x.result}: ${x.note}`) : ['- none']), r.failure ? `\nfailure.json: ${r.failure}` : '', '', `## WHAT IS MISSING`, ...(r.missing.length ? r.missing.map((m) => `- ${m}`) : ['- nothing']), ''].join('\n'));
    }
    const order: ToolStatus[] = ['FAILED', 'EMPTY_OUTPUT', 'STUCK_WAITING', 'NEVER_DISPATCHED', 'UNKNOWN', 'PASSED'];
    const md: string[] = [`# QA EKS run summary — ${summary.branch || ''}`, '', `Run: ${summary.run_id || ''}`, `Collector: ${summary.collector_started_ist || ''} → ${summary.collector_stopped_ist || ''} · cluster reached: ${summary.cluster_reached ? 'yes' : 'NO'} · tool pods seen: ${summary.tool_pods_seen ?? 0} · tasks seen: ${summary.tasks_seen ?? 0}`, ''];
    if (diag) md.push('## Run-level finding', `**${diag.title}** (rule ${diag.id})`, '', diag.summary, '', `Root cause: ${diag.rootCause}`, '', 'Evidence:', ...diag.evidence.map((e: string) => `- ${e}`), '', `Owner: ${diag.owner}`, `Fix: ${diag.fix}`, '');
    md.push('## Counts per status', ...order.filter((s) => counts[s]).map((s) => `- ${s}: ${counts[s]}`), '');
    md.push('## Timeline (IST)');
    const tl: [string, string][] = [];
    if (summary.collector_started_ist) tl.push([summary.collector_started_ist, 'collector started']);
    if (diag?.first) tl.push([ist(diag.first), 'first RUNTIME_UNAVAILABLE wait']); if (diag?.last) tl.push([ist(diag.last), `last wait seen (${diag.waits} in total)`]);
    for (const p of pods) { if (p.started) tl.push([ist(p.started), `${p.tool} started`]); if (p.finished) tl.push([ist(p.finished), `${p.tool} finished (${p.phase}${p.exit_code != null ? `, exit ${p.exit_code}` : ''})`]); }
    if (summary.collector_stopped_ist) tl.push([summary.collector_stopped_ist, 'collector stopped']);
    md.push(...(tl.length ? tl.map(([t, e]) => `- ${t}: ${e}`) : ['- nothing recorded']), '');
    md.push('## Tools that did not pass');
    const bad = recs.filter((r) => r.status !== 'PASSED');
    md.push(...(bad.length ? bad.map((r) => `- **${r.tool}** — ${r.status}: ${r.whyFailed || '-'}${r.pattern ? ` [pattern: ${r.pattern.id}]` : ''}`) : ['- none']), '');
    const gaps = [...(summary.gaps || []), ...(summary.notes || []), ...(summary.missing || [])];
    md.push('## Missing data / gaps', ...(gaps.length ? [...new Set<string>(gaps)].slice(0, 30).map((g) => `- ${g}`) : ['- none recorded']), '', '_Details per tool: tools.csv and tools/<tool>/record.md. Every statement here comes from captured logs, pod status or S3 files; patterns are rules, nothing is guessed._', '');
    fs.writeFileSync(path.join(live, 'run_summary.md'), md.join('\n'));
    return { statuses, counts };
  } catch (e) { console.log(`  QA EKS report: not written (${e instanceof Error ? e.message : e})`); return null; }
}
