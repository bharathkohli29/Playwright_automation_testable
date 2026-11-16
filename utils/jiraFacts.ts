import * as fs from 'fs';
import * as path from 'path';

/**
 * Everything the Jira step needs about one branch run, read from the files the run already wrote (s3-check.json, run-details.json, repo-details.json,
 * bugs/bugs.json, eks-live/services.log, s3-evidence/<tool>/.../failure.json, RCA Report/index.json). Nothing is fetched; nothing is written.
 */
export interface Placement { tool: string; version?: string; reason: string; detail: string; coupling?: string; via: 'tools_unplaceable' | 'compatibility_excluded' }
export interface BugFact {
  tool: string; tag: string; observed: string; note: string; kind: string; metrics: string;
  summary?: string; placement?: Placement; failure?: { reason: string; errorCode: string; version: string };
  defectPdf?: string; rcaPdf?: string; screenshot?: string;
}
export interface RunFacts {
  dir: string; language: string; langKey: string; version: string; branch: string; runId: string; short: string; repo: string; commit: string;
  buildLine: string; runLine: string; cluster: string; bugs: BugFact[]; notBugs: { tool: string; why: string }[]; placementOnly: Placement[]; okTools: number; expected: number;
  fullVersion: string; date: string; rows: ToolRowFact[]; taxonomyHtml?: string; prior?: PriorRun; resultsXlsx?: string;
}
export interface ToolRowFact { tool: string; kind: string; state: string; verdict: string; metrics: string; note: string }
export interface PriorRun { short: string; ok: number; expected: number; date: string }

const LANGS: [string, string][] = [['java', 'Java'], ['csharp', 'C#'], ['typescript', 'TypeScript'], ['javascript', 'JavaScript'], ['python', 'Python']];
const readJson = (f: string): any => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** planning.tools_unplaceable / planning.compatibility_excluded lines of the orchestrator log -> reason per tool */
export function parsePlacements(servicesLog: string): { map: Map<string, Placement>; cell: string } {
  const map = new Map<string, Placement>(); let cell = '';
  for (const line of servicesLog.split(/\r?\n/)) {
    if (!line.includes('tools_unplaceable') && !line.includes('compatibility_excluded')) continue;
    const i = line.indexOf('{"'); if (i < 0) continue;
    let j: any; try { j = JSON.parse(line.slice(i)); } catch { continue; }
    if (j.cell_id && !cell) cell = `${j.cell_id}${j.fabric_id ? ` (${j.fabric_id})` : ''}`;
    if (j.message === 'planning.tools_unplaceable') for (const t of j.tools || []) if (t?.tool) map.set(String(t.tool), { tool: String(t.tool), version: t.toolVersion ? String(t.toolVersion) : undefined, reason: String(t.reason || ''), detail: String(t.detail || '').replace(/_/g, ' '), via: 'tools_unplaceable', coupling: /(DECOUPLED|TARGET_COMPATIBLE)/.exec(String(t.detail || ''))?.[1] });
    if (j.message === 'planning.compatibility_excluded') for (const t of j.excluded || []) if (t?.tool_name && !map.has(String(t.tool_name))) map.set(String(t.tool_name), { tool: String(t.tool_name), version: t.tool_version ? String(t.tool_version) : undefined, reason: String(t.reason || ''), detail: String(t.detail || ''), coupling: t.runtime_coupling ? String(t.runtime_coupling) : undefined, via: 'compatibility_excluded' });
  }
  return { map, cell };
}

function failureOf(dir: string, tool: string): BugFact['failure'] | undefined {
  try {
    const root = path.join(dir, 's3-evidence', tool); if (!fs.existsSync(root)) return undefined;
    const walk = (d: string): string | undefined => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { const r = walk(p); if (r) return r; } else if (e.name === 'failure.json') return p; } return undefined; };
    const f = walk(root); if (!f) return undefined; const j = readJson(f); if (!j) return undefined;
    return { reason: String(j.reason || ''), errorCode: String(j.error_code || ''), version: String(j.tool_version || '') };
  } catch { return undefined; }
}

const dmy = (iso: string): string => { const d = new Date(iso); if (isNaN(d.getTime())) return ''; const p = (n: number) => String(n).padStart(2, '0'); return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`; };

/** the newest EARLIER run of the same branch (results/<round>/<branch>/s3-check.json): used for "the earlier run had n/m tools OK" */
export function priorRun(dir: string, branch: string, langKey: string, runId: string): PriorRun | undefined {
  try {
    const round = path.dirname(dir); const root = path.dirname(round); const me = path.basename(round);
    for (const r of fs.readdirSync(root).filter((x) => x.startsWith('merge-flow_') && x < me).sort().reverse()) {
      const f = path.join(root, r, branch, 's3-check.json'); if (!fs.existsSync(f)) continue;
      const j = readJson(f); const b = j?.[langKey]; if (!b?.version || !j.run_id || String(j.run_id) === runId) continue; // a re-analysis of the SAME run is not an earlier run
      return { short: String(j.run_id).slice(0, 8), ok: (b.ok || 0) + (b.clean || 0), expected: b.expected || 0, date: r.replace(/^merge-flow_/, '').slice(0, 10) };
    }
  } catch { /* no history */ }
  return undefined;
}

export function collectFacts(dir: string): RunFacts | null {
  const s3 = readJson(path.join(dir, 's3-check.json')); if (!s3) return null;
  const hit = LANGS.find(([k]) => s3[k]?.version); if (!hit) return null;
  const [langKey, language] = hit; const blk = s3[langKey];
  const run = readJson(path.join(dir, 'run-details.json')) || {}; const repoD = readJson(path.join(dir, 'repo-details.json')) || {};
  const bugsJson = readJson(path.join(dir, 'bugs', 'bugs.json')); const idx = new Map<string, any>((bugsJson?.bugs || []).map((b: any) => [String(b.tool), b]));
  const rcaIdx = readJson(path.join(dir, 'RCA Report', 'index.json')); const rcaFile = new Map<string, string>((rcaIdx?.reports || []).map((r: any) => [String(r.tool), String(r.file)]));
  let pl = { map: new Map<string, Placement>(), cell: '' };
  try { pl = parsePlacements(fs.readFileSync(path.join(dir, 'eks-live', 'services.log'), 'utf8')); } catch { /* no live capture */ }
  const rows: any[] = Array.isArray(blk.tools) ? blk.tools : []; const rowOf = (t: string) => rows.find((r) => r.tool === t);
  const defects: any[] = blk.defects || [];
  const bugs: BugFact[] = defects.map((d) => {
    const b = idx.get(String(d.tool)); const r = rowOf(String(d.tool)); const rca = rcaFile.get(String(d.tool));
    const tag = String(d.tag || '').replace(/[\[\]]/g, '');
    return {
      tool: String(d.tool), tag, observed: String(d.observed || ''), note: String(d.note || ''), kind: String(r?.kind || ''), metrics: String(r?.metrics || ''), summary: b?.summary,
      placement: /Planning/i.test(tag) ? pl.map.get(String(d.tool)) : undefined, failure: /Runner/i.test(tag) || d.observed === 'FAILED' ? failureOf(dir, String(d.tool)) : undefined,
      defectPdf: b?.pdf ? path.join(dir, 'bugs', b.pdf) : undefined, screenshot: b?.screenshot ? path.join(dir, 'bugs', b.screenshot) : undefined,
      rcaPdf: rca && fs.existsSync(path.join(dir, 'RCA Report', rca)) ? path.join(dir, 'RCA Report', rca) : undefined,
    };
  });
  const bugTools = new Set(bugs.map((b) => b.tool));
  const expectedTools = new Set(rows.map((r) => String(r.tool)));
  const placementOnly = [...pl.map.values()].filter((p) => !bugTools.has(p.tool) && expectedTools.has(p.tool)); // only tools of our matrix (not e.g. trufflehog)
  const taxFile = fs.existsSync(dir) ? fs.readdirSync(dir).find((x) => /^taxonomy-gate-.*\.html$/i.test(x) && !/with-ui-values/i.test(x)) : undefined;
  const branchName = String(s3.branch || run.branch_name || '');
  return {
    fullVersion: String(repoD['Language version'] || blk.version), date: dmy(String(run.completed_at || run.created_at || '')) || dmy(new Date().toISOString()),
    rows: rows.map((r) => ({ tool: String(r.tool), kind: String(r.kind || ''), state: String(r.state || ''), verdict: String(r.verdict || ''), metrics: String(r.metrics || ''), note: String(r.note || '') })),
    taxonomyHtml: taxFile ? path.join(dir, taxFile) : undefined, prior: priorRun(dir, branchName, langKey, String(s3.run_id || run.run_id || '')),
    dir, language, langKey, version: String(blk.version), branch: String(s3.branch || run.branch_name || ''), runId: String(s3.run_id || run.run_id || ''), short: String(s3.run_id || run.run_id || '').slice(0, 8),
    repo: String(s3.repo || ''), commit: String(s3.commit_sha || run.commit_sha || ''),
    buildLine: [repoD['Project type'], repoD['Language version'] ? `${language} ${repoD['Language version']}` : '', repoD['Language'] ? `(${repoD['Language']})` : '', repoD['Files'], repoD['Repository size']].filter(Boolean).join(' · '),
    runLine: run.status ? `${run.status} · ${run.completed_tasks ?? '?'}/${run.total_tasks ?? '?'} tasks completed · ${run.failed_tasks ?? 0} failed${run.overall_score != null ? ` · score ${run.overall_score}` : ''}${run.duration_seconds ? ` · ${run.duration_seconds} s` : ''}` : '',
    cluster: pl.cell ? `qa-eks · ${pl.cell}` : 'qa-eks', bugs, notBugs: Array.isArray(blk.notBugs) ? blk.notBugs.map((n: any) => ({ tool: String(n.tool), why: String(n.why || '') })) : [], placementOnly,
    okTools: (blk.ok || 0) + (blk.clean || 0), expected: blk.expected || 0,
  };
}
