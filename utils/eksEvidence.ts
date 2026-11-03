import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * The real evidence of ONE tool: what the live collector saved (eks-live/: the tool pod's console log, the pod's exit reason, the lines of the
 * cell services that name exactly this tool) plus the tool's failure.json from S3. Nothing is guessed: no lines = null.
 */
export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
export const ERR = /error|exception|traceback|denied|fatal|fail|oom|killed|timeout|timed out|no such file|cannot|refused|unavailable|not found|panic|exit code|backoff|evicted|permission/i;

export interface LiveEvidence { tool: string; lines: string[]; sources: string[]; signature: string; podReason: string }

export function readJson(p: string): any { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function tail(p: string, n: number): string[] { try { return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).slice(-n); } catch { return []; } }
function find(dir: string, name: string, depth = 5): string[] {
  const out: string[] = [];
  const walk = (d: string, k: number) => { if (k > depth) return; let es: fs.Dirent[] = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, k + 1); else if (e.name === name) out.push(p); } };
  walk(dir, 0); return out;
}

/** a short text that stays the same for the same bug: times, ids, numbers and paths removed */
export function signatureOf(line: string, code = ''): string {
  const s = `${code} ${line}`.toLowerCase().replace(/\d{4}-\d\d-\d\dt[\d:.]+z?/g, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>').replace(/\b[0-9a-f]{7,}\b/g, '<hex>').replace(/(\/|[a-z]:\\)[^\s'"]+/g, '<path>').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 200);
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

const TS = /\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\b\s*/g;

export function liveEvidence(branchDir: string, tool: string): LiveEvidence | null {
  try {
    const live = path.join(branchDir, 'eks-live'); const want = norm(tool);
    const lines: string[] = []; const sources: string[] = []; let podReason = '';
    // 1. S3 failure.json of this tool (the platform's own statement)
    for (const f of find(path.join(branchDir, 's3-evidence'), 'failure.json')) {
      const rel = path.relative(path.join(branchDir, 's3-evidence'), f).split(path.sep)[0];
      if (norm(rel) !== want) continue; // exact: 'coverage_delta' (JS) must not pick up 'cs_coverage_delta' (C#)
      const j = readJson(f); if (!j) continue;
      const t = [j.error_code, j.status, j.reason || j.error].filter(Boolean).join(' · ').replace(/\s+/g, ' ').slice(0, 300);
      if (t) { lines.push(`failure.json: ${t}`); sources.push(`s3-evidence/${rel}/failure.json`); }
    }
    // 2. the tool pod(s) saved by the live collector
    const recs: any[] = readJson(path.join(live, 'tools.json')) || [];
    for (const r of recs.filter((x) => norm(x.tool) === want).slice(0, 3)) {
      const reason = [r.reason, r.exit_code != null && r.exit_code !== 0 ? `exit code ${r.exit_code}` : '', r.message].filter(Boolean).join(' · ');
      if (reason) { podReason = podReason || reason; lines.push(`pod ${r.pod}: ${reason}`); }
      const con = r.console_file ? path.join(live, r.console_file) : '';
      const all = con ? tail(con, 400).map((l) => l.replace(/^\[[^\]]*\]\s*/, '').replace(TS, '').trim()).filter(Boolean) : [];
      const errs = all.filter((l) => ERR.test(l)).slice(-8);
      const pick = errs.length ? errs : all.slice(-4);
      for (const l of pick) lines.push(l.slice(0, 260));
      if (pick.length) sources.push(`eks-live/${r.console_file.replace(/\\/g, '/')}`);
    }
    // 3. what the cell services said about this tool in this run (dispatch / wait / retry decisions)
    // the tool's NAME, not a piece of another name: 'cpd' must not pick up 'jscpd-py', 'ck' must not pick up 'check' or 'task_id'
    const named = new RegExp(`(?<![A-Za-z0-9_-])${tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'i');
    const svc = tail(path.join(live, 'services.log'), 4000).filter((l) => named.test(l) && (ERR.test(l) || /wait|retry|dispatch|skip/i.test(l))).slice(-4);
    for (const l of svc) lines.push(compactServiceLine(l, tool));
    if (svc.length) sources.push('eks-live/services.log');
    const uniq = [...new Set(lines)].slice(0, 14);
    if (!uniq.length) return null;
    const main = uniq.find((l) => ERR.test(l)) || uniq[0];
    return { tool, lines: uniq, sources: [...new Set(sources)], signature: signatureOf(main, ''), podReason };
  } catch { return null; }
}

/** one service log line as "time LEVEL service: message (tool_name=… reason=…)": the JSON of a service line is far longer than the cut-off, so cutting it would lose the reason */
export function compactServiceLine(l: string, tool?: string): string {
  const plain = () => l.replace(TS, '').replace(/\s+/g, ' ').slice(0, 260);
  const i = l.indexOf('{'); if (i < 0) return plain();
  try {
    const j = JSON.parse(l.slice(i)); const svc = (/^\[([^\]]+)\]/.exec(l) || [])[1] || '';
    const parts = ['tool_name', 'reason', 'skip_reason', 'readiness_status', 'environment_id', 'queue', 'error', 'task_id'].filter((k) => j[k] !== undefined && j[k] !== '').map((k) => `${k}=${String(j[k]).slice(0, 80)}`);
    const has = (k: string) => parts.some((p) => p.startsWith(`${k}=`));
    // Planning lines name their tools in a LIST ("tools": [{tool, reason, detail}, ...], e.g. planning.tools_unplaceable): the entry of THIS tool carries the
    // reason the platform gave. Without it the line would read only "planning.tools_unplaceable ()".
    if (tool) {
      const want = tool.toLowerCase();
      for (const [key, v] of Object.entries(j)) {
        if (!Array.isArray(v)) continue;
        const entry = v.find((x: any) => x && typeof x === 'object' && [x.tool, x.tool_name, x.name].some((n) => String(n || '').toLowerCase() === want));
        if (entry) {
          if (!has('tool_name')) parts.unshift(`tool_name=${tool}`);
          for (const f of ['reason', 'skip_reason', 'detail', 'toolVersion', 'language', 'status']) if (entry[f] != null && entry[f] !== '' && !has(f)) parts.push(`${f}=${String(entry[f]).replace(/\s+/g, '_').slice(0, 140)}`);
          break;
        }
        if (v.some((x: any) => typeof x === 'string' && x.toLowerCase().replace(/^[a-z0-9_]+:/, '') === want)) { if (!has('tool_name')) parts.unshift(`tool_name=${tool}`); parts.push(`listed_in=${key}`); break; }
      }
    }
    return `${String(j.timestamp || '').slice(11, 19)} ${j.level || ''} ${String(j.service_name || svc).replace('cell-001-', '')}: ${j.message || ''} (${parts.join(' ')})`.slice(0, 420);
  } catch { return plain(); }
}
