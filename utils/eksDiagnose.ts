import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { parseReportMarkdown, type EksAiDiagnosis } from './eksMentor';
import { ensureEksModel } from './eksModel';
import { matchToolPattern } from './eksPatterns';

/**
 * Root cause from REAL log lines. For a defective tool it takes what the live collector saved (eks-live/: the tool pod's console log, the
 * pod's exit reason, the lines of the cell services about this run) plus the tool's failure.json from S3, and asks the local Ollama model
 * (OLLAMA_HOST / OLLAMA_QA_MODEL, the same as the QA EKS Mentor) to explain ONLY those lines.
 *  - Same error text (same "signature") in several tools or branches = ONE model call; the answer is reused (results/.eks-signature-cache.json).
 *  - The model must copy the proving log line. If the copied line is not one of the lines it was given, the answer is marked UNVERIFIED.
 *  - No log lines = no diagnosis (null): nothing is guessed. Model offline = the log lines are still returned, marked NO_MODEL.
 * Never throws.
 */
const OLLAMA_HOST = () => process.env.OLLAMA_HOST || 'http://localhost:11434';
const MODEL = () => process.env.OLLAMA_QA_MODEL || 'qa-eks-mentor-trained:latest';
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const ERR = /error|exception|traceback|denied|fatal|fail|oom|killed|timeout|timed out|no such file|cannot|refused|unavailable|not found|panic|exit code|backoff|evicted|permission/i;

export interface LiveEvidence { tool: string; lines: string[]; sources: string[]; signature: string; podReason: string }

function readJson(p: string): any { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
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
    for (const l of svc) lines.push(compactServiceLine(l));
    if (svc.length) sources.push('eks-live/services.log');
    const uniq = [...new Set(lines)].slice(0, 14);
    if (!uniq.length) return null;
    const main = uniq.find((l) => ERR.test(l)) || uniq[0];
    return { tool, lines: uniq, sources: [...new Set(sources)], signature: signatureOf(main, ''), podReason };
  } catch { return null; }
}
const TS = /\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\b\s*/g;

/** one service log line as "time LEVEL service: message (tool_name=… reason=…)": the JSON of a service line is far longer than the cut-off, so cutting it would lose the reason */
function compactServiceLine(l: string): string {
  const plain = () => l.replace(TS, '').replace(/\s+/g, ' ').slice(0, 260);
  const i = l.indexOf('{'); if (i < 0) return plain();
  try {
    const j = JSON.parse(l.slice(i)); const svc = (/^\[([^\]]+)\]/.exec(l) || [])[1] || '';
    const f = ['tool_name', 'reason', 'skip_reason', 'readiness_status', 'environment_id', 'queue', 'error', 'task_id'].filter((k) => j[k] !== undefined && j[k] !== '').map((k) => `${k}=${String(j[k]).slice(0, 80)}`).join(' ');
    return `${String(j.timestamp || '').slice(11, 19)} ${j.level || ''} ${String(j.service_name || svc).replace('cell-001-', '')}: ${j.message || ''} (${f})`.slice(0, 300);
  } catch { return plain(); }
}

/**
 * The RCA input block of qa-eks-mentor/RCA_PROMPT.md section 2. ONE function for the live diagnosis and for the training tool (npm run teach), so the
 * model is trained on exactly the text it receives at run time.
 */
export function rcaInput(tool: string, runId: string, branchDir: string, ev: LiveEvidence, ctx?: { observed?: string; note?: string; version?: string; state?: string; s3?: string }): string {
  const state = /empty|\[\]|\{\}/i.test(ctx?.observed || '') ? 'EMPTY' : /fail/i.test(ctx?.observed || '') ? 'FAILED' : /skip|not applicable/i.test(ctx?.observed || '') ? 'SKIPPED' : 'NOT_TRIGGERED';
  return [
    'INPUT', `TOOL: ${tool}`, `STATE: ${ctx?.state || state}`, `LANGUAGE: ${languageLabel(branchDir) || ctx?.version || 'unknown'}`, `BRANCH: ${path.basename(branchDir)}   RUN: ${runId}`,
    `S3: ${ctx?.s3 ?? ((ctx?.observed || '') + ' ' + (ctx?.note || '')).trim().slice(0, 300)}`,
    ...(ev.lines.length ? ['LOG EVIDENCE:', ...ev.lines] : ['LOG EVIDENCE: none']), `POD STATE: ${ev.podReason || 'not captured'}`,
  ].join('\n').slice(0, 5200);
}

/** "typescript, Node 20" / "java, 17" as in the training examples, read from the branch's s3-check.json (the live path used to send only the bare version) */
function languageLabel(branchDir: string): string {
  const j = readJson(path.join(branchDir, 's3-check.json')); if (!j) return '';
  const parts: string[] = [];
  for (const k of ['python', 'javascript', 'typescript', 'csharp', 'java']) { const b = j[k]; if (b?.version) parts.push(`${k}, ${k === 'javascript' || k === 'typescript' ? 'Node ' : ''}${b.version}`); }
  return parts.join('; ');
}

/** asks the registered model (the live path and the teach tool both use this) */
export const askRcaModel = (prompt: string, ms = 120_000) => askModel(prompt, ms);

async function askModel(prompt: string, ms: number): Promise<string | null> {
  if (!(await ensureEksModel())) return null; // model missing on this PC: the caller marks NO_MODEL and still returns the real log lines
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(`${OLLAMA_HOST()}/api/chat`, { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL(), stream: false, options: { temperature: 0.1, num_ctx: 4096 }, messages: [{ role: 'user', content: prompt }] }) });
    if (!res.ok) return null; const j: any = await res.json(); return j?.message?.content?.trim() || null;
  } catch { return null; } finally { clearTimeout(t); }
}
const field = (txt: string, name: string) => { const m = new RegExp(`${name}\\s*:\\s*([\\s\\S]*?)(?=\\n[A-Z_]{4,}\\s*:|$)`, 'i').exec(txt); return m ? m[1].trim().replace(/\s+/g, ' ') : ''; };

const calls = new Map<string, number>(); // model calls per branch folder
export async function liveDiagnosis(tool: string, runId: string, branchDir: string, ctx?: { observed?: string; note?: string; version?: string }): Promise<EksAiDiagnosis | null> {
  try {
    if (/^(off|no|0|false)$/i.test((process.env.EKS_LIVE || '').trim())) return null;
    // run-level cause first: a tool that was never started because the whole run was stuck is explained by the run's finding (no model needed)
    const runDiag = readJson(path.join(branchDir, 'eks-live', 'run-diagnosis.json')); const st = (readJson(path.join(branchDir, 'eks-live', 'tool-status.json')) || {})[tool];
    if (runDiag && (st === 'STUCK_WAITING' || st === 'NEVER_DISPATCHED'))
      return { source: 'live', summary: `${tool} never started: ${runDiag.title}`, rootCause: runDiag.rootCause, evidence: (runDiag.evidence || []).slice(0, 2).join(' | '), owner: runDiag.owner, suggestedFix: runDiag.fix, verdict: `KNOWN PATTERN (run-level): ${runDiag.id}` };
    const ev = liveEvidence(branchDir, tool); if (!ev) return null;
    // a known platform pattern in the captured lines is answered by the rule, with the real line quoted (no model call)
    const kp = matchToolPattern({ tool, text: ev.lines.join('\n'), podReason: ev.podReason });
    if (kp) return { source: 'live', summary: `${tool}: ${kp.title}`, rootCause: kp.rootCause, evidence: ev.lines.find((l) => ERR.test(l)) || ev.lines[0], owner: kp.owner, suggestedFix: kp.fix, verdict: `KNOWN PATTERN: ${kp.id}` };
    const best = ev.lines.find((l) => ERR.test(l)) || ev.lines[0];
    const base: EksAiDiagnosis = { source: 'live', evidence: best, summary: `${tool}: ${ctx?.observed || 'tool problem'}${ev.podReason ? ` (${ev.podReason.slice(0, 80)})` : ''}`.slice(0, 200) };
    // same error seen before (this branch, an earlier branch, an earlier day): reuse, no model call
    const cacheFile = path.join(branchDir, '..', '..', '.eks-signature-cache.json');
    const cache: Record<string, any> = readJson(cacheFile) || {};
    const hit = cache[ev.signature];
    if (hit) return { ...base, ...hit, evidence: best, verdict: `${hit.verdict || 'GROUNDED'} (same error as before: ${hit.firstTool})`, source: 'live' };
    const used = calls.get(branchDir) || 0; const maxCalls = Number(process.env.EKS_LIVE_MAX_CALLS) || 6;
    if (used >= maxCalls) return { ...base, verdict: `NOT_ANALYSED (limit of ${maxCalls} model calls per branch; the log lines are attached)` };
    calls.set(branchDir, used + 1);
    // the RCA input block of qa-eks-mentor/RCA_PROMPT.md (the system prompt is in the model's Modelfile): the model was trained on exactly this shape
    const prompt = rcaInput(tool, runId, branchDir, ev, ctx);
    const ans = await askModel(prompt, (Number(process.env.EKS_LIVE_MODEL_SEC) || 120) * 1000);
    if (!ans) return { ...base, verdict: 'NO_MODEL (Ollama did not answer; the real log lines are attached)', rootCause: 'not analysed' };
    const rca = /^Verdict:/im.test(ans) ? parseReportMarkdown(ans) : null;
    const evid = rca ? (rca.evidence || '') : field(ans, 'EVIDENCE'); const rc = rca ? (rca.rootCause || '') : field(ans, 'ROOT_CAUSE');
    const grounded = !!evid && ev.lines.some((l) => { const a = norm(l), b = norm(evid); return b.length >= 12 && (a.includes(b.slice(0, Math.min(60, b.length))) || b.includes(a.slice(0, Math.min(60, a.length)))); });
    const out: EksAiDiagnosis = {
      source: 'live', summary: rca ? (rca.summary || base.summary) : field(ans, 'SUMMARY') || base.summary, rootCause: rc, owner: rca ? rca.owner : field(ans, 'OWNER'), suggestedFix: rca ? rca.action : field(ans, 'SUGGESTED_FIX'), action: rca?.action, acceptance: rca?.acceptance,
      evidence: grounded ? evid : best, verdict: /^unknown/i.test(rc) || /insufficient evidence/i.test(rca?.verdict || '') ? 'UNKNOWN (the logs do not show the cause)' : grounded ? 'GROUNDED' : 'UNVERIFIED (the model quoted a line that is not in the logs: treat the root cause as a guess)',
    };
    if (grounded) { cache[ev.signature] = { summary: out.summary, rootCause: out.rootCause, owner: out.owner, suggestedFix: out.suggestedFix, verdict: 'GROUNDED', firstTool: tool, at: new Date().toISOString() }; try { fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 1)); } catch { /* ignore */ } }
    return out;
  } catch { return null; }
}
