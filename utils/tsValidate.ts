import * as fs from 'fs';
import * as path from 'path';
import { FileMap, PyDefect, PyStatus, R, PyResult, isBlank, len, loadTool, nn, num } from './pyValidate';
import { checkJs } from './jsValidate';

/**
 * TypeScript tool validation for the S3 evidence of a TypeScript branch (TS_V<node>_<bundler>_<npm|yarn|pnpm|bun>_<MONO|MICRO>).
 * Rules come from PROMPT_TS_Tool_Trigger_Analysis (Node matrix + what each tool's file must hold) and
 * PROMPT_TS_Tool_Bug_Classification_and_Filing (which situations are bugs).
 *
 * It only READS the evidence already saved next to the branch (s3-evidence/) and adjusts the TypeScript tool rows of the existing S3 check.
 * It never fails a run. Same labels as the other languages: N/A by design · [Planning Defect] · [False Empty Defect] ·
 * [Runner Execution Defect] · [Language Contamination] · [Repo Defect] (flagged, never filed) · clean.
 *
 * Matrix cell meaning:  Y   = must run (missing → Planning Defect)
 *                       OPT = ⚠️ legacy pin / not in the matrix for this Node: may run; missing is NOT a bug, if it ran its data is checked
 *                       NO  = ❌ excluded by design: not running is right; if it ran with data → [Planning Defect — ran although excluded]
 * Customer-code tools (executesCustomerCode) only have an execution container on Node 20, 21 and 22.
 */
type Lvl = 'Y' | 'OPT' | 'NO';
export const TS_NODES = [12, 14, 16, 18, 20, 21, 22, 24, 26];

const ALL_Y = ['lizard', 'git-churn', 'pydriller', 'gitleaks', 'detect-secrets', 'presidio', 'osv-scanner-ts', 'cdxgen', 'ncu'];
const OPT_LT16 = ['jscpd-ts', 'ts-eslint-sonarjs', 'ts-eslint-security']; // ⚠️ on 12/14
const NO_LT16_OPT_16 = ['biome', 'oxlint', 'dependency-cruiser-ts', 'knip']; // ❌ 12/14 · ⚠️ 16
const EXEC = ['vitest-coverage', 'stryker-ts', 'fast-check', 'opentelemetry-spans', 'ts-all-defs-uses', 'ts-path-coverage', 'ts-coverage-delta']; // ✅ only 20/21/22
const FULL_ONLY = ['cve-lite', 'grype', 'pnpm-audit', 'github-vitality', 'dependabot-advisories', 'ort', 'typescript-perf-dependency']; // in the 26-tool inventory: all must run on 20/21/22, not stated for other Node versions
const EXTRA = ['semgrep', 'semgrep-pii', 'semgrep-perf-static', 'nyc-mocha']; // seen in real runs, not in the TS matrix: checked when present, never required
export const TS_TOOLS = [...ALL_Y, ...OPT_LT16, ...NO_LT16_OPT_16, ...EXEC, ...FULL_ONLY, ...EXTRA];
const hasExec = (n: number) => n >= 20 && n <= 22;

export function level(tool: string, node: number): Lvl {
  if (ALL_Y.includes(tool)) return 'Y';
  if (OPT_LT16.includes(tool)) return node < 16 ? 'OPT' : 'Y';
  if (NO_LT16_OPT_16.includes(tool)) return node < 16 ? 'NO' : node === 16 ? 'OPT' : 'Y';
  if (EXEC.includes(tool)) return hasExec(node) ? 'Y' : 'NO';
  if (FULL_ONLY.includes(tool)) return hasExec(node) ? 'Y' : 'OPT';
  return 'OPT';
}
const why = (tool: string, node: number): string => {
  if (EXEC.includes(tool)) return `${tool} executes customer code and the cluster only has execution containers for Node 20, 21 and 22 (CUSTOMER_CODE_INCOMPATIBLE_WITH_EXECUTION_ENV on Node ${node})`;
  if (NO_LT16_OPT_16.includes(tool)) return `${tool} needs host Node 18+ (excluded on Node ${node})`;
  return `${tool} is not expected on Node ${node}`;
};

/** other folder names / file spellings a tool is saved under */
const ALIAS: Record<string, string[]> = {
  'cve-lite': ['cve-lite-cli', 'cve_lite'], 'git-churn': ['git_churn'], 'detect-secrets': ['detect_secrets'], 'ts-path-coverage': ['ts_path_coverage'], 'ts-all-defs-uses': ['ts_all_defs_uses'],
  'ts-coverage-delta': ['ts_coverage_delta'], 'dependabot-advisories': ['dependabot'], 'opentelemetry-spans': ['opentelemetry', 'otel-spans'], 'osv-scanner-ts': ['osv_scanner_ts'],
  'semgrep-pii': ['semgrep_pii'], 'semgrep-perf-static': ['semgrep_perf_static'], 'github-vitality': ['github_vitality'], 'typescript-perf-dependency': ['typescript_perf_dependency'],
};
const foldersFor = (inv: string[], tool: string) => { const want = [tool, ...(ALIAS[tool] || [])].map(nn); return inv.filter((f) => want.includes(nn(f.replace(/\/$/, '')))); };
export const canonTool = (name: string): string | undefined => TS_TOOLS.find((t) => [t, ...(ALIAS[t] || [])].map(nn).includes(nn(name.replace(/\/$/, ''))));
function loadAll(bd: string, folders: string[]): FileMap {
  const out: FileMap = {};
  for (const f of folders) for (const [k, v] of Object.entries(loadTool(bd, f))) { const p = out[k]; if (p === undefined || (isBlank(p) && !isBlank(v))) out[k] = v; }
  return out;
}

const PY_FOREIGN = ['bandit', 'pylint', 'radon', 'complexipy', 'pip-audit', 'pip-outdated', 'python-perf-dependency', 'jscpd-py', 'flake8', 'safety', 'coverage-py', 'crosshair', 'cosmic-ray', 'pymcdc', 'py-all-defs-uses', 'py-coverage-delta', 'testmon'];
/** plain-JavaScript tools: accepted when the repo itself holds JavaScript files (mixed repos), contamination otherwise */
const JS_FOREIGN = ['eslint', 'eslint-security', 'eslint-sonarjs', 'jscpd-js', 'madge', 'javascript-perf-dependency', 'js-all-defs-uses', 'js-path-coverage', 'stryker-js', 'dependency-cruiser', 'npm-audit', 'npm-ls', 'npm-outdated', 'npm-view', 'license-checker', 'osv-scanner', 'cyclonedx-npm', 'coverage_delta'];
const OTHER_FOREIGN = /^(checkstyle|spotbugs|pmd|jacoco|pitest|roslyn|coverlet|altcover|dotnet|maven|gradle|nuget|java-|csharp-|cs-|cs_|javac|security-code-scan|sonar-cs)/i;
/** shared / platform / legacy folders that are no tool of another language */
const IGNORE = ['_shared', 'github-access-control', 'github_branch_protection', 'github-branch-protection', 'libyear', 'cognitive-ast', 'trivy', 'codeql', 'opengrep', 'dolos', 'debtmap', 'cccc', 'git-spark', 'gutcheck', 'monocart-coverage-reports'].map(nn);

export interface TsVersion { node: number; label: string; pm: string; layout: string; hasPython: boolean; hasJs: boolean; note: string }
/** TypeScript branch? → Node version, package manager, layout. null = not a TS branch → nothing changes. */
export function tsVersion(bd: string): TsVersion | null {
  try {
    const base = path.basename(bd);
    let j: any = {}; try { j = JSON.parse(fs.readFileSync(path.join(bd, 'repo-details.json'), 'utf8')); } catch { /* none */ }
    const langs = String(j['Language'] || '') + ' ' + (Array.isArray(j.languages) ? j.languages.join(' ') : '');
    const byPrefix = /^TS_/i.test(base);
    const byRepo = !/^(JS|PY|CS|JV)_/i.test(base) && /type ?script/i.test(langs);
    if (!byPrefix && !byRepo) return null;
    const mv = /^TS_V(\d+)_/i.exec(base); const rv = /(\d+)/.exec(String(j['Language version'] || ''));
    const raw = Number(mv ? mv[1] : rv ? rv[1] : NaN);
    if (!Number.isFinite(raw)) return null;
    let node = raw; let note = '';
    if (!TS_NODES.includes(raw)) { node = [...TS_NODES].reverse().find((n) => n <= raw) ?? 12; note = `Node ${raw} is not in the QA matrix — judged like Node ${node} (assumption)`; }
    const pmM = /_(NPM|YARNBERRY|YARN|PNPM|BUN)(_|$)/i.exec(base);
    const pm = (pmM ? pmM[1] : String(j['Project type'] || 'npm')).toLowerCase();
    const lay = /_(MONO|MICRO)(_|$)/i.exec(base);
    return { node, label: String(raw), pm, layout: lay ? lay[1].toLowerCase() : '', hasPython: /python/i.test(langs), hasJs: /java ?script/i.test(langs), note };
  } catch { return null; }
}

export function expectedTools(v: TsVersion): string[] {
  const ign = (process.env.TS_IGNORE_TOOLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return TS_TOOLS.filter((t) => level(t, v.node) === 'Y' && !ign.includes(t));
}

// ---------- what each tool's file must hold (PROMPT_TS_Tool_Trigger_Analysis, sections 3 and 5 step 3) ----------
const ok = (n: string, scanned?: number) => R('OK', n, scanned);
const cleanR = (what: string, scanned?: number) => R('CLEAN', `clean — ${what}${scanned ? `, ${scanned} file(s) scanned` : ''}`, scanned);
const empty0 = (what: string) => R('FALSE_EMPTY', `${what} — nothing was analysed although the repo has TypeScript files`, 0);
const unk = (what: string) => R('EMPTY_UNKNOWN', `${what} (scan count unknown)`);
const JS_SAME: Record<string, string> = { 'jscpd-ts': 'jscpd-js', 'ts-eslint-sonarjs': 'eslint-sonarjs', 'ts-eslint-security': 'eslint-security' };

export function checkTs(tool: string, f: FileMap): PyResult {
  const main = (n: string) => f[n];
  for (const [name, j] of Object.entries(f)) if (/^failure\.json$/i.test(name)) return R('FAILED', `failure.json — ${String((j as any)?.reason || (j as any)?.error || (j as any)?.message || JSON.stringify(j)).replace(/\s+/g, ' ').slice(0, 260)}`);
  if (f['not_applicable.json']) return R('NOT_APPLICABLE' as PyStatus, `the tool reported not_applicable (${String(f['not_applicable.json']?.reason || 'no reason given')})`);
  switch (tool) {
    case 'jscpd-ts': case 'ts-eslint-sonarjs': case 'ts-eslint-security': {
      const r = checkJs(JS_SAME[tool], f);
      return { ...r, note: r.note.replace(/JavaScript files/g, 'TypeScript files') };
    }
    case 'biome': {
      const j = main('biome.json'); if (j === undefined) return R('NO_DATA', 'biome.json is missing');
      const d = Array.isArray(j?.diagnostics) ? j.diagnostics.length : undefined; const files = num(j?.summary?.files) ?? num(j?.summary?.changed);
      if (d) return ok(`${d} diagnostic(s)`, files);
      if (files && files > 0) return cleanR('0 diagnostics', files);
      return empty0('biome.json is only {"diagnostics": []} with no summary / file count (placeholder write)');
    }
    case 'oxlint': {
      const j = main('oxlint.json'); if (j === undefined) return R('NO_DATA', 'oxlint.json is missing');
      const d = Array.isArray(j?.diagnostics) ? j.diagnostics.length : Array.isArray(j) ? j.length : undefined; const files = num(j?.number_of_files);
      if (d) return ok(`${d} diagnostic(s)`, files);
      if (files && files > 0) return cleanR('0 diagnostics', files);
      return d === 0 ? empty0('oxlint.json has 0 diagnostics and no file count') : unk('oxlint.json has no diagnostics list');
    }
    case 'knip': {
      const j = main('knip-report.json') ?? main('knip.json'); if (j === undefined) return R('NO_DATA', 'knip-report.json is missing');
      const files = len(j.files); const issues = len(j.issues);
      return files || issues ? ok(`${files} unused file(s), ${issues} issue entr${issues === 1 ? 'y' : 'ies'}`) : empty0('knip-report.json has no files and no issues');
    }
    case 'dependency-cruiser-ts': {
      const j = main('depcruise-ts.json') ?? main('dependency-cruiser.json'); if (j === undefined) return R('NO_DATA', 'depcruise-ts.json is missing');
      const mods = Array.isArray(j?.modules) ? j.modules.length : 0;
      return mods ? ok(`${mods} module(s) in the graph`, mods) : empty0('depcruise-ts.json has no modules');
    }
    case 'cdxgen': {
      const j = main('sbom.json') ?? main('bom.json'); if (j === undefined) return R('NO_DATA', 'sbom.json is missing');
      const c = Array.isArray(j.components) ? j.components.length : 0;
      return j.bomFormat && c ? ok(`CycloneDX ${j.specVersion || ''} SBOM with ${c} component(s)`) : j.bomFormat ? empty0('sbom.json has 0 components') : R('NO_DATA', 'sbom.json is not a CycloneDX document');
    }
    case 'cve-lite': {
      const j = main('cve_lite.json'); if (j === undefined) return R('NO_DATA', 'cve_lite.json is missing');
      const n = Array.isArray(j.findings) ? j.findings.length : num(j.findingCount);
      return n ? ok(`${n} CVE finding(s)`) : j.findings !== undefined ? cleanR('0 CVE findings') : unk('cve_lite.json has no findings list');
    }
    case 'grype': {
      const j = main('grype-report.json'); if (j === undefined) return R('NO_DATA', 'grype-report.json is missing');
      const n = Array.isArray(j.matches) ? j.matches.length : undefined;
      return n ? ok(`${n} vulnerability match(es)`) : n === 0 ? cleanR('0 vulnerability matches') : unk('grype-report.json has no matches list');
    }
    case 'osv-scanner-ts': {
      const j = main('osv-report.json') ?? main('osv.json'); if (j === undefined) return R('NO_DATA', 'osv-report.json is missing');
      const r = Array.isArray(j.results) ? j.results : [];
      return r.length ? ok(`${r.length} lockfile result(s)`) : cleanR('no lockfile findings');
    }
    case 'ncu': {
      const j = main('ncu-report.json'); if (j === undefined) return R('NO_DATA', 'ncu-report.json is missing');
      return len(j) ? ok('dependency freshness report present') : empty0('ncu-report.json is empty');
    }
    case 'pnpm-audit': {
      const j = main('pnpm-audit.json'); if (j === undefined) return R('NO_DATA', 'pnpm-audit.json is missing');
      const n = len(j.advisories);
      return n ? ok(`${n} advisor${n === 1 ? 'y' : 'ies'}`) : j.advisories !== undefined || j.metadata ? cleanR('0 advisories') : unk('pnpm-audit.json has no advisories list');
    }
    case 'github-vitality': {
      const j = main('github-vitality.json'); if (j === undefined) return R('NO_DATA', 'github-vitality.json is missing');
      const n = Array.isArray(j.dependencies) ? j.dependencies.length : 0;
      return n ? ok(`${n} package(s) rated`) : empty0('github-vitality.json lists 0 dependencies');
    }
    case 'dependabot-advisories': {
      const j = main('dependabot.json'); if (j === undefined) return R('NO_DATA', 'dependabot.json is missing');
      return !isBlank(j) ? ok('advisory data present') : cleanR('no advisories');
    }
    case 'ort': {
      const j = main('ort-scan-result.json'); if (j === undefined) return R('NO_DATA', 'ort-scan-result.json is missing');
      return !isBlank(j) ? ok('licence / policy scan data present') : empty0('ort-scan-result.json is empty');
    }
    case 'vitest-coverage': {
      const s = main('coverage-summary.json'); const v = main('vitest.json'); const x = main('cobertura-coverage.xml');
      const t = s?.total;
      if (t?.statements) { const st = num(t.statements.total); return st && st > 0 ? ok(`${st} statements, ${t.statements.pct}% covered; branches ${t.branches?.total ?? 0} (${t.branches?.pct}%); functions ${t.functions?.pct}%`, Math.max(0, len(s) - 1)) : empty0('coverage-summary.json total has 0 statements'); }
      const lv = /lines-valid="(\d+)"/.exec(String(x?.__head || '')); if (lv) return Number(lv[1]) > 0 ? ok(`${lv[1]} lines in cobertura-coverage.xml`, Number(lv[1])) : empty0('cobertura-coverage.xml has lines-valid="0"');
      if (v !== undefined && !isBlank(v)) return ok('vitest.json has data');
      return s === undefined && v === undefined && x === undefined ? R('NO_DATA', 'coverage-summary.json / vitest.json are missing') : empty0('coverage report is empty');
    }
    case 'stryker-ts': {
      const j = main('mutation.json') ?? main('mutation-report.json'); if (j === undefined) return R('NO_DATA', 'mutation.json is missing');
      const files = j.files ? Object.keys(j.files).length : 0; let mutants = 0; const st: Record<string, number> = {};
      for (const fl of Object.values<any>(j.files || {})) for (const m of Array.isArray(fl?.mutants) ? fl.mutants : []) { mutants++; st[m.status] = (st[m.status] || 0) + 1; }
      if (!mutants) return empty0('mutation.json has 0 mutants');
      const killed = (st.Killed || 0) + (st.Timeout || 0); const valid = mutants - (st.CompileError || 0) - (st.Ignored || 0);
      return ok(`${mutants} mutant(s) in ${files} file(s), ${killed} killed${valid > 0 ? `, mutation score ${((killed / valid) * 100).toFixed(1)}%` : ''}`, files);
    }
    case 'fast-check': {
      const j = main('fast-check-report.json') ?? main('fast-check.json'); if (j === undefined) return R('NO_DATA', 'fast-check-report.json is missing');
      const b = Array.isArray(j.branches) ? j.branches.length : 0; const keys = Object.keys(j).filter((k) => !k.startsWith('__') && !isBlank(j[k])).length;
      return b ? ok(`${b} branch point(s) exercised by property tests`, b) : keys ? ok('property-test report has data') : empty0('fast-check-report.json is empty');
    }
    case 'opentelemetry-spans': {
      const j = main('otel-spans.json') ?? main('traces.json'); if (j === undefined) return R('NO_DATA', 'otel-spans.json is missing');
      const n = Array.isArray(j.spans) ? j.spans.length : 0;
      return n ? ok(`${n} span(s) recorded`) : empty0('otel-spans.json has 0 spans');
    }
    case 'ts-all-defs-uses': {
      const j = main('ts-all-defs-uses-report.json') ?? main('defs_uses.json'); if (j === undefined) return R('NO_DATA', 'ts-all-defs-uses-report.json is missing');
      if (String(j.status || 'OK').toUpperCase() !== 'OK') return R('NO_DATA', `ts-all-defs-uses status is ${j.status}`);
      const d = num(j.total_definitions);
      return d && d > 0 ? ok(`${d} definitions, ${j.definitions_with_references ?? '?'} with references${j.has_coverage_data ? '' : ' (no coverage data)'}`) : empty0('ts-all-defs-uses has total_definitions 0');
    }
    case 'ts-path-coverage': {
      const j = main('ts_path_coverage.json') ?? main('path-coverage.json'); if (j === undefined) return R('NO_DATA', 'ts_path_coverage.json is missing');
      if (String(j.status || 'OK').toUpperCase() !== 'OK') return R('NO_DATA', `ts_path_coverage status is ${j.status}`);
      const p = num(j.total_paths); const files = num(j.files_analyzed);
      return p && p > 0 && files !== 0 ? ok(`${p} paths in ${files ?? '?'} file(s), ${j.covered_paths ?? '?'} covered`, files) : empty0('ts_path_coverage has total_paths / files_analyzed 0');
    }
    case 'ts-coverage-delta': {
      const j = main('coverage-delta.json') ?? main('coverage_delta.json'); if (j === undefined) return R('NO_DATA', 'coverage-delta.json is missing');
      if (j.skipped || j.skip_reason || j.resolution_source === 'baseline_missing') return R('NO_DATA', `coverage delta skipped (${j.skip_reason || j.resolution_source || 'skipped'}) — expected on a first run / shallow history`);
      return !isBlank(j.metrics) || j.diff_coverage != null || j.coverage_delta_metric != null ? ok('coverage delta calculated') : unk('coverage-delta.json has no metrics');
    }
    case 'typescript-perf-dependency': {
      const j = main('perf-dependency-typescript.json'); if (j === undefined) return R('NO_DATA', 'perf-dependency-typescript.json is missing');
      return Object.keys(j).some((k) => k.startsWith('perf_dependency')) ? ok('build / import-overhead metrics present') : unk('perf-dependency-typescript.json has no metrics');
    }
    case 'semgrep-pii': {
      const j = main('semgrep-pii-results.json'); if (j === undefined) return R('NO_DATA', 'semgrep-pii-results.json is missing');
      const sc = Array.isArray(j?.paths?.scanned) ? j.paths.scanned.length : undefined; const r = Array.isArray(j.results) ? j.results.length : 0;
      if (sc === 0) return empty0('paths.scanned is []');
      return r ? ok(`${r} PII-in-log finding(s)`, sc) : j.version || sc !== undefined ? cleanR('no PII in log statements', sc) : unk('semgrep-pii-results.json is empty');
    }
    case 'semgrep-perf-static': {
      const j = main('semgrep-perf-static.json'); if (j === undefined) return R('NO_DATA', 'semgrep-perf-static.json is missing');
      return !isBlank(j) ? ok('performance pattern results present') : unk('semgrep-perf-static.json is empty');
    }
    default: return checkJs(tool, f); // lizard, git-churn, pydriller, gitleaks, detect-secrets, presidio, semgrep, nyc-mocha: same files as JavaScript
  }
}

// ---------- applying it ----------
export interface TsSummary {
  language: 'typescript'; version: string; packageManager: string; layout: string; assumption: string;
  expected: number; ok: number; clean: number; empty: number; falseEmpty: number; failed: number;
  missing: string[]; naByDesign: string[]; optionalMissing: string[]; optionalFailed: string[]; outsideMatrix: string[]; contamination: string[]; notApplicable: string[];
  defects: PyDefect[]; repoDefects: string[];
}
const sev = (s: PyStatus | 'NOT_APPLICABLE') => (s === 'FAILED' ? 5 : s === 'FALSE_EMPTY' ? 4 : s === 'NO_DATA' ? 3 : s === 'EMPTY_UNKNOWN' ? 2 : s === 'CLEAN' ? 1 : 0);

/** customer-repo failure vs worker failure (PROMPT_TS_Tool_Bug_Classification_and_Filing, section 2) */
export function tsFailureKind(note: string): { tag: string; repo: boolean } {
  if (/yarn (lock|berry)|yarn audit produced no report|yarn\.lock|\.yarnrc\.yml/i.test(note)) return { tag: '[Runner Execution Defect]', repo: false }; // Yarn Berry is not supported by the runner image (Yarn 1 only)
  if (/ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|Cannot find module|MODULE_NOT_FOUND|error TS\d{4}|tsconfig|SyntaxError|EJSONPARSE|test(s)? failed|AssertionError/i.test(note) && !/Failed to load url @vitest\/coverage/i.test(note)) return { tag: '[Repo Defect — not a platform bug]', repo: true };
  return { tag: '[Runner Execution Defect]', repo: false };
}

export function validateTypeScript(bd: string, rows: any[], inventory: Record<string, string[]>): TsSummary | null {
  const v = tsVersion(bd); if (!v) return null;
  const folders = Object.keys(inventory); const node = v.node;
  const NA = (r: PyResult) => (r.status as string) === 'NOT_APPLICABLE';
  const ign = (process.env.TS_IGNORE_TOOLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const load = (t: string) => { const fl = foldersFor(folders, t); return fl.length ? { fl, map: loadAll(bd, fl) } : null; };
  const nodeLabel = `Node ${v.label}`;

  // 1) rows of the taxonomy report
  for (const row of rows) {
    if (row.language !== 'typescript') continue;
    const names = String(row.tool || '').split(' + ').map((s) => s.trim()).map((n) => canonTool(n)).filter((n): n is string => !!n);
    if (!names.length) continue;
    const parts: { t: string; r: PyResult }[] = [];
    for (const t of names) { const l = load(t); if (l) parts.push({ t, r: checkTs(t, l.map) }); }
    if (!parts.length) { // no folder at all for this row
      const lv = names.map((t) => ({ t, l: level(t, node) }));
      if (lv.every((x) => x.l === 'NO')) { row.result = 'NA'; row.note = `N/A for ${nodeLabel} by design — ${lv.map((x) => why(x.t, node)).join('; ')} (not a bug)`; row.files = []; }
      else if (!lv.some((x) => x.l === 'Y')) { row.result = 'NA'; row.note = `N/A on ${nodeLabel} — ${lv.map((x) => x.t).join(', ')} is optional here (⚠️ in the matrix); not triggered is not a bug`; row.files = []; }
      else if (row.result === 'FAIL') row.note = `[Planning Defect] ${lv.filter((x) => x.l === 'Y').map((x) => x.t).join(', ')} is expected for ${nodeLabel} but was not triggered — no folder in the run`;
      continue;
    }
    const naParts = parts.filter((p) => NA(p.r)); const real = parts.filter((p) => !NA(p.r));
    if (!real.length) {
      if (naParts.some((p) => level(p.t, node) === 'Y')) { row.result = 'FAIL'; row.note = `[Planning Defect] ${naParts.map((p) => p.t).join(', ')} is expected for ${nodeLabel} but only reported not_applicable — ${naParts[0].r.note}`; }
      else { row.result = 'NA'; row.note = `N/A on ${nodeLabel} — ${naParts.map((p) => `${p.t}: ${p.r.note}`).join('; ')}`; }
      continue;
    }
    const worst = real.reduce((a, b) => (sev(b.r.status) > sev(a.r.status) ? b : a));
    const best = real.reduce((a, b) => (sev(b.r.status) < sev(a.r.status) ? b : a));
    const text = real.map((p) => (real.length > 1 ? `${p.t}: ` : '') + p.r.note).join('  +  ');
    const isNo = (p: { t: string }) => level(p.t, node) === 'NO'; const isOpt = (p: { t: string }) => level(p.t, node) === 'OPT';
    const ranExcluded = real.filter((p) => isNo(p) && p.r.status !== 'FAILED').map((p) => p.t);
    if (real.every((p) => isNo(p) && p.r.status === 'FAILED')) { row.result = 'NA'; row.note = `N/A for ${nodeLabel} by design — ${real.map((p) => why(p.t, node)).join('; ')} (it only wrote a failure; not a bug)`; continue; }
    if (ranExcluded.length) { row.result = 'FAIL'; row.note = `[Planning Defect — ${ranExcluded.join(', ')} ran although it must be excluded on ${nodeLabel}] ${text}`; }
    else if (real.every((p) => p.r.status === 'OK' || p.r.status === 'CLEAN')) { row.result = 'PASS'; row.note = text; }
    else if (real.some((p) => p.r.status === 'FAILED')) {
      const f = real.find((p) => p.r.status === 'FAILED')!; const k = tsFailureKind(f.r.note);
      if (isOpt(f)) { row.result = 'EMPTY'; row.note = `optional on ${nodeLabel} (⚠️) — failed, not filed as a bug: ${text}`; }
      else { row.result = k.repo ? 'EMPTY' : 'FAIL'; row.note = `${k.tag} ${text}`; }
    }
    else if (worst.r.status === 'FALSE_EMPTY' && best.r.status !== 'OK') { if (isOpt(worst)) { row.result = 'EMPTY'; row.note = `optional on ${nodeLabel} (⚠️) — ${text}`; } else { row.result = 'FAIL'; row.note = `[False Empty Defect] ${text}`; } }
    else if (best.r.status === 'OK' || best.r.status === 'CLEAN') { row.result = 'PASS'; row.note = text; }
    else { row.result = 'EMPTY'; row.note = text; }
  }

  // 2) whole-run summary: every tool of the matrix, independent of the table rows
  const sum: TsSummary = { language: 'typescript', version: v.label, packageManager: v.pm, layout: v.layout, assumption: v.note, expected: expectedTools(v).length, ok: 0, clean: 0, empty: 0, falseEmpty: 0, failed: 0, missing: [], naByDesign: [], optionalMissing: [], optionalFailed: [], outsideMatrix: [], contamination: [], notApplicable: [], defects: [], repoDefects: [] };
  for (const t of TS_TOOLS) {
    if (ign.includes(t) || EXTRA.includes(t)) continue;
    const lv = level(t, node); const l = load(t); const f = l?.fl[0];
    const r = l ? checkTs(t, l.map) : null; const reportedNA = !!r && NA(r);
    if (lv === 'NO') {
      if (l && !reportedNA && r!.status !== 'FAILED') { sum.outsideMatrix.push(t); sum.defects.push({ tool: t, tag: '[Planning Defect]', observed: 'RAN_BUT_EXCLUDED', note: `${t} ran on ${nodeLabel} although it must be excluded (${why(t, node)})`, folder: f, ranOutsideMatrix: true }); }
      else sum.naByDesign.push(t);
      continue;
    }
    if (!l) { if (lv === 'Y') { sum.missing.push(t); sum.defects.push({ tool: t, tag: '[Planning Defect]', observed: 'NOT_APPLICABLE', note: `${t} is expected for ${nodeLabel} but was not triggered — no folder in the run` }); } else sum.optionalMissing.push(t); continue; }
    if (reportedNA) { sum.notApplicable.push(t); if (lv === 'Y') sum.defects.push({ tool: t, tag: '[Planning Defect]', observed: 'NOT_APPLICABLE', note: `${t} is expected for ${nodeLabel} but only reported not_applicable — ${r!.note}`, folder: f }); continue; }
    if (lv === 'OPT' && (r!.status === 'OK' || r!.status === 'CLEAN')) continue; // optional tools that ran fine are not part of the expected count
    if (r!.status === 'OK') sum.ok++; else if (r!.status === 'CLEAN') sum.clean++;
    else if (r!.status === 'FALSE_EMPTY') { if (lv === 'OPT') { sum.empty++; sum.optionalFailed.push(t); } else { sum.falseEmpty++; sum.defects.push({ tool: t, tag: '[False Empty Defect]', observed: 'Empty report with 0 files scanned', note: r!.note, folder: f }); } }
    else if (r!.status === 'FAILED') { const k = tsFailureKind(r!.note); if (lv === 'OPT') { sum.optionalFailed.push(t); sum.empty++; continue; } sum.failed++; if (k.repo) sum.repoDefects.push(t); else sum.defects.push({ tool: t, tag: '[Runner Execution Defect]', observed: 'FAILED', note: r!.note, folder: f }); }
    else sum.empty++;
  }
  // tools of another language (Python / JavaScript tools are accepted when the repo itself holds such files)
  for (const f of folders) {
    const name = f.replace(/\/$/, ''); const n = nn(name);
    if (IGNORE.includes(n) || canonTool(name)) continue;
    const isPy = PY_FOREIGN.map(nn).includes(n); const isJs = JS_FOREIGN.map(nn).includes(n);
    if ((isPy && !v.hasPython) || (isJs && !v.hasJs) || OTHER_FOREIGN.test(name)) {
      sum.contamination.push(name);
      sum.defects.push({ tool: name, tag: '[Language Contamination]', observed: 'FOREIGN_TOOL_PLANNED', note: `${name} (a non-TypeScript tool) was planned for a TypeScript ${nodeLabel} branch`, folder: f });
    }
  }
  return sum;
}

export function tsSummaryLine(s: TsSummary): string {
  const bits = [`${s.ok} OK`, s.clean ? `${s.clean} clean` : '', s.empty ? `${s.empty} empty` : '', s.falseEmpty ? `${s.falseEmpty} false-empty` : '', s.failed ? `${s.failed} failed` : '', s.missing.length ? `${s.missing.length} missing (${s.missing.join(', ')})` : ''].filter(Boolean);
  return `Node ${s.version} (${s.packageManager}${s.layout ? ', ' + s.layout : ''}) — ${s.expected} tools expected: ${bits.join(' · ')}${s.naByDesign.length ? ` · N/A by design: ${s.naByDesign.join(', ')}` : ''}${s.optionalMissing.length ? ` · optional (⚠️) not run: ${s.optionalMissing.join(', ')}` : ''}${s.optionalFailed.length ? ` · optional (⚠️) failed/empty, not filed: ${s.optionalFailed.join(', ')}` : ''}${s.notApplicable.length ? ` · reported not_applicable: ${s.notApplicable.join(', ')}` : ''}${s.outsideMatrix.length ? ` · ran outside the matrix: ${s.outsideMatrix.join(', ')}` : ''}${s.contamination.length ? ` · LANGUAGE CONTAMINATION: ${s.contamination.join(', ')}` : ''}${s.assumption ? ` · note: ${s.assumption}` : ''}`;
}
