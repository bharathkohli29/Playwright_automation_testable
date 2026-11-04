import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';

/**
 * Time taken by every step of one branch (script start → end) and by every tool pod seen on the QA EKS cluster,
 * written to <branch folder>/timings.xlsx (+ timings.json). Read-only: it only reads files the run already saved.
 */
export interface StepRec { id: string; title: string; start: number; end: number; status: 'Pass' | 'Fail' }

const IST = (ms?: number | string | null) => {
  if (ms === undefined || ms === null || ms === '') return '';
  const d = new Date(ms); if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }).replace(',', '') + ' IST';
};
const mmss = (sec: number) => `${Math.floor(sec / 60)}m ${String(Math.round(sec % 60)).padStart(2, '0')}s`;
const secBetween = (a?: number, b?: number) => (a && b && b >= a ? Math.round((b - a) / 1000) : undefined);
const readJson = (f: string): any => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
const ms = (s?: string) => { const t = s ? Date.parse(s) : NaN; return isNaN(t) ? undefined : t; };

export interface ToolTiming {
  name: string; tool: string; pod: string; task: string; status: string; phase: string; exit_code: string | number; node: string;
  created?: number; started?: number; finished?: number; wait_s?: number; run_s?: number; total_s?: number;
}


/** task id → tool name, from the orchestrator lines saved in eks-live/services.log (JSON lines with task_id and tool) */
function taskToolNames(live: string): Map<string, string> {
  const m = new Map<string, string>();
  try {
    for (const l of fs.readFileSync(path.join(live, 'services.log'), 'utf8').split(/\r?\n/)) {
      const i = l.indexOf('{"'); if (i < 0 || !/task_id/.test(l)) continue;
      try { const j = JSON.parse(l.slice(i)); const t = String(j.task_id || '').toLowerCase(), n = j.tool || j.tool_name || j.technique; if (t && n && !m.has(t)) m.set(t, String(n)); } catch { /* not json */ }
    }
  } catch { /* no services.log */ }
  return m;
}
const looksLikePod = (s: string) => /^[0-9a-f]{20,}(-[a-z0-9]+)?$/i.test(s) || /^wb-exec-/.test(s);

/** one row per tool pod: queued (pod created) → started → finished, from eks-live/tools.json + pods/<pod>/pod.json */
export function readToolTimings(branchDir: string): { rows: ToolTiming[]; note: string } {
  const live = path.join(branchDir, 'eks-live');
  const tools = readJson(path.join(live, 'tools.json'));
  if (!Array.isArray(tools)) return { rows: [], note: fs.existsSync(live) ? 'eks-live/tools.json not found (the collector saw no tool pods)' : 'QA EKS collector was off for this run (set EKS_AUTO=on), so tool times are not available' };
  const status = readJson(path.join(live, 'tool-status.json')) || {};
  const names = taskToolNames(live);
  const rows = tools.map((t: any): ToolTiming => {
    const pj = readJson(path.join(live, 'pods', String(t.pod || ''), 'pod.json'));
    const created = ms(pj?.metadata?.creationTimestamp), started = ms(t.started), finished = ms(t.finished);
    let task = String(pj?.metadata?.labels?.['whitebox.testable.cloud/task'] || '');
    if (!task) { try { task = /whitebox\.testable\.cloud\/task[=:]\s*([0-9a-f-]{36})/i.exec(fs.readFileSync(path.join(live, 'pods', String(t.pod || ''), 'describe.txt'), 'utf8'))?.[1] || ''; } catch { /* no describe */ } }
    const raw = String(t.tool || t.pod || '');
    const name = !looksLikePod(raw) ? raw : (names.get(task.toLowerCase()) || '(name not found)');
    return {
      name, tool: raw, pod: String(t.pod || ''), task,
      status: String(status[t.tool] || status[name] || ''), phase: String(t.phase || ''), exit_code: t.exit_code ?? '', node: String(t.node || ''),
      created, started, finished, wait_s: secBetween(created, started), run_s: secBetween(started, finished), total_s: secBetween(created, finished),
    };
  }).sort((a: ToolTiming, b: ToolTiming) => (a.created || a.started || 0) - (b.created || b.started || 0));
  return { rows, note: '' };
}

export async function writeTimingWorkbook(o: {
  branchDir: string; branch: string; repo: string; runId?: string | null; status: string;
  scriptStart: number; scriptEnd: number; steps: StepRec[]; handedOff: boolean; summaryCsv?: boolean;
}): Promise<string> {
  const run = readJson(path.join(o.branchDir, 'run-details.json')) || {};
  const { rows: tools, note: toolNote } = readToolTimings(o.branchDir);
  const totalSec = Math.round((o.scriptEnd - o.scriptStart) / 1000);
  const post: Array<{ step: string; start: number; end: number; status: string; detail?: string }> = readJson(path.join(o.branchDir, 'postprocess-times.json')) || [];
  const postStart = post.length ? Math.min(...post.map((p) => p.start)) : 0, postEnd = post.length ? Math.max(...post.map((p) => p.end)) : 0;

  const wb = new ExcelJS.Workbook(); wb.created = new Date();
  const head = (ws: ExcelJS.Worksheet) => { const r = ws.getRow(1); r.font = { bold: true, color: { argb: 'FFFFFFFF' } }; r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } }; ws.views = [{ state: 'frozen', ySplit: 1 }]; };

  const ws1 = wb.addWorksheet('Summary', { properties: { tabColor: { argb: 'FF2A9D6F' } } }); // first tab, filled below

  // ---- Steps
  const ws2 = wb.addWorksheet('Steps');
  ws2.columns = [{ header: '#', width: 5 }, { header: 'Step', width: 8 }, { header: 'What the step does', width: 70 }, { header: 'Start (IST)', width: 24 }, { header: 'End (IST)', width: 24 }, { header: 'Seconds', width: 10 }, { header: 'Min:Sec', width: 11 }, { header: '% of script', width: 12 }, { header: 'Status', width: 9 }, { header: 'Start (UTC)', width: 24 }];
  o.steps.forEach((s, i) => {
    const sec = Math.round((s.end - s.start) / 1000);
    ws2.addRow([i + 1, s.id.split('/').pop(), s.title, IST(s.start), IST(s.end), sec, mmss(sec), totalSec ? sec / totalSec : 0, s.status, new Date(s.start).toISOString()]);
  });
  const last = o.steps.length + 1;
  const tr = ws2.addRow(['', '', 'Sum of the steps', IST(o.steps[0]?.start), IST(o.steps[o.steps.length - 1]?.end), { formula: `SUM(F2:F${last})` }, '', '', '', '']);
  tr.font = { bold: true };
  ws2.getColumn(8).numFmt = '0.0%'; head(ws2);

  // ---- Tools
  const ws3 = wb.addWorksheet('Tools');
  ws3.columns = [{ header: 'Tool name', width: 26 }, { header: 'Status', width: 12 }, { header: 'Queued = pod created (IST)', width: 26 }, { header: 'Started (IST)', width: 24 }, { header: 'Finished (IST)', width: 24 }, { header: 'Wait before start (s)', width: 14 }, { header: 'Run time (s)', width: 12 }, { header: 'Total queued→finished (s)', width: 14 }, { header: 'Phase', width: 11 }, { header: 'Exit code', width: 9 }, { header: 'Task id', width: 38 }, { header: 'Pod', width: 52 }, { header: 'Node', width: 40 }];
  tools.forEach((t) => ws3.addRow([t.name, t.status, IST(t.created), IST(t.started), IST(t.finished), t.wait_s ?? '', t.run_s ?? '', t.total_s ?? '', t.phase, t.exit_code, t.task, t.pod, t.node]));
  if (tools.length) {
    const n = tools.length + 1;
    const a = ws3.addRow(['Total', '', '', '', '', { formula: `SUM(F2:F${n})` }, { formula: `SUM(G2:G${n})` }, { formula: `SUM(H2:H${n})` }]); a.font = { bold: true };
    const b = ws3.addRow(['Longest', '', '', '', '', { formula: `MAX(F2:F${n})` }, { formula: `MAX(G2:G${n})` }, { formula: `MAX(H2:H${n})` }]); b.font = { bold: true };
  } else ws3.addRow([toolNote]);
  head(ws3);
  ws3.addRow([]);
  ws3.addRow(['Times come from the cluster (whole seconds), so a tool that ran for less than a second shows 0 or 1. Run time = container started → finished; wait = pod created → container started (scheduling, image pull).']);

  // ---- Post-processing (background worker: eks, s3, history, sharepoint, teams)
  if (post.length) {
    const ws4 = wb.addWorksheet('Post-processing');
    ws4.columns = [{ header: 'Step', width: 14 }, { header: 'Start (IST)', width: 24 }, { header: 'End (IST)', width: 24 }, { header: 'Seconds', width: 10 }, { header: 'Min:Sec', width: 11 }, { header: 'Result', width: 10 }, { header: 'Detail', width: 80 }];
    post.forEach((p) => { const sec = Math.round((p.end - p.start) / 1000); ws4.addRow([p.step, IST(p.start), IST(p.end), sec, mmss(sec), p.status, p.detail || '']); });
    const t4 = ws4.addRow(['Total', IST(postStart), IST(postEnd), Math.round((postEnd - postStart) / 1000)]); t4.font = { bold: true };
    head(ws4);
  }

  // ---- Summary (first sheet)
  ws1.columns = [{ header: 'Item', width: 38 }, { header: 'Value', width: 60 }];
  const byId = (n: string) => o.steps.find((s) => s.id.endsWith('/' + n));
  const wait = byId('12'); const waitSec = wait ? Math.round((wait.end - wait.start) / 1000) : undefined;
  const runSec = tools.reduce((a, t) => a + (t.run_s || 0), 0);
  const longest = tools.reduce<ToolTiming | undefined>((m, t) => (!m || (t.run_s || 0) > (m.run_s || 0) ? t : m), undefined);
  const kv: Array<[string, any]> = [
    ['Branch', o.branch], ['Repo', o.repo], ['Script result', o.status], ['Run id', o.runId || run.run_id || ''], ['Tenant id', run.tenant_id || ''], ['Commit', run.commit_sha || ''],
    ['', ''],
    ['Script start (IST)', IST(o.scriptStart)], ['Script end (IST)', IST(o.scriptEnd)], ['Script start (UTC)', new Date(o.scriptStart).toISOString()], ['Script end (UTC)', new Date(o.scriptEnd).toISOString()],
    ['Total time of this branch (seconds)', totalSec], ['Total time of this branch (min:sec)', mmss(totalSec)],
    ['Time waiting for the platform run, step 12 (min:sec)', waitSec === undefined ? '' : mmss(waitSec)],
    ['Browser steps recorded', o.steps.length],
    ...(post.length ? ([
      ['Post-processing start (IST)', IST(postStart)], ['Post-processing end (IST)', IST(postEnd)], ['Post-processing total (min:sec)', mmss(Math.round((postEnd - postStart) / 1000))],
      ['Whole branch incl. post-processing (min:sec)', mmss(Math.round((Math.max(postEnd, o.scriptEnd) - o.scriptStart) / 1000))],
    ] as Array<[string, any]>) : []),
    ['After the script ends', o.handedOff ? 'S3 check, SharePoint copy and Teams message continue in the background worker (not included in the total above)' : 'S3 check, SharePoint copy and Teams message ran inline or were skipped'],
    ['', ''],
    ['Platform run started (UTC)', run.started_at || ''], ['Platform run completed (UTC)', run.completed_at || ''], ['Platform run duration (seconds)', run.duration_seconds ?? ''], ['Platform run status', run.status || ''],
    ['Platform tasks total / completed / failed / skipped', run.total_tasks === undefined ? '' : `${run.total_tasks} / ${run.completed_tasks} / ${run.failed_tasks} / ${run.skipped_tasks}`], ['Overall score', run.overall_score ?? ''],
    ['', ''],
    ['Tool pods seen on EKS', tools.length || toolNote], ['Sum of tool run times (seconds)', tools.length ? runSec : ''],
    ['Longest tool', longest ? `${longest.name} (${longest.run_s ?? 0} s)` : ''],
  ];
  kv.forEach((r) => ws1.addRow(r)); head(ws1); ws1.getColumn(1).font = { bold: true };
  ws1.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  const file = path.join(o.branchDir, 'timings.xlsx');
  await wb.xlsx.writeFile(file);
  fs.writeFileSync(path.join(o.branchDir, 'timings.json'), JSON.stringify({ branch: o.branch, run_id: o.runId || run.run_id, script_start: new Date(o.scriptStart).toISOString(), script_end: new Date(o.scriptEnd).toISOString(), total_seconds: totalSec, meta: { repo: o.repo, status: o.status, handedOff: o.handedOff, scriptStart: o.scriptStart, scriptEnd: o.scriptEnd }, steps: o.steps.map((s) => ({ ...s, seconds: Math.round((s.end - s.start) / 1000) })), tools }, null, 2));
  // one line per branch for the whole round (parallel lanes append safely)
  if (o.summaryCsv !== false) try {
    const sum = path.join(o.branchDir, '..', 'timings-summary.csv');
    if (!fs.existsSync(sum)) fs.writeFileSync(sum, 'branch,status,run_id,script_start_ist,script_end_ist,total_seconds,wait_for_run_seconds,tool_pods,sum_tool_run_seconds\n');
    fs.appendFileSync(sum, [o.branch, o.status, o.runId || run.run_id || '', IST(o.scriptStart), IST(o.scriptEnd), totalSec, waitSec ?? '', tools.length, runSec].join(',') + '\n');
  } catch { /* optional */ }
  return file;
}

/** rebuild timings.xlsx from timings.json after the background worker added its step times (postprocess-times.json) */
export async function refreshTimingWorkbook(branchDir: string): Promise<void> {
  const j = readJson(path.join(branchDir, 'timings.json'));
  if (!j?.meta || !Array.isArray(j.steps)) return;
  await writeTimingWorkbook({ branchDir, branch: j.branch, repo: j.meta.repo, runId: j.run_id, status: j.meta.status, scriptStart: j.meta.scriptStart, scriptEnd: j.meta.scriptEnd, steps: j.steps, handedOff: j.meta.handedOff, summaryCsv: false });
}

/** called by the background worker: remember when each of its steps ran */
export function recordPostStep(branchDir: string, rec: { step: string; start: number; end: number; status: string; detail?: string }): void {
  try {
    const f = path.join(branchDir, 'postprocess-times.json');
    const all = readJson(f) || [];
    fs.writeFileSync(f, JSON.stringify([...all.filter((x: any) => x.step !== rec.step), rec], null, 2));
  } catch { /* optional */ }
}
