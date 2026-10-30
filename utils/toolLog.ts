import * as fs from 'fs';
import * as path from 'path';
import type { PyResult } from './pyValidate';

/**
 * One row per tool of a language for the "Tool Trigger Log" (the grid table in the Teams success card):
 *   OUTPUT         triggered and its file holds data (Output)
 *   EMPTY          triggered but empty / scanned 0 files / no data
 *   FAILED         triggered but failed
 *   SKIPPED        the tool wrote "not applicable / skipped" (the reason is in the note)
 *   NOT_TRIGGERED  expected (or optional) but there is no S3 folder
 *   OUTSIDE        ran although it must be excluded for this version
 * Tools that are excluded for the version and did not run ("N/A by design") get no row.
 */
export type ToolState = 'OUTPUT' | 'EMPTY' | 'FAILED' | 'SKIPPED' | 'NOT_TRIGGERED' | 'OUTSIDE';
export interface ToolRow { tool: string; level: string; state: ToolState; note: string }

const tidy = (s: string) => String(s || '').replace(/\s+/g, ' ').trim();

export function toolRow(tool: string, level: string, triggered: boolean, r: PyResult | null, reportedNA: boolean): ToolRow | null {
  if (level === 'NO') return triggered && !reportedNA && r && r.status !== 'FAILED' ? { tool, level, state: 'OUTSIDE', note: 'ran, but must be excluded for this version' } : null;
  if (!triggered || !r) return { tool, level, state: 'NOT_TRIGGERED', note: level === 'OPT' ? 'No S3 folder (optional)' : 'No S3 folder' };
  const note = tidy(r.note);
  if (reportedNA) return { tool, level, state: 'SKIPPED', note };
  if (r.status === 'OK' || r.status === 'CLEAN') return { tool, level, state: 'OUTPUT', note };
  if (r.status === 'FAILED') return { tool, level, state: 'FAILED', note };
  return { tool, level, state: 'EMPTY', note };
}

const ICON: Record<ToolState, string> = { OUTPUT: '✅', EMPTY: '❌', FAILED: '❌', SKIPPED: '⚠️', NOT_TRIGGERED: '❌', OUTSIDE: '⚠️' };

/** "Triggered 31/33 · Output 24 · Empty 4 · Failed 3 · Skipped 2 · Not triggered 2" */
export function toolLogCounts(rows: ToolRow[]): string {
  const n = (s: ToolState) => rows.filter((r) => r.state === s).length;
  const trig = rows.filter((r) => r.state !== 'NOT_TRIGGERED').length;
  return [`Triggered ${trig}/${rows.length}`, `Output ${n('OUTPUT')}`, n('EMPTY') ? `Empty ${n('EMPTY')}` : '', n('FAILED') ? `Failed ${n('FAILED')}` : '', n('SKIPPED') ? `Skipped ${n('SKIPPED')}` : '', n('NOT_TRIGGERED') ? `Not triggered ${n('NOT_TRIGGERED')}` : '', n('OUTSIDE') ? `Outside matrix ${n('OUTSIDE')}` : ''].filter(Boolean).join(' · ');
}

// ---------------- the earlier run of the same branch, read from SharePoint ----------------
const RUN_DIR = /^merge-flow_(dev_)?(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})/;
/** dd/mm/yyyy (and hh:mm) of a run folder such as results/merge-flow_2026-10-29_1127_acct2 */
export function runStamp(runDirName: string): { date: string; time: string; sortKey: string } | null {
  const m = RUN_DIR.exec(runDirName); if (!m) return null;
  return { date: `${m[4]}/${m[3]}/${m[2]}`, time: `${m[5]}:${m[6]}`, sortKey: `${m[1] || ''}${m[2]}${m[3]}${m[4]}${m[5]}${m[6]}` };
}
export interface PreviousRun { label: string; date: string; time: string; rows: Map<string, ToolRow> }

/**
 * The earlier run of this branch for one language. It does NOT look at other result folders on this PC: it reads
 * <branch folder>/previous-tools.json, which the worker writes from the team's SharePoint evidence folder just before the Teams card
 * (utils/sharepointHistory.ts). No file, or no rows for this language: null (the card then has no comparison).
 */
export function previousRun(branchDir: string, langKey: string): PreviousRun | null {
  try {
    const f = path.join(branchDir, 'previous-tools.json'); if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8')); const rows: ToolRow[] | undefined = j?.langs?.[langKey];
    if (!rows?.length) return null;
    return { label: String(j.date), date: String(j.date), time: String(j.time || ''), rows: new Map(rows.map((r) => [r.tool, r])) };
  } catch { return null; }
}

// ---------------- the Adaptive Card elements ----------------
const cell = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'TableCell', items: [{ type: 'TextBlock', text, ...extra }] });
const head = (text: string) => cell(text, { weight: 'Bolder', wrap: true });

/**
 * A grid table like the manual "Tool Trigger Log": # | Tool | Triggered (earlier run) | Triggered (this run) | S3 output (earlier -> this) | Tool output.
 * Without an earlier run the two Triggered columns become one and the arrow disappears. Needs Adaptive Card 1.5 (Table element).
 */
export function toolLogElements(languageName: string, branch: string, rows: ToolRow[], noteMax = 70, prev?: PreviousRun | null, thisRunDir = ''): unknown[] {
  if (!rows.length) return [];
  const cut = (s: string) => (noteMax <= 0 ? '' : s.length > noteMax ? s.slice(0, noteMax - 1).trimEnd() + '…' : s);
  const st = runStamp(thisRunDir);
  const thisDate = st ? st.date : 'this run';
  const sameDay = !!(prev && st && prev.date === st.date); // two runs on one day: add the time so the headers differ
  const pLab = prev ? (sameDay ? `${prev.date} ${prev.time}` : prev.date) : ''; const tLab = st ? (sameDay ? `${st.date} ${st.time}` : thisDate) : thisDate;
  const trig = (s?: ToolState) => (s === undefined ? '–' : s === 'NOT_TRIGGERED' ? '❌' : '✅');
  const out = (s?: ToolState) => (s === undefined ? '–' : ICON[s]);
  const cols = prev ? [{ width: 1 }, { width: 5 }, { width: 3 }, { width: 3 }, { width: 3 }, { width: 9 }] : [{ width: 1 }, { width: 5 }, { width: 3 }, { width: 3 }, { width: 9 }];
  const header = prev
    ? [head('#'), head('Tool'), head(`Triggered ${pLab}`), head(`Triggered ${tLab}`), head(`S3 output (${pLab} → ${tLab})`), head('Tool output')]
    : [head('#'), head('Tool'), head(`Triggered ${tLab}`), head('S3 output'), head('Tool output')];
  const body = rows.map((r, i) => {
    const p = prev ? prev.rows.get(r.tool)?.state : undefined;
    const detail = cut(r.note) || (r.state === 'OUTPUT' ? 'Output' : '');
    return prev
      ? [cell(String(i + 1)), cell(r.tool, { wrap: true }), cell(trig(p)), cell(trig(r.state)), cell(`${out(p)} → ${out(r.state)}`), cell(detail, { wrap: true })]
      : [cell(String(i + 1)), cell(r.tool, { wrap: true }), cell(trig(r.state)), cell(out(r.state)), cell(detail, { wrap: true })];
  });
  return [
    { type: 'TextBlock', text: `**Tool Trigger Log: ${languageName}** (branch ${branch})`, wrap: true, spacing: 'Medium', weight: 'Bolder' },
    { type: 'TextBlock', text: toolLogCounts(rows) + (prev ? ` · compared with the run of ${pLab}` : ' · no earlier run of this branch on SharePoint to compare with'), wrap: true, spacing: 'None', isSubtle: true, size: 'Small' },
    { type: 'Table', columns: cols, showGridLines: true, firstRowAsHeader: true, spacing: 'Small', rows: [header, ...body].map((cells) => ({ type: 'TableRow', cells })) },
  ];
}
