import * as fs from 'fs';
import * as path from 'path';

/**
 * Python tool validation for the S3 evidence of a PYTHON branch (Build type "Python" in repo-details.json).
 * Rules come from PROMPT_Python_Tool_Trigger_Analysis.md (version matrix + what each tool's file must hold) and
 * PROMPT_Python_Tool_Bug_Classification_and_Filing.md (which situations are bugs).
 *
 * It only READS the evidence that is already saved next to the branch (s3-evidence/) and adjusts the tool rows of the
 * existing S3 check (the "Tool / JSON" and "S3 comment" columns of the taxonomy report). It never fails a run.
 *
 *  N/A by design      tool is not meant to run on this Python version                      → no bug
 *  [Planning Defect]  tool is required for this version but there is no folder for it       → bug
 *  [False Empty]      tool wrote an empty file although it scanned 0 files                  → bug
 *  clean              empty result, but files were scanned                                  → no bug
 *  [Language Contamination]  a tool of another language ran on the Python branch            → bug
 */
export type PyStatus = 'OK' | 'CLEAN' | 'FALSE_EMPTY' | 'EMPTY_UNKNOWN' | 'NO_DATA' | 'FAILED';

const BASE = ['radon', 'lizard', 'jscpd-py', 'git-churn', 'pydriller', 'flake8', 'safety', 'semgrep', 'semgrep-perf-static', 'presidio', 'semgrep-pii', 'gitleaks', 'detect-secrets'];
const FROM38 = ['pip-audit', 'pip-outdated', 'py-all-defs-uses', 'py-coverage-delta'];
const PARSER38_312 = ['pylint', 'bandit', 'complexipy', 'python-perf-dependency'];
const EXEC39 = ['coverage-py', 'crosshair', 'cosmic-ray'];
const RETIRED = ['testmon'];
const FIXTURES = ['cert-delay', 'cert-retry'];
export const PY_TOOLS = [...BASE, ...FROM38, ...PARSER38_312, ...EXEC39, 'pymcdc', ...RETIRED, ...FIXTURES];

const nn = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** other folder names a tool is saved under */
const ALIAS: Record<string, string[]> = { 'py-coverage-delta': ['coverage_delta', 'coverage-delta'], 'git-churn': ['git_churn'], 'detect-secrets': ['detect_secrets'], 'pip-outdated': ['pip_outdated'], 'pip-audit': ['pip_audit'] };
const PLATFORM_FOLDERS = ['_shared', 'github-access-control', 'github_branch_protection', 'github-branch-protection'].map(nn);
const FOREIGN = /^(eslint|ts-|js-|jscpd-(js|ts)|npm|nyc|stryker|madge|dependency-cruiser|checkstyle|spotbugs|pmd|jacoco|pitest|roslyn|coverlet|dotnet|cyclonedx-npm|license-checker|javascript-|typescript-|java-|csharp-|cs-|knip|oxlint|biome|vitest|jest|maven|gradle|nuget)/i;

export interface PyVersion { major: number; minor: number; label: string }

/** Python branch? → its version (e.g. "3.11.13" → 3.11). null = not a Python branch / version unknown → the old logic stays. */
export function pyVersion(bd: string): PyVersion | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(bd, 'repo-details.json'), 'utf8'));
    if (!/^python$/i.test(String(j['Build type'] || '').trim())) return null;
    const m = /(\d+)\.(\d+)/.exec(String(j['Language version'] || ''));
    if (!m) return null;
    const v = { major: Number(m[1]), minor: Number(m[2]), label: `${m[1]}.${m[2]}` };
    return v.major === 3 && v.minor >= 7 && v.minor <= 13 ? v : null;
  } catch { return null; }
}

/** Why a tool is NOT expected on this Python version (null = it is expected). */
export function notExpectedReason(tool: string, v: PyVersion): string | null {
  const n = v.minor; const L = v.label;
  if (RETIRED.includes(tool)) return 'retired from the active production plan';
  if (FIXTURES.includes(tool)) return 'pipeline test fixture, not a validation tool';
  if (FROM38.includes(tool) && n < 8) return `parserCompatibility minimum is 3.8 (PARSER_COMPATIBILITY_MISMATCH on ${L})`;
  if (PARSER38_312.includes(tool) && n < 8) return `parserCompatibility is 3.8–3.12 (PARSER_COMPATIBILITY_MISMATCH on ${L})`;
  if (PARSER38_312.includes(tool) && n > 12) return `parserCompatibility is 3.8–3.12 — ${L} is above the maximum (PARSER_COMPATIBILITY_MISMATCH)`;
  if (EXEC39.includes(tool) && n < 8) return `executes customer code: parser minimum is 3.8 and the cluster has no ${L} execution image (CUSTOMER_CODE_INCOMPATIBLE_WITH_EXECUTION_ENV)`;
  if (EXEC39.includes(tool) && n === 8) return 'executes customer code: the cluster has no Python 3.8 execution image (CUSTOMER_CODE_INCOMPATIBLE_WITH_EXECUTION_ENV)';
  if (tool === 'pymcdc' && n < 10) return `executes customer code and needs host runtime 3.10+ (not available on ${L})`;
  return null;
}

export function expectedTools(v: PyVersion): string[] {
  const ign = (process.env.PY_IGNORE_TOOLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return PY_TOOLS.filter((t) => !notExpectedReason(t, v) && !ign.includes(t));
}

// ---------- reading the saved evidence ----------
type FileMap = Record<string, any>; // file name → parsed json (or raw text)

function folderFor(inventoryFolders: string[], tool: string): string | undefined {
  const want = [tool, ...(ALIAS[tool] || [])].map(nn);
  return inventoryFolders.find((f) => want.includes(nn(f.replace(/\/$/, ''))));
}

/** all json files saved for one tool folder: name → parsed (first task folder with data wins per name) */
function loadTool(bd: string, folder: string): FileMap {
  const out: FileMap = {};
  const root = path.join(bd, 's3-evidence', folder.replace(/\/$/, ''));
  const walk = (d: string) => {
    let es: fs.Dirent[] = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      let size = 0; try { size = fs.statSync(f).size; } catch { /* ignore */ }
      let val: any = { __size: size };
      if (/\.(json)$/i.test(e.name) && size < 40_000_000) { try { val = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { val = { __size: size, __invalid: true }; } }
      else if (/\.(txt|xml|jsonl)$/i.test(e.name)) val = { __size: size, __text: true };
      const prev = out[e.name];
      if (prev === undefined || (isBlank(prev) && !isBlank(val))) out[e.name] = val;
    }
  };
  walk(root);
  return out;
}
const isBlank = (v: any): boolean => v === null || v === undefined || v === '' || v === 0 || v === false
  || (Array.isArray(v) && v.every(isBlank)) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).filter((k) => !k.startsWith('__')).every((k) => isBlank(v[k])) && !('__size' in v && v.__size > 2 && v.__text));
const len = (v: any) => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0);
const num = (v: any): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export interface PyResult { status: PyStatus; note: string; scanned?: number }
const R = (status: PyStatus, note: string, scanned?: number): PyResult => ({ status, note, scanned });
const clean = (what: string, scanned: number) => R('CLEAN', `clean code — ${what}, ${scanned} file(s) scanned`, scanned);
const falseEmpty = (what: string) => R('FALSE_EMPTY', `${what} — 0 files scanned although the repo has .py files`, 0);
const unknown = (what: string) => R('EMPTY_UNKNOWN', `${what} (scan count unknown)`);

/** What the tool's main file(s) must hold (PROMPT_Python_Tool_Trigger_Analysis, step 3) and whether an empty result is clean or false-empty. */
export function checkTool(tool: string, f: FileMap): PyResult {
  const main = (name: string) => f[name];
  const status = (j: any) => (j && typeof j === 'object' && !Array.isArray(j) ? String(j.status ?? '') : '');
  // the tool itself says it failed / was skipped
  for (const [name, j] of Object.entries(f)) {
    if (/^failure\.json$/i.test(name)) return R('FAILED', `failure.json — ${String((j as any)?.error || (j as any)?.message || (j as any)?.reason || JSON.stringify(j)).replace(/\s+/g, ' ').slice(0, 220)}`);
  }
  switch (tool) {
    case 'pylint': {
      const j = main('pylint.json'); if (j === undefined) return R('NO_DATA', 'pylint.json is missing');
      const meta = main('pylint_meta.json'); const files = num(meta?.files);
      const msgs = Array.isArray(j) ? j : Array.isArray(j?.messages) ? j.messages : [];
      if (msgs.length) return R('OK', `${msgs.length} message(s)${files ? ` in ${files} file(s)` : ''}`, files);
      if (files && files > 0) return clean('0 messages', files);
      return files === 0 ? falseEmpty('pylint.json is []') : unknown('pylint.json is []');
    }
    case 'radon': {
      const cc = main('radon_cc.json'); const mi = main('radon_mi.json');
      if (cc === undefined) return R('NO_DATA', 'radon_cc.json is missing');
      const files = len(cc);
      if (!files) return falseEmpty('radon_cc.json is {}');
      const fns = Object.values(cc as any).reduce((a: number, v: any) => a + (Array.isArray(v) ? v.length : 0), 0);
      if (mi !== undefined && !len(mi)) return R('NO_DATA', `radon_mi.json is empty (cc has ${files} files)`);
      return R('OK', `cc for ${files} file(s), ${fns} block(s)${mi ? `; MI for ${len(mi)} file(s)` : ''}`, files);
    }
    case 'lizard': {
      const j = main('lizard.json'); if (j === undefined) return R('NO_DATA', 'lizard.json is missing');
      const n = len(j); return n ? R('OK', `${n} file entr${n === 1 ? 'y' : 'ies'}`, n) : falseEmpty('lizard.json is empty');
    }
    case 'complexipy': {
      const j = main('complexipy.json'); if (j === undefined) return R('NO_DATA', 'complexipy.json is missing');
      const n = len(j); return n ? R('OK', `${n} function score(s)`) : unknown('complexipy.json is empty');
    }
    case 'coverage-py': {
      const j = main('coverage.json'); if (j === undefined) return R('NO_DATA', 'coverage.json is missing');
      const t = j?.totals; const stm = num(t?.num_statements); const pct = t?.percent_covered;
      if (t && stm && stm > 0 && pct !== undefined) return R('OK', `${Number(pct).toFixed(1)}% of ${stm} statements covered`, len(j.files));
      return R('NO_DATA', 'coverage.json has no statements measured (totals empty / 0)');
    }
    case 'pip-audit': {
      const j = main('pip_audit.json'); if (j === undefined) return R('NO_DATA', 'pip_audit.json is missing');
      const n = len(j?.dependencies); return n ? R('OK', `${n} dependenc${n === 1 ? 'y' : 'ies'} audited`, n) : unknown('pip_audit.json has no dependencies');
    }
    case 'pip-outdated': {
      const j = main('pip_outdated.json'); if (j === undefined) return R('NO_DATA', 'pip_outdated.json is missing');
      const n = num(j?.compared) ?? num(j?.measured) ?? len(j?.packages ?? j?.all);
      return n ? R('OK', `${n} package(s) compared`, n) : unknown('pip_outdated.json compared 0 packages');
    }
    case 'py-all-defs-uses': {
      const j = main('defs_uses.json'); if (j === undefined) return R('NO_DATA', 'defs_uses.json is missing');
      const defs = num(j?.defs) ?? len(j?.defs); const uses = num(j?.uses) ?? len(j?.uses); const fs_ = num(j?.files_scanned) ?? len(j?.files_scanned ?? j?.files);
      if (defs || uses) return R('OK', `${defs} definition(s), ${uses} use(s)`, fs_ || undefined);
      return fs_ ? clean('no definitions/uses found', fs_) : falseEmpty('defs_uses.json has no definitions or uses');
    }
    case 'py-coverage-delta': {
      const j = main('coverage_delta.json'); if (j === undefined) return R('NO_DATA', 'coverage_delta.json is missing');
      if (j?.baseline_missing) return R('NO_DATA', `baseline_missing (${j?.git?.status || 'no baseline commit'}) — current ${j.current_covered}/${j.current_total} lines; delta needs a baseline`);
      return R('OK', `current ${j.current_covered}/${j.current_total} lines covered`);
    }
    case 'pymcdc': {
      const j = main('pymcdc.json'); if (j === undefined) return R('NO_DATA', 'pymcdc.json is missing');
      if (/^ok$/i.test(status(j)) && num(j.total) && num(j.total)! > 0) return R('OK', `${j.covered}/${j.total} conditions covered (${j.decisions ?? '?'} decisions)`);
      return R('NO_DATA', `status=${status(j) || '?'}${j?.detail_code ? ` (${j.detail_code})` : ''}, ${j?.total ?? 0} conditions`);
    }
    case 'crosshair': {
      const j = main('crosshair.json'); if (j === undefined) return R('NO_DATA', 'crosshair.json is missing');
      if (j?.skipped) return R('NO_DATA', `skipped${j?.reason ? ` — ${j.reason}` : ''}`);
      return num(j?.total_functions_checked) ? R('OK', `${j.total_functions_checked} function(s) checked, path integrity ${j.execution_path_integrity_pct ?? '?'}%`) : R('NO_DATA', 'crosshair checked 0 functions');
    }
    case 'cosmic-ray': {
      const j = main('cosmic_ray.json'); const dump = main('cosmic_ray_dump.jsonl');
      if (j === undefined) return R('NO_DATA', 'cosmic_ray.json is missing');
      const dumpSize = num(dump?.__size) || 0;
      return j?.dump_ok || dumpSize > 0 ? R('OK', `mutation dump written (${Math.round(dumpSize / 1024)} KB)${j?.partial ? ', partial' : ''}`) : R('NO_DATA', 'no mutation results written');
    }
    case 'jscpd-py': {
      const j = main('jscpd-report.json'); if (j === undefined) return R('NO_DATA', 'jscpd-report.json is missing');
      const src = num(j?.statistics?.total?.sources);
      return src ? R('OK', `${j.statistics.total.lines} lines, ${j.statistics.total.clones ?? 0} clone(s) in ${src} source(s)`, src) : falseEmpty('jscpd analysed 0 sources');
    }
    case 'semgrep': case 'semgrep-perf-static': case 'semgrep-pii': {
      const name = tool === 'semgrep' ? 'semgrep.json' : tool === 'semgrep-pii' ? 'semgrep-pii-results.json' : 'semgrep-perf-static.json';
      const j = main(name); if (j === undefined) return R('NO_DATA', `${name} is missing`);
      const n = len(j?.results); const sc = len(j?.paths?.scanned);
      if (n) return R('OK', `${n} finding(s)${sc ? ` in ${sc} file(s)` : ''}`, sc || undefined);
      return sc ? clean('0 findings', sc) : unknown(`${name} has 0 results`);
    }
    case 'bandit': {
      const j = main('bandit.json'); if (j === undefined) return R('NO_DATA', 'bandit.json is missing');
      const n = len(j?.results); const loc = num(j?.metrics?._totals?.loc);
      if (n) return R('OK', `${n} finding(s)`);
      return loc ? clean(`0 findings, ${loc} lines`, 1) : unknown('bandit.json has 0 results');
    }
    case 'pydriller': {
      const j = main('pydriller.json'); if (j === undefined) return R('NO_DATA', 'pydriller.json is missing');
      return num(j?.commit_count) ? R('OK', `${j.commit_count} commit(s), ${j.author_count ?? '?'} author(s)`) : unknown('pydriller.json has 0 commits');
    }
    case 'git-churn': {
      const j = main('git_churn.json'); if (j === undefined) return R('NO_DATA', 'git_churn.json is missing');
      return len(j?.files) ? R('OK', `${len(j.files)} file(s) with churn`) : unknown('git_churn.json has no files');
    }
    case 'gitleaks': {
      const j = main('gitleaks.json') ?? main('gitleaks-head.json'); if (j === undefined) return R('NO_DATA', 'gitleaks json is missing');
      return Array.isArray(j) && j.length ? R('OK', `${j.length} secret finding(s)`) : R('CLEAN', 'clean — 0 secrets found');
    }
    case 'detect-secrets': {
      const j = main('detect_secrets.json') ?? main('detect-secrets-baseline.json'); if (j === undefined) return R('NO_DATA', 'detect-secrets json is missing');
      const n = Object.values(j?.results || {}).reduce((a: number, v: any) => a + (Array.isArray(v) ? v.length : 0), 0);
      return n ? R('OK', `${n} secret finding(s)`) : j?.plugins_used ? R('CLEAN', 'clean — 0 secrets found') : unknown('detect-secrets output is empty');
    }
    case 'presidio': {
      const j = main('presidio-results.json'); if (j === undefined) return R('NO_DATA', 'presidio-results.json is missing');
      const n = len(j?.findings); return n ? R('OK', `${n} PII finding(s)`) : j?.summary ? R('CLEAN', 'clean — 0 PII findings') : unknown('presidio-results.json is empty');
    }
    case 'python-perf-dependency': {
      const j = main('perf-dependency-python.json'); if (j === undefined) return R('NO_DATA', 'perf-dependency-python.json is missing');
      return Object.keys(j).some((k) => /^perf_dependency\./.test(k)) ? R('OK', 'dependency metrics computed') : unknown('no perf_dependency metrics');
    }
    default: {
      const names = Object.keys(f).filter((k) => !k.startsWith('__'));
      const data = names.filter((k) => !isBlank(f[k]));
      return data.length ? R('OK', `has data (${data.slice(0, 3).join(', ')})`) : unknown(names.length ? 'all files empty' : 'no files');
    }
  }
}

// ---------- applying it ----------
export interface PySummary {
  version: string; expected: number; ok: number; clean: number; empty: number; falseEmpty: number; failed: number;
  missing: string[]; naByDesign: string[]; outsideMatrix: string[]; contamination: string[];
  defects: PyDefect[]; // platform bugs found (the only ones a bug report is written for) — see bugReport.ts
  repoDefects: string[]; // failed because of the customer repo: flagged, never filed against the platform
}
export interface PyDefect { tool: string; tag: '[Planning Defect]' | '[False Empty Defect]' | '[Runner Execution Defect]' | '[Language Contamination]'; observed: string; note: string; folder?: string; ranOutsideMatrix?: boolean }
const sev = (s: PyStatus) => (s === 'FAILED' ? 5 : s === 'FALSE_EMPTY' ? 4 : s === 'NO_DATA' ? 3 : s === 'EMPTY_UNKNOWN' ? 2 : s === 'CLEAN' ? 1 : 0);

/** classify a failed tool: customer repo problem vs platform (PROMPT_Python_Tool_Bug_Classification_and_Filing, section 2) */
function failureKind(note: string): { tag: string; repo: boolean } {
  if (/ModuleNotFoundError|ImportError|No module named|AssertionError|test(s)? failed|SyntaxError in (customer|repo)/i.test(note)) return { tag: '[Repo Defect — not a platform bug]', repo: true };
  if (/command not found|not found in PATH|No such file or directory.*bin|binary|Traceback|timed? ?out|timeout|permanent_runner_error|OOM|killed/i.test(note)) return { tag: '[Runner Execution Defect]', repo: false };
  return { tag: '[Failed — cause unknown, check the tool log]', repo: false };
}

/**
 * Adjusts the S3 check rows of a Python branch in place and returns the summary shown in the report / terminal.
 * rows: the rows written to s3-check.json. inventory: tool folder → files (s3-folders.json).
 */
export function validatePython(bd: string, rows: any[], inventory: Record<string, string[]>): PySummary | null {
  const v = pyVersion(bd); if (!v) return null;
  const folders = Object.keys(inventory);
  const expected = expectedTools(v);

  // 1) rows of the taxonomy report
  for (const row of rows) {
    if (row.language !== 'python') continue;
    const prim: string[] = String(row.primary || '').split(' + ').map((s) => s.trim()).filter((s) => s && s !== '(N/A)');
    const notFound = row.result === 'FAIL' && /not triggered — no folder/.test(row.note || '');
    if (notFound) {
      const names = prim.length ? prim : String(row.tool || '').split(/ \+ | \/ /).map((s) => s.trim());
      const real = names.filter((n) => PY_TOOLS.includes(n));
      if (!real.length) continue; // guessed / non-Python name — nothing to judge
      const reasons = real.map((t) => ({ t, why: notExpectedReason(t, v) }));
      if (reasons.every((r) => r.why)) {
        row.result = 'NA';
        row.note = `N/A for Python ${v.label} by design — ${reasons.map((r) => `${r.t}: ${r.why}`).join('; ')} (not a bug)`;
        row.files = [];
      } else {
        const miss = reasons.filter((r) => !r.why).map((r) => r.t);
        row.note = `[Planning Defect] ${miss.join(', ')} is expected for Python ${v.label} but was not triggered — no folder in the run${reasons.some((r) => r.why) ? ` (${reasons.filter((r) => r.why).map((r) => `${r.t} is N/A by design`).join('; ')})` : ''}`;
      }
      continue;
    }
    // evidence exists → judge what it holds
    const toolNames = String(row.tool || '').split(' + ').map((s) => s.trim()).filter((t) => PY_TOOLS.includes(t));
    if (!toolNames.length || !(row.files || []).length && row.result === 'FAIL') continue;
    const parts: { t: string; r: PyResult }[] = [];
    for (const t of toolNames) {
      const fo = folderFor(folders, t); if (!fo) continue;
      parts.push({ t, r: checkTool(t, loadTool(bd, fo)) });
    }
    if (!parts.length) continue;
    const worst = parts.reduce((a, b) => (sev(b.r.status) > sev(a.r.status) ? b : a));
    const best = parts.reduce((a, b) => (sev(b.r.status) < sev(a.r.status) ? b : a));
    const text = parts.map((p) => (parts.length > 1 ? `${p.t}: ` : '') + p.r.note).join('  +  ');
    const outside = toolNames.filter((t) => notExpectedReason(t, v));
    const pre = outside.length ? `[Planning Defect — ${outside.join(', ')} ran although it must be excluded on Python ${v.label}] ` : '';
    if (outside.length) { row.result = 'FAIL'; row.note = `${pre}${text}`; }
    else if (parts.every((p) => p.r.status === 'OK' || p.r.status === 'CLEAN')) { row.result = 'PASS'; row.note = `${pre}${text}`; }
    else if (parts.some((p) => p.r.status === 'FAILED')) { const f = parts.find((p) => p.r.status === 'FAILED')!; const k = failureKind(f.r.note); row.result = k.repo ? 'EMPTY' : 'FAIL'; row.note = `${pre}${k.tag} ${text}`; }
    else if (worst.r.status === 'FALSE_EMPTY' && best.r.status !== 'OK') { row.result = 'FAIL'; row.note = `${pre}[False Empty Defect] ${text}`; }
    else if (best.r.status === 'OK' || best.r.status === 'CLEAN') { row.result = 'PASS'; row.note = `${pre}${text}`; }
    else { row.result = 'EMPTY'; row.note = `${pre}${text}`; }
  }

  // 2) whole-run summary: every expected tool, independent of the table rows
  const sum: PySummary = { version: v.label, expected: expected.length, ok: 0, clean: 0, empty: 0, falseEmpty: 0, failed: 0, missing: [], naByDesign: [], outsideMatrix: [], contamination: [], defects: [], repoDefects: [] };
  for (const t of PY_TOOLS) {
    const fo = folderFor(folders, t);
    const why = notExpectedReason(t, v);
    if (why) { if (fo) { sum.outsideMatrix.push(t); sum.defects.push({ tool: t, tag: '[Planning Defect]', observed: 'RAN_BUT_EXCLUDED', note: `${t} ran on Python ${v.label} although it must be excluded (${why})`, folder: fo, ranOutsideMatrix: true }); } else if (!RETIRED.includes(t) && !FIXTURES.includes(t)) sum.naByDesign.push(t); continue; }
    if (!expected.includes(t)) continue; // PY_IGNORE_TOOLS
    if (!fo) { sum.missing.push(t); sum.defects.push({ tool: t, tag: '[Planning Defect]', observed: 'NOT_APPLICABLE', note: `${t} is expected for Python ${v.label} but was not triggered — no folder in the run` }); continue; }
    const r = checkTool(t, loadTool(bd, fo));
    if (r.status === 'OK') sum.ok++; else if (r.status === 'CLEAN') sum.clean++;
    else if (r.status === 'FALSE_EMPTY') { sum.falseEmpty++; sum.defects.push({ tool: t, tag: '[False Empty Defect]', observed: 'Empty JSON with 0 files scanned', note: r.note, folder: fo }); }
    else if (r.status === 'FAILED') { sum.failed++; const k = failureKind(r.note); if (k.repo) sum.repoDefects.push(t); else sum.defects.push({ tool: t, tag: '[Runner Execution Defect]', observed: 'FAILED', note: r.note, folder: fo }); }
    else sum.empty++;
  }
  for (const f of folders) {
    const n = nn(f.replace(/\/$/, ''));
    if (PLATFORM_FOLDERS.includes(n)) continue;
    if (FOREIGN.test(f.replace(/\/$/, '')) && !PY_TOOLS.some((t) => [t, ...(ALIAS[t] || [])].map(nn).includes(n))) { const c = f.replace(/\/$/, ''); sum.contamination.push(c); sum.defects.push({ tool: c, tag: '[Language Contamination]', observed: 'FOREIGN_TOOL_PLANNED', note: `${c} (a non-Python tool) was planned for a Python ${v.label} branch`, folder: f }); }
  }
  return sum;
}

export function summaryLine(s: PySummary): string {
  const bits = [`${s.ok} OK`, s.clean ? `${s.clean} clean` : '', s.empty ? `${s.empty} empty` : '', s.falseEmpty ? `${s.falseEmpty} false-empty` : '', s.failed ? `${s.failed} failed` : '', s.missing.length ? `${s.missing.length} missing (${s.missing.join(', ')})` : ''].filter(Boolean);
  return `Python ${s.version} — ${s.expected} tools expected: ${bits.join(' · ')}${s.naByDesign.length ? ` · N/A by design: ${s.naByDesign.join(', ')}` : ''}${s.outsideMatrix.length ? ` · ran outside the matrix: ${s.outsideMatrix.join(', ')}` : ''}${s.contamination.length ? ` · LANGUAGE CONTAMINATION: ${s.contamination.join(', ')}` : ''}`;
}
