import * as fs from 'fs';
import * as path from 'path';
import { norm, readJson } from './eksEvidence';

/**
 * The PROFILE of ONE tool: everything the logs and the S3 result say about it, as plain facts (nothing here is worded by a model):
 * who it is (language, technique), when it was scheduled, dispatched, started and finished, how long it waited and ran, every pod attempt
 * (node, image, command, exit), the warnings of its task, what the orchestrator said about it, the S3 result rows and files, and the run it belongs to.
 * Reads only. Never throws (missing files give empty parts).
 */
export interface TimelineEvent { at: string; ist: string; label: string; detail: string }
export interface AttemptFacts { pod: string; task: string; node: string; image: string; command: string; phase: string; exitCode: number | null; reason: string; restarts: number; started: string; finished: string; seconds: number | null }
export interface S3Row { testingType: string; technique: string; classifications: string; result: string; note: string; files: string[] }
export interface ToolProfile {
  identity: [string, string][];
  timeline: TimelineEvent[]; attempts: AttemptFacts[];
  seconds: { queueWait: number | null; task: number | null; pods: number | null };
  firstStart: string; lastEnd: string;
  warnings: { ist: string; where: string; message: string; detail: string }[];
  orchestrator: string[]; s3: S3Row[]; s3Files: string[];
  logHead: string[]; logTail: string[];
  run: [string, string][];
}

export const ist = (iso?: string | number): string => {
  if (!iso) return ''; const d = new Date(iso); if (isNaN(d.getTime())) return String(iso);
  return `${d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }).replace(',', '')} IST`;
};
export const dur = (s: number | null | undefined): string => {
  if (s == null || !isFinite(s)) return '-'; s = Math.round(s); const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min ${s % 60} s` : m ? `${m} min ${s % 60} s` : `${s} s`;
};

const LIFE: Record<string, string> = {
  'task.status.scheduled': 'Task scheduled by the orchestrator', 'dispatcher.task_published': 'Sent to the worker queue', 'consumer.received': 'Taken from the queue',
  'task.status.started': 'Task started on a worker', 'handler.executing': 'Tool command started', 'artifact.uploaded': 'Result file uploaded to storage',
  'evidence_repo.persisted': 'Evidence saved', 'handler.execution_complete': 'Tool command finished', 'task.status.completed': 'Task completed',
  'task.status.failed': 'Task failed', 'handler.succeeded': 'Worker handler succeeded', 'handler.failed': 'Worker handler failed', 'consumer.ack': 'Queue message acknowledged',
  'consumer.nack': 'Queue message rejected',
};
const DETAIL = ['queue', 'queue_name', 'environment_id', 'status', 'exit_code', 'duration_ms', 'path', 'key', 'object_key', 'error', 'reason'];
const MAX_LINES = 30000;

function services(file: string): string[] { try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-MAX_LINES); } catch { return []; } }
function parse(l: string): any { const i = l.indexOf('{'); if (i < 0) return null; try { return JSON.parse(l.slice(i)); } catch { return null; } }
const det = (j: any, only?: string[]) => (only || DETAIL).filter((k) => j[k] !== undefined && j[k] !== '' && typeof j[k] !== 'object').map((k) => `${k.replace('queue_name', 'queue')}: ${String(j[k]).slice(0, 90)}`).filter((v, i, a) => a.indexOf(v) === i).join(' · ');
const secs = (a?: string, b?: string) => (a && b && !isNaN(Date.parse(a)) && !isNaN(Date.parse(b)) ? (Date.parse(b) - Date.parse(a)) / 1000 : null);

export function buildProfile(branchDir: string, tool: string, recs: any[], language: string, version: string): ToolProfile {
  const live = path.join(branchDir, 'eks-live'); const want = norm(tool);
  const sum = readJson(path.join(live, 'summary.json')) || {}; const s3 = readJson(path.join(branchDir, 's3-check.json')); const rd = readJson(path.join(branchDir, 'run-details.json'));
  const attempts: AttemptFacts[] = recs.map((r) => ({ pod: r.pod, task: String(r.task || ''), node: String(r.node || ''), image: String(r.image || '').replace(/^.*\/testable\//, '').replace(/@sha256:(\w{12})\w+/, '@$1…'), command: String(r.command || ''), phase: String(r.phase || ''), exitCode: r.exit_code ?? null, reason: [r.reason, r.message].filter(Boolean).join(' · '), restarts: Number(r.restarts || 0), started: String(r.started || ''), finished: String(r.finished || ''), seconds: secs(r.started, r.finished) }));
  const tasks = new Set(attempts.map((a) => a.task).filter(Boolean));
  const timeline: TimelineEvent[] = []; const warnings: ToolProfile['warnings'] = []; const orchestrator: string[] = [];
  const named = new RegExp(`(?<![A-Za-z0-9_-])${tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'i');
  let published = '', started = '', ended = '';
  for (const l of services(path.join(live, 'services.log'))) {
    const mine = [...tasks].some((t) => l.includes(t));
    if (!mine && !(named.test(l) && /planning\.|tools_(skipped|unplaceable)|dispatch|admission|readiness/i.test(l))) continue;
    const j = parse(l); if (!j) continue; const msg = String(j.message || ''); const at = String(j.timestamp || '');
    const svc = String(j.service_name || '').replace('wb-', '');
    if (!mine) { orchestrator.push(`${ist(at).slice(11)} ${j.level} ${svc}: ${msg}${det(j, ['reason', 'skip_reason', 'readiness_status', 'queue', 'environment_id']) ? ` (${det(j, ['reason', 'skip_reason', 'readiness_status', 'queue', 'environment_id'])})` : ''}`); continue; }
    if (LIFE[msg]) {
      timeline.push({ at, ist: ist(at), label: LIFE[msg], detail: det(j, msg === 'dispatcher.task_published' || msg === 'artifact.uploaded' ? undefined : DETAIL.filter((k) => !/^(queue|queue_name|environment_id)$/.test(k))) });
      if (msg === 'dispatcher.task_published' && !published) published = at;
      if (msg === 'task.status.started' && !started) started = at;
      if (/^task\.status\.(completed|failed)$/.test(msg)) ended = at;
    }
    if (/^(WARNING|ERROR|CRITICAL)$/i.test(String(j.level))) warnings.push({ ist: ist(at), where: svc, message: msg, detail: det(j, ['error', 'reason', 'detail', 'status', 'delivery_attempt_id']) });
  }
  for (const a of attempts) { // the pods themselves, from the collector (kubectl): start, end, exit
    if (a.started) timeline.push({ at: a.started, ist: ist(a.started), label: 'Tool pod started', detail: `pod ${a.pod.replace(/^wb-exec-/, '').slice(0, 14)}… on ${a.node.split('.')[0] || 'a node'}` });
    if (a.finished) timeline.push({ at: a.finished, ist: ist(a.finished), label: `Tool pod finished: ${a.phase}`, detail: `exit code ${a.exitCode ?? '?'}${a.reason ? ` · ${a.reason}` : ''}` });
  }
  timeline.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  const starts = attempts.map((a) => a.started).filter(Boolean).sort(); const ends = attempts.map((a) => a.finished).filter(Boolean).sort();
  const podSec = attempts.reduce((n, a) => n + (a.seconds || 0), 0);
  // the rows of the S3 check for this tool, and the files of its S3 folder
  const key = ['python', 'javascript', 'typescript', 'csharp', 'java'].find((k) => s3?.[k]);
  const rows: S3Row[] = (s3?.checks || []).filter((r: any) => norm(String(r.tool)) === want || String(r.primary || '').split(' + ').some((p: string) => norm(p) === want)).map((r: any) => ({ testingType: r.testingType, technique: r.technique, classifications: (r.classifications || []).join(', '), result: r.result, note: String(r.note || '').slice(0, 300), files: r.files || [] }));
  const inv = readJson(path.join(branchDir, 's3-folders.json')) || {}; const folder = Object.keys(inv).find((f) => norm(f) === want);
  const last = attempts.filter((a) => a.phase === 'Failed').pop() || attempts[attempts.length - 1];
  let logHead: string[] = [], logTail: string[] = [];
  const rec = recs.find((r) => r.pod === last?.pod);
  if (rec?.console_file) { try { const L = fs.readFileSync(path.join(live, rec.console_file), 'utf8').split(/\r?\n/).filter(Boolean).map((x) => x.replace(/^\[[^\]]*\]\s*/, '').replace(/\u001b?\[\d+(?:;\d+)*m/g, '').replace(/\s+/g, ' ').trim().slice(0, 200)); logHead = L.length > 20 ? L.slice(0, 3) : []; logTail = L.length > 20 ? L.slice(-12) : L; } catch { /* none */ } }
  const planned = (sum.planned_tools || {})[tool];
  const identity: [string, string][] = [['Tool', tool], ['Language', [language, version].filter(Boolean).join(' ') || '-'], ['Testing type', [...new Set(rows.map((r) => r.testingType))].join(', ') || '-'], ['Technique', [...new Set(rows.map((r) => r.technique))].join(', ') || '-'],
    ['Status in the capture', String((readJson(path.join(live, 'tool-status.json')) || {})[tool] || '-')], ['Planned for this run', tool in (sum.planned_tools || {}) ? `yes${planned ? ` (runtime ${planned})` : ''}` : 'not in the planned list of the capture'], ['Pod attempts', String(attempts.length)], ['Task ids', [...tasks].map((t) => t.slice(0, 8)).join(', ') || '-']];
  const run: [string, string][] = rd ? [['Run id', String(rd.run_id)], ['Run status', `${rd.status || '-'} (${rd.phase || '-'})`], ['Tasks', `${rd.total_tasks ?? '-'} total, ${rd.completed_tasks ?? '-'} completed, ${rd.failed_tasks ?? '-'} failed, ${rd.skipped_tasks ?? '-'} skipped`], ['Commit', String(rd.commit_sha || '-').slice(0, 12)], ['Trigger', String(rd.trigger_type || '-')]] : sum.run_id ? [['Run id', String(sum.run_id)], ['Capture', `${sum.collector_started_ist || '-'} to ${sum.collector_stopped_ist || '-'}`], ['Tool pods seen', String(sum.tool_pods_seen ?? '-')]] : [];
  void key; // firstStart / lastEnd below are the TASK window (worker started to task completed); the pods run inside it
  return { identity, timeline, attempts, seconds: { queueWait: secs(published, started), task: secs(started, ended), pods: attempts.length ? podSec : null }, firstStart: started || starts[0] || '', lastEnd: ended || ends[ends.length - 1] || '', warnings, orchestrator: [...new Set(orchestrator)].slice(0, 12), s3: rows, s3Files: folder ? inv[folder] : [], logHead, logTail, run };
}
