import * as fs from 'fs';
import * as path from 'path';
import { FileMap, PyDefect, PyStatus, R, PyResult, folderFor, isBlank, len, loadTool, nn, num } from './pyValidate';

/**
 * JavaScript tool validation for the S3 evidence of a JAVASCRIPT branch (JS_V<node>_<bundler>_<npm|yarn|pnpm|bun>_<MONO|MICRO>).
 * Rules come from PROMPT_Javascript_Tool_Trigger_Analysis (Node matrix + what each tool's file must hold) and
 * PROMPT_Javascript_Tool_Bug_Classification_and_Filing (which situations are bugs).
 *
 * It only READS the evidence already saved next to the branch (s3-evidence/) and adjusts the tool rows of the existing S3 check.
 * It never fails a run. Same labels as Python: N/A by design · [Planning Defect] · [False Empty Defect] · [Runner Execution Defect] ·
 * [Language Contamination] · [Repo Defect] (flagged, never filed) · clean.
 *
 * Matrix cell meaning:   Y  = must run (missing → Planning Defect)
 *                        OPT = ⚠️ legacy pin / conditional: may run; missing is NOT a bug, if it ran its data is checked
 *                        NO = ❌ excluded by design: not running is right; if it ran → [Planning Defect — ran although excluded]
 */
type Lvl = 'Y' | 'OPT' | 'NO';
export const NODE_VERSIONS = [12, 14, 16, 18, 20, 21, 22, 24];

const ALL_Y = ['lizard', 'git-churn', 'pydriller', 'semgrep', 'gitleaks', 'detect-secrets', 'presidio', 'npm-audit', 'npm-ls', 'npm-outdated', 'npm-view', 'license-checker', 'osv-scanner', 'coverage_delta', 'nyc-mocha'];
const OPT_LT16 = ['jscpd-js', 'eslint', 'eslint-sonarjs', 'eslint-security', 'madge', 'javascript-perf-dependency', 'js-all-defs-uses'];
const NO_LT16_OPT_16 = ['stryker-js', 'js-path-coverage', 'dependency-cruiser'];
const NO_LT16 = ['cyclonedx-npm'];
export const JS_TOOLS = [...ALL_Y, ...OPT_LT16, ...NO_LT16_OPT_16, ...NO_LT16];

export function level(tool: string, node: number): Lvl {
  if (ALL_Y.includes(tool)) return 'Y';
  if (OPT_LT16.includes(tool)) return node < 16 ? 'OPT' : 'Y';
  if (NO_LT16_OPT_16.includes(tool)) return node < 16 ? 'NO' : node === 16 ? 'OPT' : 'Y';
  if (NO_LT16.includes(tool)) return node < 16 ? 'NO' : 'Y';
  return 'OPT';
}
const why = (tool: string, node: number): string => {
  if (NO_LT16_OPT_16.includes(tool)) return tool === 'dependency-cruiser' ? `dependency-cruiser v16+ needs host Node 18+ (excluded on Node ${node})` : `${tool} needs Node 18+ (CUSTOMER_CODE_INCOMPATIBLE_WITH_EXECUTION_ENV on Node ${node})`;
  if (NO_LT16.includes(tool)) return `@cyclonedx/cyclonedx-npm v4+ needs Node 16+ (excluded on Node ${node})`;
  return `${tool} needs a legacy pin on Node ${node}`;
};

/** other folder names a tool is saved under */
const ALIAS: Record<string, string[]> = { 'git-churn': ['git_churn'], 'detect-secrets': ['detect_secrets'], 'coverage_delta': ['coverage-delta'], 'js-all-defs-uses': ['js_all_defs_uses'], 'js-path-coverage': ['js_path_coverage'] };
const PY_FOREIGN = ['bandit', 'pylint', 'radon', 'complexipy', 'pip-audit', 'pip-outdated', 'python-perf-dependency', 'jscpd-py', 'flake8', 'safety', 'coverage-py', 'crosshair', 'cosmic-ray', 'pymcdc', 'py-all-defs-uses', 'py-coverage-delta', 'testmon', 'cognitive-ast-python'];
const OTHER_FOREIGN = /^(checkstyle|spotbugs|pmd|jacoco|pitest|roslyn|coverlet|dotnet|maven|gradle|nuget|java-|csharp-|cs-|javac)/i;
/** shared / platform / legacy folders that are no tool of another language */
const IGNORE = ['_shared', 'github-access-control', 'github_branch_protection', 'github-branch-protection', 'libyear', 'cognitive-ast', 'semgrep-perf-static', 'semgrep-pii', 'jscpd-ts', 'knip', 'oxlint', 'trivy', 'codeql', 'opengrep', 'dolos', 'debtmap', 'cccc', 'git-spark', 'gutcheck', 'monocart-coverage-reports'].map(nn);

export interface JsVersion { node: number; label: string; pm: string; layout: string; hasPython: boolean }
/** JavaScript branch? → Node version, package manager, layout. null = not a JS branch / version outside the matrix → nothing changes. */
export function jsVersion(bd: string): JsVersion | null {
  try {
    const base = path.basename(bd);
    const j = JSON.parse(fs.readFileSync(path.join(bd, 'repo-details.json'), 'utf8'));
    const langs = String(j['Language'] || '') + ' ' + (Array.isArray(j.languages) ? j.languages.join(' ') : '');
    const byPrefix = /^JS_/i.test(base);
    const byRepo = !/^(TS|PY|CS)_/i.test(base) && /java ?script/i.test(langs) && !/type ?script/i.test(langs) && /^node$/i.test(String(j['Build type'] || '').trim());
    if (!byPrefix && !byRepo) return null;
    const mv = /^JS_V(\d+)_/i.exec(base); const rv = /(\d+)/.exec(String(j['Language version'] || ''));
    const node = Number(mv ? mv[1] : rv ? rv[1] : NaN);
    if (!NODE_VERSIONS.includes(node)) return null;
    const pmM = /_(NPM|YARN|PNPM|BUN)(_|$)/i.exec(base);
    const pm = (pmM ? pmM[1] : String(j['Project type'] || 'npm')).toLowerCase();
    const lay = /_(MONO|MICRO)(_|$)/i.exec(base);
    return { node, label: String(node), pm, layout: lay ? lay[1].toLowerCase() : '', hasPython: /python/i.test(langs) };
  } catch { return null; }
}

export function expectedTools(v: JsVersion): string[] {
  const ign = (process.env.JS_IGNORE_TOOLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return JS_TOOLS.filter((t) => level(t, v.node) === 'Y' && !ign.includes(t));
}
const fo = (inv: string[], tool: string) => folderFor(inv, tool) || inv.find((f) => (ALIAS[tool] || []).map(nn).includes(nn(f.replace(/\/$/, ''))));

// ---------- what each tool's file must hold (PROMPT_Javascript_Tool_Trigger_Analysis, sections 3 and 5 step 3) ----------
const ok = (n: string, scanned?: number) => R('OK', n, scanned);
const cleanR = (what: string, scanned?: number) => R('CLEAN', `clean — ${what}${scanned ? `, ${scanned} file(s) scanned` : ''}`, scanned);
const empty0 = (what: string) => R('FALSE_EMPTY', `${what} — nothing was analysed although the repo has JavaScript files`, 0);
const unk = (what: string) => R('EMPTY_UNKNOWN', `${what} (scan count unknown)`);

export function checkJs(tool: string, f: FileMap): PyResult {
  const main = (n: string) => f[n];
  for (const [name, j] of Object.entries(f)) if (/^failure\.json$/i.test(name)) return R('FAILED', `failure.json — ${String((j as any)?.error || (j as any)?.message || (j as any)?.reason || JSON.stringify(j)).replace(/\s+/g, ' ').slice(0, 220)}`);
  if (f['not_applicable.json']) return R('NOT_APPLICABLE' as PyStatus, `the tool reported not_applicable (${String(f['not_applicable.json']?.reason || 'no reason given')})`);
  switch (tool) {
    case 'eslint': case 'eslint-security': case 'eslint-sonarjs': {
      const j = main(`${tool}.json`); if (j === undefined) return R('NO_DATA', `${tool}.json is missing`);
      if (!Array.isArray(j)) return R('NO_DATA', `${tool}.json is not a list of file results`);
      const msgs = j.reduce((a: number, x: any) => a + (Array.isArray(x?.messages) ? x.messages.length : 0), 0);
      if (!j.length) return empty0(`${tool}.json is []`);
      return msgs ? ok(`${msgs} message(s) in ${j.length} file(s)`, j.length) : cleanR('0 messages', j.length);
    }
    case 'jscpd-js': {
      const j = main('jscpd-report.json'); if (j === undefined) return R('NO_DATA', 'jscpd-report.json is missing');
      const t = j?.statistics?.total; const src = num(t?.sources);
      if (src === undefined) return unk('jscpd-report.json has no statistics.total');
      if (src > 0) return ok(`${src} source file(s), ${t.clones ?? 0} clone(s), ${t.percentage ?? 0}% duplication`, src);
      return empty0('statistics.total.sources is 0');
    }
    case 'lizard': {
      const j = main('lizard.json'); const x = main('lizard.xml');
      if (j === undefined && x === undefined) return R('NO_DATA', 'lizard.json / lizard.xml are missing');
      if (Array.isArray(j) && j.length) return ok(`${j.length} file entr${j.length === 1 ? 'y' : 'ies'}`, j.length);
      if (x && num(x.__size) && x.__size > 1500) return ok('lizard.xml holds the function measures (lizard.json is [])');
      return empty0('lizard.json is [] and lizard.xml has no measures');
    }
    case 'nyc-mocha': {
      const s = main('coverage-summary.json'); const n = main('nyc-mocha.json');
      const t = s?.total;
      if (t?.statements) { const st = num(t.statements.total); if (st && st > 0) return ok(`${st} statements, ${t.statements.pct}% covered; branches ${t.branches?.total ?? 0} (${t.branches?.pct}%)`, len(s) - 1); return empty0('coverage-summary.json total has 0 statements'); }
      if (n !== undefined && !isBlank(n)) return ok('nyc-mocha.json has data');
      return s === undefined && n === undefined ? R('NO_DATA', 'coverage-summary.json / nyc-mocha.json are missing') : empty0('coverage report is empty');
    }
    case 'js-path-coverage': case 'js-all-defs-uses': {
      const name = tool === 'js-path-coverage' ? 'js_path_coverage.json' : 'js_all_defs_uses.json'; const j = main(name);
      if (j === undefined) return R('NO_DATA', `${name} is missing`);
      const files = num(j.files_analyzed); const total = tool === 'js-path-coverage' ? num(j.total_paths) : num(j.total_defs);
      if (String(j.status || 'OK').toUpperCase() !== 'OK') return R('NO_DATA', `${name} status is ${j.status}`);
      if (files === 0 || total === 0) return empty0(`${name}: ${files === 0 ? 'files_analyzed' : tool === 'js-path-coverage' ? 'total_paths' : 'total_defs'} is 0`);
      return ok(tool === 'js-path-coverage' ? `${total} paths in ${files} file(s)${j.has_coverage_data ? `, ${j.path_coverage_pct}% covered` : ' (no coverage data)'}` : `${total} definitions, ${j.total_def_use_pairs} def-use pairs in ${files} file(s)`, files);
    }
    case 'stryker-js': {
      const j = main('stryker-report.json'); if (j === undefined) return R('NO_DATA', 'stryker-report.json is missing');
      const files = j.files ? Object.keys(j.files).length : 0; const score = num(j.mutationScore) ?? num(j?.metrics?.mutationScore);
      let mutants = 0; for (const fl of Object.values<any>(j.files || {})) mutants += Array.isArray(fl?.mutants) ? fl.mutants.length : 0;
      if (mutants > 0 || (score !== undefined && files > 0)) return ok(`${mutants} mutant(s) in ${files} file(s)${score !== undefined ? `, mutation score ${score}` : ''}`, files);
      return empty0('stryker-report.json has 0 mutants');
    }
    case 'coverage_delta': {
      const j = main('coverage_delta.json'); if (j === undefined) return R('NO_DATA', 'coverage_delta.json is missing');
      if (j.skip_reason || j.resolution_source === 'baseline_missing') return R('NO_DATA', `no baseline commit to compare with (${j.skip_reason || j.resolution_source}) — expected on a first run`);
      return !isBlank(j.metrics) || j.coverage_delta_metric != null ? ok('coverage delta calculated') : unk('coverage_delta.json has no metrics');
    }
    case 'npm-audit': {
      const j = main('npm-audit.json'); if (j === undefined) return R('NO_DATA', 'npm-audit.json is missing');
      if (j.auditReportVersion === undefined && j.vulnerabilities === undefined) return R('NO_DATA', 'npm-audit.json has no audit report');
      const tot = num(j?.metadata?.vulnerabilities?.total) ?? len(j.vulnerabilities);
      return tot ? ok(`${tot} vulnerabilit${tot === 1 ? 'y' : 'ies'}`) : cleanR('0 vulnerabilities');
    }
    case 'npm-ls': {
      const j = main('npm-ls.json'); if (j === undefined) return R('NO_DATA', 'npm-ls.json is missing');
      const deps = len(j.dependencies) + len(j._dependencies) + len(j.devDependencies);
      return j.name && deps ? ok(`dependency tree of "${j.name}" (${deps} direct entries)`) : j.name ? unk('npm-ls.json has the package but no dependencies') : empty0('npm-ls.json has no tree');
    }
    case 'npm-outdated': {
      const j = main('npm-outdated.json'); if (j === undefined) return R('NO_DATA', 'npm-outdated.json is missing');
      return len(j) ? ok(`${len(j)} outdated package(s)`) : cleanR('nothing outdated');
    }
    case 'npm-view': {
      const j = main('npm-view.json'); if (j === undefined) return R('NO_DATA', 'npm-view.json is missing');
      const n = num(j.package_count) ?? len(j.results);
      return n ? ok(`${n} package(s) looked up${j.errors ? `, ${len(j.errors)} error(s)` : ''}`) : empty0('npm-view.json has 0 packages');
    }
    case 'dependency-cruiser': {
      const j = main('depcruise.json') ?? main('dependency-cruiser.json'); if (j === undefined) return R('NO_DATA', 'depcruise.json is missing');
      const mods = Array.isArray(j?.modules) ? j.modules.length : 0;
      return mods ? ok(`${mods} module(s), ${j?.summary?.violations?.length ?? j?.summary?.totalCruised ?? 0} violation entr(ies)`, mods) : empty0('depcruise.json has no modules');
    }
    case 'madge': {
      const g = main('madge-graph.json') ?? main('madge.json'); const c = main('madge-circular.json');
      if (g === undefined) return R('NO_DATA', 'madge-graph.json is missing');
      const n = len(g);
      return n ? ok(`${n} module(s) in the graph, ${Array.isArray(c) ? c.length : 0} circular path(s)`, n) : empty0('madge-graph.json is {}');
    }
    case 'license-checker': {
      const j = main('licenses.json') ?? main('license-checker.json'); if (j === undefined) return R('NO_DATA', 'licenses.json is missing');
      return len(j) ? ok(`${len(j)} package licence(s)`) : unk('licenses.json is {}');
    }
    case 'cyclonedx-npm': {
      const j = main('bom.json'); if (j === undefined) return R('NO_DATA', 'bom.json is missing');
      const c = Array.isArray(j.components) ? j.components.length : 0;
      return j.bomFormat && c ? ok(`CycloneDX ${j.specVersion || ''} SBOM with ${c} component(s)`) : j.bomFormat ? unk('bom.json has 0 components') : R('NO_DATA', 'bom.json is not a CycloneDX document');
    }
    case 'osv-scanner': {
      const j = main('osv.json') ?? main('osv-scanner.json'); if (j === undefined) return R('NO_DATA', 'osv.json is missing');
      const r = Array.isArray(j.results) ? j.results : [];
      return r.length ? ok(`${r.length} lockfile result(s)`) : cleanR('no lockfile findings');
    }
    case 'javascript-perf-dependency': {
      const j = main('perf-dependency-javascript.json'); if (j === undefined) return R('NO_DATA', 'perf-dependency-javascript.json is missing');
      return Object.keys(j).some((k) => k.startsWith('perf_dependency')) ? ok('import-overhead metrics present') : unk('perf-dependency-javascript.json has no metrics');
    }
    case 'pydriller': {
      const j = main('pydriller.json'); if (j === undefined) return R('NO_DATA', 'pydriller.json is missing');
      const c = num(j.commit_count); return c && c > 0 ? ok(`${c} commit(s), ${j.author_count ?? '?'} author(s)`) : unk('pydriller.json has 0 commits');
    }
    case 'git-churn': {
      const j = main('git_churn.json') ?? main('git-churn.json'); if (j === undefined) return R('NO_DATA', 'git_churn.json is missing');
      const c = num(j.commits); const fl = num(j.files);
      return (c && c > 0) || (fl && fl > 0) || (!('commits' in j) && len(j) > 0) ? ok(c ? `${c} commit(s), ${fl ?? '?'} file(s)` : `${len(j)} file entr(ies)`) : unk('git_churn.json has no commits');
    }
    case 'semgrep': {
      const j = main('semgrep.json'); if (j === undefined) return R('NO_DATA', 'semgrep.json is missing');
      const sc = Array.isArray(j?.paths?.scanned) ? j.paths.scanned.length : undefined; const r = Array.isArray(j.results) ? j.results.length : 0;
      if (sc === undefined) return r ? ok(`${r} finding(s)`) : unk('semgrep.json has no paths.scanned');
      if (sc === 0) return empty0('paths.scanned is []');
      return r ? ok(`${r} finding(s) in ${sc} file(s)`, sc) : cleanR('0 findings', sc);
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
export interface JsSummary {
  language: 'javascript'; version: string; packageManager: string; layout: string;
  expected: number; ok: number; clean: number; empty: number; falseEmpty: number; failed: number;
  missing: string[]; naByDesign: string[]; optionalMissing: string[]; outsideMatrix: string[]; contamination: string[]; notApplicable: string[];
  defects: PyDefect[]; repoDefects: string[];
}
const sev = (s: PyStatus | 'NOT_APPLICABLE') => (s === 'FAILED' ? 5 : s === 'FALSE_EMPTY' ? 4 : s === 'NO_DATA' ? 3 : s === 'EMPTY_UNKNOWN' ? 2 : s === 'CLEAN' ? 1 : 0);

/** customer-repo failure vs worker failure (PROMPT_Javascript_Tool_Bug_Classification_and_Filing, section 2) */
export function jsFailureKind(note: string): { tag: string; repo: boolean } {
  if (/ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|Cannot find module|MODULE_NOT_FOUND|SyntaxError|package\.json|EJSONPARSE|test(s)? failed|AssertionError/i.test(note)) return { tag: '[Repo Defect — not a platform bug]', repo: true };
  if (/not found|exit code 127|command not found|ENOENT.*bin|OOM|out of memory|killed|timed? ?out|timeout|permanent_runner_error|Traceback|unhandled/i.test(note)) return { tag: '[Runner Execution Defect]', repo: false };
  return { tag: '[Failed — cause unknown, check the tool log]', repo: false };
}

export function validateJavaScript(bd: string, rows: any[], inventory: Record<string, string[]>): JsSummary | null {
  const v = jsVersion(bd); if (!v) return null;
  const folders = Object.keys(inventory); const node = v.node;
  const NA = (r: PyResult) => (r.status as string) === 'NOT_APPLICABLE';

  // 1) rows of the taxonomy report
  for (const row of rows) {
    if (row.language !== 'javascript') continue;
    const prim: string[] = String(row.primary || '').split(' + ').map((s) => s.trim()).filter((s) => s && s !== '(N/A)');
    const notFound = row.result === 'FAIL' && /not triggered — no folder/.test(row.note || '');
    if (notFound) {
      const real = (prim.length ? prim : String(row.tool || '').split(/ \+ | \/ /).map((s) => s.trim())).filter((n) => JS_TOOLS.includes(n));
      if (!real.length) continue;
      const lv = real.map((t) => ({ t, l: level(t, node) }));
      if (lv.every((x) => x.l === 'NO')) { row.result = 'NA'; row.note = `N/A for Node ${v.label} by design — ${lv.map((x) => why(x.t, node)).join('; ')} (not a bug)`; row.files = []; }
      else if (!lv.some((x) => x.l === 'Y')) { row.result = 'NA'; row.note = `N/A on Node ${v.label} — ${lv.map((x) => x.t).join(', ')} is optional here (legacy pin, ⚠️ in the matrix); not triggered is not a bug`; row.files = []; }
      else { const miss = lv.filter((x) => x.l === 'Y').map((x) => x.t); row.note = `[Planning Defect] ${miss.join(', ')} is expected for Node ${v.label} but was not triggered — no folder in the run`; }
      continue;
    }
    const toolNames = String(row.tool || '').split(' + ').map((s) => s.trim()).filter((t) => JS_TOOLS.includes(t));
    if (!toolNames.length || (!(row.files || []).length && row.result === 'FAIL')) continue;
    const parts: { t: string; r: PyResult }[] = [];
    for (const t of toolNames) { const f = fo(folders, t); if (f) parts.push({ t, r: checkJs(t, loadTool(bd, f)) }); }
    if (!parts.length) continue;
    const naParts = parts.filter((p) => NA(p.r)); const real = parts.filter((p) => !NA(p.r));
    if (!real.length) { // the tool wrote only not_applicable.json
      const lvs = naParts.map((p) => level(p.t, node));
      if (lvs.some((l) => l === 'Y')) { row.result = 'FAIL'; row.note = `[Planning Defect] ${naParts.map((p) => p.t).join(', ')} is expected for Node ${v.label} but only reported not_applicable — ${naParts[0].r.note}`; }
      else { row.result = 'NA'; row.note = `N/A on Node ${v.label} — ${naParts.map((p) => `${p.t}: ${p.r.note}`).join('; ')}`; }
      continue;
    }
    const worst = real.reduce((a, b) => (sev(b.r.status) > sev(a.r.status) ? b : a));
    const best = real.reduce((a, b) => (sev(b.r.status) < sev(a.r.status) ? b : a));
    const text = real.map((p) => (real.length > 1 ? `${p.t}: ` : '') + p.r.note).join('  +  ');
    const outside = real.filter((p) => level(p.t, node) === 'NO').map((p) => p.t);
    const pre = outside.length ? `[Planning Defect — ${outside.join(', ')} ran although it must be excluded on Node ${v.label}] ` : '';
    if (outside.length) { row.result = 'FAIL'; row.note = `${pre}${text}`; }
    else if (real.every((p) => p.r.status === 'OK' || p.r.status === 'CLEAN')) { row.result = 'PASS'; row.note = text; }
    else if (real.some((p) => p.r.status === 'FAILED')) { const f = real.find((p) => p.r.status === 'FAILED')!; const k = jsFailureKind(f.r.note); row.result = k.repo ? 'EMPTY' : 'FAIL'; row.note = `${k.tag} ${text}`; }
    else if (worst.r.status === 'FALSE_EMPTY' && best.r.status !== 'OK') { row.result = 'FAIL'; row.note = `[False Empty Defect] ${text}`; }
    else if (best.r.status === 'OK' || best.r.status === 'CLEAN') { row.result = 'PASS'; row.note = text; }
    else { row.result = 'EMPTY'; row.note = text; }
  }

  // 2) whole-run summary: every tool of the matrix, independent of the table rows
  const sum: JsSummary = { language: 'javascript', version: v.label, packageManager: v.pm, layout: v.layout, expected: expectedTools(v).length, ok: 0, clean: 0, empty: 0, falseEmpty: 0, failed: 0, missing: [], naByDesign: [], optionalMissing: [], outsideMatrix: [], contamination: [], notApplicable: [], defects: [], repoDefects: [] };
  const ign = (process.env.JS_IGNORE_TOOLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const t of JS_TOOLS) {
    const lv = level(t, node); const f = fo(folders, t);
    if (ign.includes(t)) continue;
    const r = f ? checkJs(t, loadTool(bd, f)) : null;
    const reportedNA = !!r && NA(r);
    if (lv === 'NO') {
      if (f && !reportedNA) { sum.outsideMatrix.push(t); sum.defects.push({ tool: t, tag: '[Planning Defect]', observed: 'RAN_BUT_EXCLUDED', note: `${t} ran on Node ${v.label} although it must be excluded (${why(t, node)})`, folder: f, ranOutsideMatrix: true }); }
      else sum.naByDesign.push(t);
      continue;
    }
    if (!f) { if (lv === 'Y') { sum.missing.push(t); sum.defects.push({ tool: t, tag: '[Planning Defect]', observed: 'NOT_APPLICABLE', note: `${t} is expected for Node ${v.label} but was not triggered — no folder in the run` }); } else sum.optionalMissing.push(t); continue; }
    if (reportedNA) { sum.notApplicable.push(t); if (lv === 'Y') sum.defects.push({ tool: t, tag: '[Planning Defect]', observed: 'NOT_APPLICABLE', note: `${t} is expected for Node ${v.label} but only reported not_applicable — ${r!.note}`, folder: f }); continue; }
    if (r!.status === 'OK') sum.ok++; else if (r!.status === 'CLEAN') sum.clean++;
    else if (r!.status === 'FALSE_EMPTY') { sum.falseEmpty++; sum.defects.push({ tool: t, tag: '[False Empty Defect]', observed: 'Empty JSON with 0 files scanned', note: r!.note, folder: f }); }
    else if (r!.status === 'FAILED') { sum.failed++; const k = jsFailureKind(r!.note); if (k.repo) sum.repoDefects.push(t); else sum.defects.push({ tool: t, tag: '[Runner Execution Defect]', observed: 'FAILED', note: r!.note, folder: f }); }
    else sum.empty++;
  }
  // tools of another language (Python tools are accepted when the repo itself contains Python files)
  for (const f of folders) {
    const name = f.replace(/\/$/, ''); const n = nn(name);
    if (IGNORE.includes(n) || JS_TOOLS.some((t) => [t, ...(ALIAS[t] || [])].map(nn).includes(n))) continue;
    const isPy = PY_FOREIGN.map(nn).includes(n);
    if ((isPy && !v.hasPython) || OTHER_FOREIGN.test(name)) {
      sum.contamination.push(name);
      sum.defects.push({ tool: name, tag: '[Language Contamination]', observed: 'FOREIGN_TOOL_PLANNED', note: `${name} (a non-JavaScript tool) was planned for a JavaScript Node ${v.label} branch`, folder: f });
    }
  }
  return sum;
}

export function jsSummaryLine(s: JsSummary): string {
  const bits = [`${s.ok} OK`, s.clean ? `${s.clean} clean` : '', s.empty ? `${s.empty} empty` : '', s.falseEmpty ? `${s.falseEmpty} false-empty` : '', s.failed ? `${s.failed} failed` : '', s.missing.length ? `${s.missing.length} missing (${s.missing.join(', ')})` : ''].filter(Boolean);
  return `Node ${s.version} (${s.packageManager}${s.layout ? ', ' + s.layout : ''}) — ${s.expected} tools expected: ${bits.join(' · ')}${s.naByDesign.length ? ` · N/A by design: ${s.naByDesign.join(', ')}` : ''}${s.optionalMissing.length ? ` · optional (⚠️) not run: ${s.optionalMissing.join(', ')}` : ''}${s.notApplicable.length ? ` · reported not_applicable: ${s.notApplicable.join(', ')}` : ''}${s.outsideMatrix.length ? ` · ran outside the matrix: ${s.outsideMatrix.join(', ')}` : ''}${s.contamination.length ? ` · LANGUAGE CONTAMINATION: ${s.contamination.join(', ')}` : ''}`;
}
