import * as fs from 'fs';
import { toolRow, ToolRow } from './toolLog';
import * as path from 'path';
import { FileMap, PyDefect, PyStatus, R, PyResult, isBlank, len, loadTool, nn, num } from './pyValidate';

/**
 * C# (.NET) tool validation for the S3 evidence of a C# branch (CS_VNET<n>_<build>_<package manager>_<MONO|MICRO>).
 * Rules come from PROMPT_Csharp_Tool_Trigger_Analysis (version matrix + what each tool's file must hold) and
 * PROMPT_Csharp_Tool_Bug_Classification_and_Filing (which situations are bugs).
 *
 * It only READS the evidence already saved next to the branch (s3-evidence/) and adjusts the C# tool rows of the existing S3 check.
 * It never fails a run. Same labels as Python / JavaScript: N/A by design · [Planning Defect] · [False Empty Defect] ·
 * [Runner Execution Defect] · [Language Contamination] · [Repo Defect] (flagged, never filed) · clean.
 *
 * Matrix cell meaning:  Y   = must run (missing → Planning Defect)
 *                       OPT = ⚠️ optional (decided with QA for now): not running is NOT a bug, a failure is only noted, if it ran its data is checked
 *                       NO  = ❌ excluded by design: not running is right; if it ran with data → [Planning Defect — ran although excluded]
 *
 * Versions: the TARGET is read from the branch name (repo-details.json only shows the SDK, e.g. 8.0.130, even on a CS_VNET5 branch).
 *   CS_VNET5..9 → their own column · CS_VNET10 → the .NET 9 column (assumption) · CS_VNETCOREAPP30/31 and CS_VNETFX4x (.NET Framework) → the .NET Core 3.1 column (assumption).
 */
type Lvl = 'Y' | 'OPT' | 'NO';
export type Col = '3.1' | '5' | '6' | '7' | '8' | '9';
export const NET_COLS: Col[] = ['3.1', '5', '6', '7', '8', '9'];

const ALL_Y = ['lizard', 'jscpd-cs', 'git-churn', 'pydriller', 'semgrep', 'gitleaks', 'detect-secrets', 'presidio', 'semgrep-pii', 'security-code-scan', 'csharp-perf-dependency', 'cs-coverage-delta'];
const OPT_31_5_9 = ['roslyn-analyzers', 'sonar-csharp']; // ⚠️ on 3.1, 5, 9
const OPT_31_5 = ['dotnet-sca', 'cs-all-defs-uses', 'cs-side-effect']; // ⚠️ on 3.1, 5
const EXEC = ['coverlet', 'altcover', 'stryker-net']; // ❌ 3.1, 5 · ✅ 6-8 · ⚠️ 9 (executesCustomerCode)
export const CS_TOOLS = [...ALL_Y, ...OPT_31_5_9, ...OPT_31_5, ...EXEC];

export function level(tool: string, col: Col): Lvl {
  if (ALL_Y.includes(tool)) return 'Y';
  if (OPT_31_5_9.includes(tool)) return col === '3.1' || col === '5' || col === '9' ? 'OPT' : 'Y';
  if (OPT_31_5.includes(tool)) return col === '3.1' || col === '5' ? 'OPT' : 'Y';
  if (EXEC.includes(tool)) return col === '3.1' || col === '5' ? 'NO' : col === '9' ? 'OPT' : 'Y';
  return 'OPT';
}
const why = (tool: string, v: CsVersion): string => (EXEC.includes(tool) ? `${tool} executes customer code and the cluster has no execution image for ${v.label} (CUSTOMER_CODE_INCOMPATIBLE_WITH_EXECUTION_ENV)` : `${tool} is not expected on ${v.label}`);

/** other folder names / file spellings a tool is saved under */
const ALIAS: Record<string, string[]> = {
  'sonar-csharp': ['sonar-cs', 'sonar_cs', 'sonar-csharp'], 'cs-all-defs-uses': ['cs_all_defs_uses'], 'cs-coverage-delta': ['cs_coverage_delta', 'coverage_delta', 'coverage-delta'],
  'cs-side-effect': ['cs_side_effect'], 'git-churn': ['git_churn'], 'detect-secrets': ['detect_secrets'],
};
const foldersFor = (inv: string[], tool: string) => { const want = [tool, ...(ALIAS[tool] || [])].map(nn); return inv.filter((f) => want.includes(nn(f.replace(/\/$/, '')))); };
/** the matrix tool a folder / row name stands for */
export const canonTool = (name: string): string | undefined => CS_TOOLS.find((t) => [t, ...(ALIAS[t] || [])].map(nn).includes(nn(name.replace(/\/$/, ''))));
/** all folders of one tool merged (git-churn and git_churn hold different parts of the picture) */
function loadAll(bd: string, folders: string[]): FileMap {
  const out: FileMap = {};
  for (const f of folders) for (const [k, v] of Object.entries(loadTool(bd, f))) { const p = out[k]; if (p === undefined || (isBlank(p) && !isBlank(v))) out[k] = v; }
  return out;
}

const PY_FOREIGN = ['bandit', 'pylint', 'radon', 'complexipy', 'pip-audit', 'pip-outdated', 'python-perf-dependency', 'jscpd-py', 'flake8', 'safety', 'coverage-py', 'crosshair', 'cosmic-ray', 'pymcdc', 'py-all-defs-uses', 'py-coverage-delta', 'testmon'];
const OTHER_FOREIGN = /^(eslint|npm|nyc|stryker-js|madge|dependency-cruiser|license-checker|osv-scanner|cyclonedx|js-|javascript-|typescript-|java-|javac|checkstyle|spotbugs|pmd|jacoco|pitest|maven|gradle)/i;
/** shared / platform / legacy folders that are no tool of another language */
const IGNORE = ['_shared', 'github-access-control', 'github_branch_protection', 'github-branch-protection', 'libyear', 'cognitive-ast', 'semgrep-perf-static', 'jscpd-ts', 'knip', 'oxlint', 'trivy', 'codeql', 'opengrep', 'dolos', 'debtmap', 'cccc', 'git-spark', 'gutcheck', 'monocart-coverage-reports'].map(nn);

export interface CsVersion { col: Col; label: string; target: string; hasPython: boolean; note: string }
/** C# branch? → matrix column + readable label. null = not a C# branch → nothing changes. */
export function csVersion(bd: string): CsVersion | null {
  try {
    const base = path.basename(bd);
    const j = JSON.parse(fs.readFileSync(path.join(bd, 'repo-details.json'), 'utf8'));
    const langs = String(j['Language'] || '') + ' ' + (Array.isArray(j.languages) ? j.languages.join(' ') : '');
    if (!/^CS_/i.test(base) && !(/c#|csharp/i.test(langs) && !/^(JS|TS|PY)_/i.test(base))) return null;
    const hasPython = /python/i.test(langs);
    const fx = /^CS_VNETFX(\d+)/i.exec(base); if (fx) return { col: '3.1', label: `.NET Framework ${fx[1].length > 1 ? fx[1][0] + '.' + fx[1].slice(1) : fx[1]}`, target: `net${fx[1]}`, hasPython, note: '.NET Framework 4.x is judged like .NET Core 3.1 (no Windows containers on the Linux workers)' };
    const core = /^CS_VNETCOREAPP(\d)(\d)/i.exec(base); if (core) return { col: '3.1', label: `.NET Core ${core[1]}.${core[2]}`, target: `netcoreapp${core[1]}.${core[2]}`, hasPython, note: core[1] === '3' && core[2] === '1' ? '' : '.NET Core 3.x is judged like .NET Core 3.1' };
    const m = /^CS_VNET(\d+)(?:_|$)/i.exec(base); let n = m ? Number(m[1]) : NaN;
    if (!m) { const rv = /(\d+)\./.exec(String(j['Language version'] || '')); n = rv ? Number(rv[1]) : NaN; }
    if (!Number.isFinite(n)) return null;
    if (n >= 10) return { col: '9', label: `.NET ${n}`, target: `net${n}.0`, hasPython, note: `.NET ${n} is not in the QA matrix — judged like .NET 9 (assumption)` };
    if (n === 3) return { col: '3.1', label: '.NET Core 3.1', target: 'netcoreapp3.1', hasPython, note: '' };
    if (![5, 6, 7, 8, 9].includes(n)) return null;
    return { col: String(n) as Col, label: `.NET ${n}`, target: `net${n}.0`, hasPython, note: '' };
  } catch { return null; }
}

export function expectedTools(v: CsVersion): string[] {
  const ign = (process.env.CS_IGNORE_TOOLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return CS_TOOLS.filter((t) => level(t, v.col) === 'Y' && !ign.includes(t));
}

// ---------- what each tool's file must hold (PROMPT_Csharp_Tool_Trigger_Analysis, section 3 and 5 step 3) ----------
const ok = (n: string, scanned?: number) => R('OK', n, scanned);
const cleanR = (what: string, scanned?: number) => R('CLEAN', `clean — ${what}${scanned ? `, ${scanned} file(s) scanned` : ''}`, scanned);
const empty0 = (what: string) => R('FALSE_EMPTY', `${what} — nothing was analysed although the repo has C# files`, 0);
const unk = (what: string) => R('EMPTY_UNKNOWN', `${what} (scan count unknown)`);
const sarifOf = (f: FileMap, ...names: string[]) => { for (const n of names) if (f[n] !== undefined) return f[n]; const k = Object.keys(f).find((x) => /\.sarif(\.json)?$/i.test(x)); return k ? f[k] : undefined; };
const sarifCheck = (tool: string, j: any, what: string): PyResult => {
  if (j === undefined) return R('NO_DATA', `${what} is missing`);
  if (j?.__invalid) return R('NO_DATA', `${what} is not valid SARIF`);
  const runs = Array.isArray(j?.runs) ? j.runs : [];
  if (!runs.length) return R('NO_DATA', `${what} has no SARIF runs`);
  const res = runs.reduce((a: number, r: any) => a + (Array.isArray(r?.results) ? r.results.length : 0), 0);
  const rules = runs.reduce((a: number, r: any) => a + (Array.isArray(r?.tool?.driver?.rules) ? r.tool.driver.rules.length : 0), 0);
  if (res > 0) return ok(`${res} diagnostic(s) in ${what}${rules ? `, ${rules} rule(s)` : ''}`);
  return rules > 0 || runs[0]?.tool?.driver ? cleanR('0 diagnostics') : empty0(`${what} has 0 diagnostics and no rules`);
};

export function checkCs(tool: string, f: FileMap): PyResult {
  const main = (n: string) => f[n];
  for (const [name, j] of Object.entries(f)) if (/^failure\.json$/i.test(name)) return R('FAILED', `failure.json — ${String((j as any)?.reason || (j as any)?.error || (j as any)?.message || JSON.stringify(j)).replace(/\s+/g, ' ').slice(0, 260)}`);
  if (f['not_applicable.json']) return R('NOT_APPLICABLE' as PyStatus, `the tool reported not_applicable (${String(f['not_applicable.json']?.reason || 'no reason given')})`);
  switch (tool) {
    case 'roslyn-analyzers': return sarifCheck(tool, sarifOf(f, 'roslyn.sarif', 'roslyn.sarif.json'), 'roslyn.sarif');
    case 'sonar-csharp': return sarifCheck(tool, sarifOf(f, 'sonar.sarif', 'sonar_csharp.sarif.json'), 'sonar.sarif');
    case 'security-code-scan': return sarifCheck(tool, sarifOf(f, 'scs.sarif', 'security_code_scan.sarif.json'), 'scs.sarif');
    case 'coverlet': {
      const x = main('coverage.cobertura.xml'); const j = main('coverage.json');
      if (x === undefined && j === undefined) return R('NO_DATA', 'coverage.cobertura.xml / coverage.json are missing');
      const h = String(x?.__head || ''); const lv = /lines-valid="(\d+)"/.exec(h); const lr = /line-rate="([\d.]+)"/.exec(h); const br = /branch-rate="([\d.]+)"/.exec(h);
      if (lv) { const n = Number(lv[1]); return n > 0 ? ok(`${n} lines, ${(Number(lr?.[1] || 0) * 100).toFixed(1)}% line / ${(Number(br?.[1] || 0) * 100).toFixed(1)}% branch coverage`, n) : empty0('coverage.cobertura.xml has lines-valid="0"'); }
      if (x && num(x.__size) && x.__size > 800) return ok('coverage.cobertura.xml holds data');
      return j !== undefined && !isBlank(j) ? ok('coverage.json has data') : empty0('coverage report is empty');
    }
    case 'altcover': {
      const x = main('altcover.xml'); if (x === undefined) return R('NO_DATA', 'altcover.xml is missing');
      const h = String(x?.__head || '');
      return /<module\b|<coverage\b|<CoverageSession\b/i.test(h) && num(x.__size) && x.__size > 1500 ? ok(`instrumentation report (${Math.round(x.__size / 1024)} KB)`) : empty0('altcover.xml has no module / coverage data');
    }
    case 'stryker-net': {
      const j = main('mutation-report.json'); if (j === undefined) return R('NO_DATA', 'mutation-report.json is missing');
      const files = j.files ? Object.keys(j.files).length : 0; let mutants = 0; for (const fl of Object.values<any>(j.files || {})) mutants += Array.isArray(fl?.mutants) ? fl.mutants.length : 0;
      const score = num(j.mutationScore) ?? num(j?.metrics?.mutationScore);
      return mutants > 0 || (score !== undefined && files > 0) ? ok(`${mutants} mutant(s) in ${files} file(s)${score !== undefined ? `, mutation score ${score}` : ''}`, files) : empty0('mutation-report.json has 0 mutants');
    }
    case 'jscpd-cs': {
      const j = main('jscpd-report.json'); if (j === undefined) return R('NO_DATA', 'jscpd-report.json is missing');
      const t = j?.statistics?.total; const src = num(t?.sources);
      if (src === undefined) return unk('jscpd-report.json has no statistics.total');
      return src > 0 ? ok(`${src} source file(s), ${t.clones ?? 0} clone(s), ${t.percentage ?? 0}% duplication`, src) : empty0('statistics.total.sources is 0');
    }
    case 'lizard': {
      const j = main('lizard.json'); const x = main('lizard.xml');
      if (j === undefined && x === undefined) return R('NO_DATA', 'lizard.json / lizard.xml are missing');
      if (Array.isArray(j) && j.length) return ok(`${j.length} file entr${j.length === 1 ? 'y' : 'ies'}`, j.length);
      if (x && num(x.__size) && x.__size > 1500) return ok('lizard.xml holds the function measures (lizard.json is [])');
      return empty0('lizard.json is [] and lizard.xml has no measures');
    }
    case 'dotnet-sca': {
      const j = main('vulnerable.json') ?? main('dotnet_list_package.json') ?? main('nuget_deps.json'); if (j === undefined) return R('NO_DATA', 'vulnerable.json is missing');
      const projects = Array.isArray(j.projects) ? j.projects.length : 0;
      return projects ? ok(`${projects} project(s) audited (${j.parameters || 'dotnet list package'})`, projects) : empty0('vulnerable.json lists 0 projects');
    }
    case 'cs-all-defs-uses': {
      const j = main('cs_all_defs_uses_stub.json') ?? main('defs_uses.json') ?? main('cs_all_defs_uses.json'); if (j === undefined) return R('NO_DATA', 'defs_uses.json is missing');
      if (/NOT_IMPLEMENTED/i.test(String(j.status || '')) || /not_implemented/i.test(String(j.detail_code || ''))) return empty0('the analyzer is only a stub (status NOT_IMPLEMENTED, no definitions or uses were computed)');
      return !isBlank(j.metrics) || len(j.pairs) || len(j.definitions) ? ok('definition / use pairs present') : unk('defs_uses.json has no pairs');
    }
    case 'cs-coverage-delta': {
      const j = main('cs_coverage_delta.json') ?? main('coverage_delta.json'); if (j === undefined) return R('NO_DATA', 'cs_coverage_delta.json is missing');
      if (/SKIPPED/i.test(String(j.status || '')) || j.reason === 'baseline_missing' || j.resolution_source === 'baseline_missing') return R('NO_DATA', `no baseline commit to compare with (${j.reason || j.resolution_source || 'skipped'}) — expected on a first run`);
      return !isBlank(j.metrics) || j.coverage_delta_metric != null ? ok('coverage delta calculated') : unk('cs_coverage_delta.json has no metrics');
    }
    case 'cs-side-effect': {
      const j = main('cs_side_effect.json') ?? main('side_effects.json'); if (j === undefined) return R('NO_DATA', 'cs_side_effect.json is missing');
      const n = len(j.files); return n ? ok(`${n} file(s) analysed for side effects`, n) : unk(`cs_side_effect.json has no files (window_commits=${j.window_commits ?? '?'})`);
    }
    case 'csharp-perf-dependency': {
      const j = main('perf-dependency-csharp.json'); if (j === undefined) return R('NO_DATA', 'perf-dependency-csharp.json is missing');
      return Object.keys(j).some((k) => k.startsWith('perf_dependency')) ? ok('dependency / import-overhead metrics present') : unk('perf-dependency-csharp.json has no metrics');
    }
    case 'pydriller': {
      const j = main('pydriller.json'); if (j === undefined) return R('NO_DATA', 'pydriller.json is missing');
      const c = num(j.commit_count); return c && c > 0 ? ok(`${c} commit(s), ${j.author_count ?? '?'} author(s)`) : unk('pydriller.json has 0 commits');
    }
    case 'git-churn': {
      const a = main('git-churn.json'); const b = main('git_churn.json');
      const files = a && !Array.isArray(a) ? Object.keys(a).filter((k) => !k.startsWith('__')).length : 0; const commits = num(b?.commits);
      if (a === undefined && b === undefined) return R('NO_DATA', 'git_churn.json is missing');
      return files > 0 || (commits && commits > 0) ? ok(files ? `${files} file(s) with churn` : `${commits} commit(s)`) : unk('git churn has no commits / files');
    }
    case 'semgrep': {
      const j = main('semgrep.json'); if (j === undefined) return R('NO_DATA', 'semgrep.json is missing');
      const sc = Array.isArray(j?.paths?.scanned) ? j.paths.scanned.length : undefined; const r = Array.isArray(j.results) ? j.results.length : 0;
      if (sc === undefined) return r ? ok(`${r} finding(s)`) : unk('semgrep.json has no paths.scanned');
      if (sc === 0) return empty0('paths.scanned is []');
      return r ? ok(`${r} finding(s) in ${sc} file(s)`, sc) : cleanR('0 findings', sc);
    }
    case 'semgrep-pii': {
      const j = main('semgrep-pii-results.json'); if (j === undefined) return R('NO_DATA', 'semgrep-pii-results.json is missing');
      const sc = Array.isArray(j?.paths?.scanned) ? j.paths.scanned.length : undefined; const r = Array.isArray(j.results) ? j.results.length : 0;
      if (sc === 0) return empty0('paths.scanned is []');
      return r ? ok(`${r} PII-in-log finding(s)`, sc) : j.version || sc !== undefined ? cleanR('no PII in log statements', sc) : unk('semgrep-pii-results.json is empty');
    }
    case 'gitleaks': {
      const j = main('gitleaks.json') ?? main('gitleaks-head.json'); if (j === undefined) return R('NO_DATA', 'gitleaks.json is missing');
      return Array.isArray(j) && j.length ? ok(`${j.length} secret finding(s)`) : cleanR('no secrets found');
    }
    case 'detect-secrets': {
      const j = main('detect_secrets.json') ?? main('detect-secrets-baseline.json'); if (j === undefined) return R('NO_DATA', 'detect_secrets.json is missing');
      return len(j.results) ? ok(`${len(j.results)} file(s) with secrets`) : j.plugins_used || j.version ? cleanR('no high-entropy secrets') : unk('detect_secrets.json is empty');
    }
    case 'presidio': {
      const j = main('presidio-results.json'); if (j === undefined) return R('NO_DATA', 'presidio-results.json is missing');
      return Array.isArray(j.findings) && j.findings.length ? ok(`${j.findings.length} PII finding(s)`) : j.tool_version ? cleanR('no PII found') : unk('presidio-results.json is empty');
    }
    default: {
      const data = Object.keys(f).filter((k) => !k.startsWith('__') && !isBlank(f[k]));
      return data.length ? ok(`has data (${data.slice(0, 3).join(', ')})`) : unk('all files empty');
    }
  }
}

// ---------- applying it ----------
export interface CsSummary {
  tools?: ToolRow[]; // one row per tool for the Tool Trigger Log in Teams
  language: 'csharp'; version: string; target: string; assumption: string;
  expected: number; ok: number; clean: number; empty: number; falseEmpty: number; failed: number;
  missing: string[]; naByDesign: string[]; optionalMissing: string[]; optionalFailed: string[]; outsideMatrix: string[]; contamination: string[]; notApplicable: string[];
  defects: PyDefect[]; repoDefects: string[];
}
const sev = (s: PyStatus | 'NOT_APPLICABLE') => (s === 'FAILED' ? 5 : s === 'FALSE_EMPTY' ? 4 : s === 'NO_DATA' ? 3 : s === 'EMPTY_UNKNOWN' ? 2 : s === 'CLEAN' ? 1 : 0);

/** customer-repo failure vs worker failure (PROMPT_Csharp_Tool_Bug_Classification_and_Filing, section 2) */
export function csFailureKind(note: string): { tag: string; repo: boolean } {
  if (/NETSDK1045|not support targeting|dotnet: not found|command not found|exit code 127|OOM|out of memory|killed|timed? ?out|timeout|dotnet tool restore|dotnet-stryker|Traceback|unhandled|permanent_runner_error.*dotnet_restore_failed:\s*$|lock .* already exist/i.test(note)) return { tag: '[Runner Execution Defect]', repo: false };
  if (/error CS\d{4}|NU110[12]|NU1301|Unable to find package|project file does not exist|MSB1009|test(s)? failed|Assert/i.test(note)) return { tag: '[Repo Defect — not a platform bug]', repo: true };
  return { tag: '[Runner Execution Defect]', repo: false };
}

export function validateCSharp(bd: string, rows: any[], inventory: Record<string, string[]>): CsSummary | null {
  const v = csVersion(bd); if (!v) return null;
  const folders = Object.keys(inventory); const col = v.col;
  const NA = (r: PyResult) => (r.status as string) === 'NOT_APPLICABLE';
  const ign = (process.env.CS_IGNORE_TOOLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const load = (t: string) => { const fl = foldersFor(folders, t); return fl.length ? { fl, map: loadAll(bd, fl) } : null; };

  // 1) rows of the taxonomy report
  for (const row of rows) {
    if (row.language !== 'csharp') continue;
    const names = String(row.tool || '').split(' + ').map((s) => s.trim()).map((n) => canonTool(n)).filter((n): n is string => !!n);
    if (!names.length) continue;
    const parts: { t: string; r: PyResult }[] = [];
    for (const t of names) { const l = load(t); if (l) parts.push({ t, r: checkCs(t, l.map) }); }
    if (!parts.length) { // no folder at all for this row
      const lv = names.map((t) => ({ t, l: level(t, col) }));
      if (lv.every((x) => x.l === 'NO')) { row.result = 'NA'; row.note = `N/A for ${v.label} by design — ${lv.map((x) => why(x.t, v)).join('; ')} (not a bug)`; row.files = []; }
      else if (!lv.some((x) => x.l === 'Y')) { row.result = 'NA'; row.note = `N/A on ${v.label} — ${lv.map((x) => x.t).join(', ')} is optional here (⚠️ in the matrix); not triggered is not a bug`; row.files = []; }
      else if (row.result === 'FAIL') row.note = `[Planning Defect] ${lv.filter((x) => x.l === 'Y').map((x) => x.t).join(', ')} is expected for ${v.label} but was not triggered — no folder in the run`;
      continue;
    }
    const naParts = parts.filter((p) => NA(p.r)); const real = parts.filter((p) => !NA(p.r));
    if (!real.length) {
      if (naParts.some((p) => level(p.t, col) === 'Y')) { row.result = 'FAIL'; row.note = `[Planning Defect] ${naParts.map((p) => p.t).join(', ')} is expected for ${v.label} but only reported not_applicable — ${naParts[0].r.note}`; }
      else { row.result = 'NA'; row.note = `N/A on ${v.label} — ${naParts.map((p) => `${p.t}: ${p.r.note}`).join('; ')}`; }
      continue;
    }
    const worst = real.reduce((a, b) => (sev(b.r.status) > sev(a.r.status) ? b : a));
    const best = real.reduce((a, b) => (sev(b.r.status) < sev(a.r.status) ? b : a));
    const text = real.map((p) => (real.length > 1 ? `${p.t}: ` : '') + p.r.note).join('  +  ');
    const isNo = (p: { t: string }) => level(p.t, col) === 'NO'; const isOpt = (p: { t: string }) => level(p.t, col) === 'OPT';
    const ranExcluded = real.filter((p) => isNo(p) && p.r.status !== 'FAILED').map((p) => p.t);
    if (real.every((p) => isNo(p) && p.r.status === 'FAILED')) { row.result = 'NA'; row.note = `N/A for ${v.label} by design — ${real.map((p) => why(p.t, v)).join('; ')} (it only wrote a failure; not a bug)`; continue; }
    if (ranExcluded.length) { row.result = 'FAIL'; row.note = `[Planning Defect — ${ranExcluded.join(', ')} ran although it must be excluded on ${v.label}] ${text}`; }
    else if (real.every((p) => p.r.status === 'OK' || p.r.status === 'CLEAN')) { row.result = 'PASS'; row.note = text; }
    else if (real.some((p) => p.r.status === 'FAILED')) {
      const f = real.find((p) => p.r.status === 'FAILED')!; const k = csFailureKind(f.r.note);
      if (isOpt(f)) { row.result = 'EMPTY'; row.note = `optional on ${v.label} (⚠️) — failed, not filed as a bug: ${text}`; }
      else { row.result = k.repo ? 'EMPTY' : 'FAIL'; row.note = `${k.tag} ${text}`; }
    }
    else if (worst.r.status === 'FALSE_EMPTY' && best.r.status !== 'OK') { if (isOpt(worst)) { row.result = 'EMPTY'; row.note = `optional on ${v.label} (⚠️) — ${text}`; } else { row.result = 'FAIL'; row.note = `[False Empty Defect] ${text}`; } }
    else if (best.r.status === 'OK' || best.r.status === 'CLEAN') { row.result = 'PASS'; row.note = text; }
    else { row.result = 'EMPTY'; row.note = text; }
  }

  // 2) whole-run summary: every tool of the matrix, independent of the table rows
  const sum: CsSummary = { language: 'csharp', version: v.label, target: v.target, assumption: v.note, expected: expectedTools(v).length, ok: 0, clean: 0, empty: 0, falseEmpty: 0, failed: 0, missing: [], naByDesign: [], optionalMissing: [], optionalFailed: [], outsideMatrix: [], contamination: [], notApplicable: [], defects: [], repoDefects: [] };
  for (const t of CS_TOOLS) {
    if (ign.includes(t)) continue;
    const lv = level(t, col); const l = load(t); const f = l?.fl[0];
    const r = l ? checkCs(t, l.map) : null; const reportedNA = !!r && NA(r); { const _row = toolRow(t, lv, !!l, r, reportedNA); if (_row) (sum.tools ||= []).push(_row); }
    if (lv === 'NO') {
      if (l && !reportedNA && r!.status !== 'FAILED') { sum.outsideMatrix.push(t); sum.defects.push({ tool: t, tag: '[Planning Defect]', observed: 'RAN_BUT_EXCLUDED', note: `${t} ran on ${v.label} although it must be excluded (${why(t, v)})`, folder: f, ranOutsideMatrix: true }); }
      else sum.naByDesign.push(t);
      continue;
    }
    if (!l) { if (lv === 'Y') { sum.missing.push(t); sum.defects.push({ tool: t, tag: '[Planning Defect]', observed: 'NOT_APPLICABLE', note: `${t} is expected for ${v.label} but was not triggered — no folder in the run` }); } else sum.optionalMissing.push(t); continue; }
    if (reportedNA) { sum.notApplicable.push(t); if (lv === 'Y') sum.defects.push({ tool: t, tag: '[Planning Defect]', observed: 'NOT_APPLICABLE', note: `${t} is expected for ${v.label} but only reported not_applicable — ${r!.note}`, folder: f }); continue; }
    if (r!.status === 'OK') sum.ok++; else if (r!.status === 'CLEAN') sum.clean++;
    else if (r!.status === 'FALSE_EMPTY') { if (lv === 'OPT') { sum.empty++; sum.optionalFailed.push(t); } else { sum.falseEmpty++; sum.defects.push({ tool: t, tag: '[False Empty Defect]', observed: 'Empty report with 0 files scanned', note: r!.note, folder: f }); } }
    else if (r!.status === 'FAILED') { const k = csFailureKind(r!.note); if (lv === 'OPT') { sum.optionalFailed.push(t); sum.empty++; continue; } sum.failed++; if (k.repo) sum.repoDefects.push(t); else sum.defects.push({ tool: t, tag: '[Runner Execution Defect]', observed: 'FAILED', note: r!.note, folder: f }); }
    else sum.empty++;
  }
  // tools of another language (Python tools are accepted when the repo itself contains Python files)
  for (const f of folders) {
    const name = f.replace(/\/$/, ''); const n = nn(name);
    if (IGNORE.includes(n) || canonTool(name)) continue;
    const isPy = PY_FOREIGN.map(nn).includes(n);
    if ((isPy && !v.hasPython) || OTHER_FOREIGN.test(name)) {
      sum.contamination.push(name);
      sum.defects.push({ tool: name, tag: '[Language Contamination]', observed: 'FOREIGN_TOOL_PLANNED', note: `${name} (a non-C# tool) was planned for a C# ${v.label} branch`, folder: f });
    }
  }
  return sum;
}

export function csSummaryLine(s: CsSummary): string {
  const bits = [`${s.ok} OK`, s.clean ? `${s.clean} clean` : '', s.empty ? `${s.empty} empty` : '', s.falseEmpty ? `${s.falseEmpty} false-empty` : '', s.failed ? `${s.failed} failed` : '', s.missing.length ? `${s.missing.length} missing (${s.missing.join(', ')})` : ''].filter(Boolean);
  return `${s.version} (${s.target}) — ${s.expected} tools expected: ${bits.join(' · ')}${s.naByDesign.length ? ` · N/A by design: ${s.naByDesign.join(', ')}` : ''}${s.optionalMissing.length ? ` · optional (⚠️) not run: ${s.optionalMissing.join(', ')}` : ''}${s.optionalFailed.length ? ` · optional (⚠️) failed/empty, not filed: ${s.optionalFailed.join(', ')}` : ''}${s.notApplicable.length ? ` · reported not_applicable: ${s.notApplicable.join(', ')}` : ''}${s.outsideMatrix.length ? ` · ran outside the matrix: ${s.outsideMatrix.join(', ')}` : ''}${s.contamination.length ? ` · LANGUAGE CONTAMINATION: ${s.contamination.join(', ')}` : ''}${s.assumption ? ` · note: ${s.assumption}` : ''}`;
}
