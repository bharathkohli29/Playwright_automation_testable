import * as fs from 'fs';
import * as path from 'path';
import { FileMap, PyDefect, PyStatus, R, PyResult, isBlank, len, loadTool, nn, num } from './pyValidate';

/**
 * Java (JVM) tool validation for the S3 evidence of a Java branch (JV_V<n>_<build>_<packaging>_<MONO|MICRO>).
 * Rules come from PROMPT_Java_Tool_Trigger_Analysis (version matrix + what each tool's file must hold) and
 * PROMPT_Java_Tool_Bug_Classification_and_Filing (which situations are bugs).
 *
 * It only READS the evidence already saved next to the branch (s3-evidence/) and adjusts the Java tool rows of the existing S3 check.
 * It never fails a run. Same labels as the other languages: N/A by design · [Planning Defect] · [False Empty Defect] ·
 * [Runner Execution Defect] · [Language Contamination] · [Repo Defect] (flagged, never filed) · clean.
 *
 * Matrix cell meaning:  Y   = must run (missing → Planning Defect)
 *                       OPT = ⚠️ optional: not running is NOT a bug, a failure is only noted, if it ran its data is checked
 *                       NO  = ❌ excluded by design: not running is right; if it ran with data → [Planning Defect — ran although excluded]
 * Java 8 has no execution container in the cluster → jacoco / pitest (executesCustomerCode) are NO on Java 8.
 */
type Lvl = 'Y' | 'OPT' | 'NO';
export type JCol = '8' | '11' | '16' | '17' | '21';
export const JAVA_COLS: JCol[] = ['8', '11', '16', '17', '21'];

const ALL_Y = ['lizard', 'cpd', 'git-churn', 'pydriller', 'semgrep', 'gitleaks', 'detect-secrets', 'presidio', 'maven-checksum', 'checkstyle', 'pmd', 'owasp-depcheck', 'maven-versions', 'ck', 'java-perf-dependency', 'java-coverage-delta'];
const OPT_8 = ['spotbugs', 'java-all-defs-uses']; // ⚠️ on Java 8, ✅ above
const EXEC = ['jacoco', 'pitest']; // ❌ Java 8 (no execution container), ✅ 11+
const EXTRA = ['semgrep-pii', 'semgrep-perf-static']; // seen in real runs, not in the matrix: checked when present, never required
export const JAVA_TOOLS = [...ALL_Y, ...OPT_8, ...EXEC, ...EXTRA];

export function level(tool: string, col: JCol): Lvl {
  if (ALL_Y.includes(tool)) return 'Y';
  if (OPT_8.includes(tool)) return col === '8' ? 'OPT' : 'Y';
  if (EXEC.includes(tool)) return col === '8' ? 'NO' : 'Y';
  return 'OPT';
}
const why = (tool: string, v: JavaVersion): string => (EXEC.includes(tool) ? `${tool} executes customer code and the cluster has no execution container for ${v.label} (CUSTOMER_CODE_INCOMPATIBLE_WITH_EXECUTION_ENV)` : `${tool} is not expected on ${v.label}`);

/** other folder names / file spellings a tool is saved under */
const ALIAS: Record<string, string[]> = {
  'java-all-defs-uses': ['def_use', 'def-use', 'java_all_defs_uses'], 'java-coverage-delta': ['coverage_delta', 'coverage-delta', 'java_coverage_delta'],
  'git-churn': ['git_churn'], 'detect-secrets': ['detect_secrets'], 'owasp-depcheck': ['owasp_depcheck', 'dependency-check'], 'maven-versions': ['maven_versions'],
  'maven-checksum': ['maven_checksum'], 'java-perf-dependency': ['java_perf_dependency'], 'semgrep-pii': ['semgrep_pii'], 'semgrep-perf-static': ['semgrep_perf_static'],
};
const foldersFor = (inv: string[], tool: string) => { const want = [tool, ...(ALIAS[tool] || [])].map(nn); return inv.filter((f) => want.includes(nn(f.replace(/\/$/, '')))); };
/** the matrix tool a folder / row name stands for */
export const canonTool = (name: string): string | undefined => JAVA_TOOLS.find((t) => [t, ...(ALIAS[t] || [])].map(nn).includes(nn(name.replace(/\/$/, ''))));
function loadAll(bd: string, folders: string[]): FileMap {
  const out: FileMap = {};
  for (const f of folders) for (const [k, v] of Object.entries(loadTool(bd, f))) { const p = out[k]; if (p === undefined || (isBlank(p) && !isBlank(v))) out[k] = v; }
  return out;
}
/** full text of a saved file (the FileMap only keeps the first 1200 characters of xml / txt) */
function fullText(bd: string, folders: string[], name: string): string | undefined {
  for (const folder of folders) {
    const root = path.join(bd, 's3-evidence', folder.replace(/\/$/, ''));
    const walk = (d: string): string | undefined => {
      let es: fs.Dirent[] = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return undefined; }
      for (const e of es) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) { const r = walk(f); if (r !== undefined) return r; }
        else if (e.name === name) { try { return fs.readFileSync(f, 'utf8').slice(0, 30_000_000); } catch { return undefined; } }
      }
      return undefined;
    };
    const r = walk(root); if (r !== undefined) return r;
  }
  return undefined;
}

const PY_FOREIGN = ['bandit', 'pylint', 'radon', 'complexipy', 'pip-audit', 'pip-outdated', 'python-perf-dependency', 'jscpd-py', 'flake8', 'safety', 'coverage-py', 'crosshair', 'cosmic-ray', 'pymcdc', 'py-all-defs-uses', 'py-coverage-delta', 'testmon'];
const OTHER_FOREIGN = /^(eslint|npm|nyc|stryker|madge|dependency-cruiser|license-checker|osv-scanner|cyclonedx|js-|ts-|javascript-|typescript-|jscpd-(js|ts|cs)|roslyn|coverlet|altcover|dotnet|cs-|csharp-|cs_|security-code-scan|sonar-cs|nuget)/i;
/** shared / platform / legacy folders that are no tool of another language */
const IGNORE = ['_shared', 'github-access-control', 'github_branch_protection', 'github-branch-protection', 'libyear', 'cognitive-ast', 'jscpd-ts', 'knip', 'oxlint', 'trivy', 'codeql', 'opengrep', 'dolos', 'debtmap', 'cccc', 'git-spark', 'gutcheck', 'monocart-coverage-reports'].map(nn);

export interface JavaVersion { col: JCol; label: string; version: string; target: string; buildTool: string; hasPython: boolean; note: string }
/** Java branch? → matrix column + readable label. null = not a Java branch → nothing changes. */
export function javaVersion(bd: string): JavaVersion | null {
  try {
    const base = path.basename(bd);
    let j: any = {}; try { j = JSON.parse(fs.readFileSync(path.join(bd, 'repo-details.json'), 'utf8')); } catch { /* none */ }
    const langs = String(j['Language'] || '') + ' ' + (Array.isArray(j.languages) ? j.languages.join(' ') : '');
    const isJava = /^JV_/i.test(base) || (/(^|[\s,])java(?![a-z])/i.test(langs) && !/^(JS|TS|PY|CS)_/i.test(base));
    if (!isJava) return null;
    const hasPython = /python/i.test(langs);
    const build = String(j['Build type'] || j['Project type'] || '').toLowerCase() || (/gradle/i.test(base) ? 'gradle' : 'maven');
    const m = /^JV_V(\d+)(?:_|$)/i.exec(base); let n = m ? Number(m[1]) : NaN;
    if (!m) { const rv = /^(?:1\.)?(\d+)/.exec(String(j['Language version'] || '').trim()); n = rv ? Number(rv[1]) : NaN; }
    if (!Number.isFinite(n)) return null;
    const mk = (col: JCol, note = ''): JavaVersion => ({ col, label: `Java ${n}`, version: String(n), target: `JDK ${n}`, buildTool: build, hasPython, note });
    if (JAVA_COLS.includes(String(n) as JCol)) return mk(String(n) as JCol);
    const col: JCol = n <= 8 ? '8' : n <= 11 ? '11' : n <= 16 ? '16' : n <= 17 ? '17' : '21';
    return mk(col, `Java ${n} is not in the QA matrix — judged like Java ${col} (assumption)`);
  } catch { return null; }
}

export function expectedTools(v: JavaVersion): string[] {
  const ign = (process.env.JAVA_IGNORE_TOOLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return JAVA_TOOLS.filter((t) => level(t, v.col) === 'Y' && !ign.includes(t));
}

// ---------- what each tool's file must hold (PROMPT_Java_Tool_Trigger_Analysis, section 3 and 5 step 3) ----------
const ok = (n: string, scanned?: number) => R('OK', n, scanned);
const cleanR = (what: string, scanned?: number) => R('CLEAN', `clean — ${what}${scanned ? `, ${scanned} file(s) scanned` : ''}`, scanned);
const empty0 = (what: string) => R('FALSE_EMPTY', `${what} — nothing was analysed although the repo has Java files`, 0);
const unk = (what: string) => R('EMPTY_UNKNOWN', `${what} (scan count unknown)`);
const count = (s: string, re: RegExp) => (s.match(re) || []).length;
const mvnFail = (t: string): string | undefined => (/BUILD FAILURE|\[ERROR\] Failed to execute goal|\[ERROR\].*(COMPILATION ERROR|Could not resolve dependencies)/.test(t) ? (t.split('\n').find((l) => /\[ERROR\]/.test(l) && !/^\[ERROR\]\s*$/.test(l)) || 'BUILD FAILURE').replace(/\s+/g, ' ').slice(0, 240) : undefined);

export function checkJava(tool: string, f: FileMap, txt: (name: string) => string | undefined): PyResult {
  const main = (n: string) => f[n];
  for (const [name, j] of Object.entries(f)) if (/^failure\.json$/i.test(name)) return R('FAILED', `failure.json — ${String((j as any)?.reason || (j as any)?.error || (j as any)?.message || JSON.stringify(j)).replace(/\s+/g, ' ').slice(0, 260)}`);
  if (f['not_applicable.json']) return R('NOT_APPLICABLE' as PyStatus, `the tool reported not_applicable (${String(f['not_applicable.json']?.reason || 'no reason given')})`);
  switch (tool) {
    case 'checkstyle': {
      const x = txt('checkstyle-result.xml'); const j = main('checkstyle.json');
      if (x === undefined && j === undefined) return R('NO_DATA', 'checkstyle-result.xml / checkstyle.json are missing');
      if (x !== undefined) {
        const files = count(x, /<file\s/g); const errs = count(x, /<error\s/g);
        if (!/<checkstyle/.test(x)) return R('NO_DATA', 'checkstyle-result.xml is not a checkstyle report');
        if (!files) return empty0('checkstyle-result.xml lists 0 files');
        return errs ? ok(`${errs} style violation(s) in ${files} file(s)`, files) : cleanR('0 style violations', files);
      }
      return !isBlank(j) ? ok('checkstyle.json has data') : empty0('checkstyle.json is empty');
    }
    case 'spotbugs': {
      const x = txt('spotbugsXml.xml'); const j = main('spotbugs.json');
      if (x === undefined && j === undefined) return R('NO_DATA', 'spotbugsXml.xml / spotbugs.json are missing');
      if (x !== undefined) {
        if (!/<BugCollection/.test(x)) return R('NO_DATA', 'spotbugsXml.xml is not a SpotBugs report');
        const bugs = count(x, /<BugInstance\s/g); const cls = /total_classes="(\d+)"/.exec(x); const tc = cls ? Number(cls[1]) : undefined;
        if (bugs) return ok(`${bugs} bug instance(s)${tc !== undefined ? ` in ${tc} class(es)` : ''}`, tc);
        if (tc === 0) return empty0('spotbugsXml.xml analysed 0 classes (total_classes="0")');
        return tc ? cleanR('0 bug instances', tc) : unk('spotbugsXml.xml has no bug instances');
      }
      return !isBlank(j) ? ok('spotbugs.json has data') : empty0('spotbugs.json is empty');
    }
    case 'pmd': {
      const x = txt('pmd.xml'); const j = main('pmd.json');
      if (x === undefined && j === undefined) return R('NO_DATA', 'pmd.xml / pmd.json are missing');
      if (x !== undefined) {
        if (!/<pmd[\s>]/.test(x)) return R('NO_DATA', 'pmd.xml is not a PMD report');
        const v = count(x, /<violation\s/g); const files = count(x, /<file\s/g);
        if (v) return ok(`${v} rule violation(s) in ${files} file(s)`, files);
        return cleanR('0 rule violations');
      }
      return !isBlank(j) ? ok('pmd.json has data') : empty0('pmd.json is empty');
    }
    case 'cpd': {
      const x = txt('cpd.xml'); const j = main('cpd.json');
      if (x === undefined && j === undefined) return R('NO_DATA', 'cpd.xml / cpd.json are missing');
      if (x !== undefined) {
        if (!/<pmd-cpd/.test(x)) return R('NO_DATA', 'cpd.xml is not a CPD report');
        const d = count(x, /<duplication\s/g); return d ? ok(`${d} duplicated block(s)`) : cleanR('no duplicated code found');
      }
      return !isBlank(j) ? ok('cpd.json has data') : unk('cpd.json is empty');
    }
    case 'jacoco': {
      const x = txt('jacoco.xml'); const j = main('jacoco.json');
      if (x === undefined && j === undefined) return R('NO_DATA', 'jacoco.xml / jacoco.json are missing');
      if (x !== undefined) {
        if (!/<report/.test(x)) return R('NO_DATA', 'jacoco.xml is not a JaCoCo report');
        if (!/<package\s/.test(x)) return empty0('jacoco.xml has no packages / classes (nothing was instrumented)');
        const tail = x.slice(x.lastIndexOf('</package>')); // report level counters follow the last package
        const c = (type: string) => { const m = new RegExp(`<counter type="${type}" missed="(\\d+)" covered="(\\d+)"`).exec(tail); return m ? { miss: Number(m[1]), cov: Number(m[2]) } : undefined; };
        const line = c('LINE'); const br = c('BRANCH'); const instr = c('INSTRUCTION');
        const total = line ? line.miss + line.cov : instr ? instr.miss + instr.cov : 0;
        if (!total) return empty0('jacoco.xml report totals are 0 lines');
        const pct = (a?: { miss: number; cov: number }) => (a && a.miss + a.cov ? `${((a.cov / (a.miss + a.cov)) * 100).toFixed(1)}%` : 'n/a');
        return ok(`${total} lines, ${pct(line)} line / ${pct(br)} branch coverage`, total);
      }
      return !isBlank(j) ? ok('jacoco.json has data') : empty0('jacoco.json is empty');
    }
    case 'pitest': {
      const x = txt('mutations.xml'); const j = main('pitest.json');
      if (x === undefined && j === undefined) return R('NO_DATA', 'mutations.xml / pitest.json are missing');
      if (x !== undefined) {
        const n = count(x, /<mutation\s/g); if (!n) return empty0('mutations.xml has 0 mutations');
        const killed = count(x, /status='KILLED'|status="KILLED"/g);
        return ok(`${n} mutation(s), ${killed} killed, mutation score ${((killed / n) * 100).toFixed(1)}%`, n);
      }
      return !isBlank(j) ? ok('pitest.json has data') : empty0('pitest.json is empty');
    }
    case 'ck': {
      const x = txt('class.csv'); const j = main('ck.json');
      if (x === undefined && j === undefined) return R('NO_DATA', 'class.csv / ck.json are missing');
      if (x !== undefined) {
        const lines = x.split(/\r?\n/).filter((l) => l.trim()); const rows = Math.max(0, lines.length - 1);
        if (!/wmc|cbo|rfc/i.test(lines[0] || '')) return unk('class.csv has no WMC / CBO / RFC columns');
        return rows ? ok(`${rows} class(es) measured (WMC, CBO, RFC …)`, rows) : empty0('class.csv has a header and 0 classes');
      }
      return !isBlank(j) ? ok('ck.json has data') : empty0('ck.json is empty');
    }
    case 'owasp-depcheck': {
      const x = txt('dependency-check-report.xml'); const j = main('owasp.json');
      if (x === undefined && j === undefined) return R('NO_DATA', 'dependency-check-report.xml / owasp.json are missing');
      if (x !== undefined) {
        if (!/<analysis/.test(x)) return R('NO_DATA', 'dependency-check-report.xml is not an OWASP report');
        const deps = count(x, /<dependency[\s>]/g); const vul = count(x, /<vulnerability[\s>]/g);
        if (!deps) return empty0('dependency-check-report.xml lists 0 dependencies');
        return vul ? ok(`${deps} dependenc${deps === 1 ? 'y' : 'ies'} scanned, ${vul} vulnerabilit${vul === 1 ? 'y' : 'ies'}`, deps) : cleanR('no known vulnerabilities', deps);
      }
      return !isBlank(j) ? ok('owasp.json has data') : empty0('owasp.json is empty');
    }
    case 'maven-versions': {
      const x = txt('versions-display-dependency-updates.txt') ?? txt('versions-output.txt'); const j = main('maven-versions.json');
      if (x === undefined && j === undefined) return R('NO_DATA', 'versions-output.txt / maven-versions.json are missing');
      if (x !== undefined) {
        const bad = mvnFail(x); if (bad) return R('FAILED', `maven versions plugin failed — ${bad}`);
        const newer = count(x, /\s->\s/g);
        if (newer) return ok(`${newer} dependenc${newer === 1 ? 'y has' : 'ies have'} a newer release`);
        return /latest versions|BUILD SUCCESS|No dependencies/i.test(x) ? cleanR('all dependencies are up to date') : unk('versions output has no result lines');
      }
      return !isBlank(j) ? ok('maven-versions.json has data') : unk('maven-versions.json is empty');
    }
    case 'maven-checksum': {
      const x = txt('checksum-output.txt') ?? txt('maven-checksum.txt'); const j = main('maven-checksum.json');
      if (x === undefined && j === undefined) return R('NO_DATA', 'checksum-output.txt / maven-checksum.json are missing');
      if (x !== undefined) {
        const bad = mvnFail(x); if (bad) return R('FAILED', `maven dependency resolve failed — ${bad}`);
        const jars = count(x, /^\[INFO\]\s+[\w.\-]+:[\w.\-]+:(jar|pom|war|bundle):/gm);
        return jars ? ok(`${jars} artifact(s) resolved and checked`, jars) : /resolved|BUILD SUCCESS/i.test(x) ? cleanR('no dependencies to check') : unk('checksum output lists no artifacts');
      }
      return !isBlank(j) ? ok('maven-checksum.json has data') : unk('maven-checksum.json is empty');
    }
    case 'java-all-defs-uses': {
      const j = main('defs_uses.json') ?? main('def_use.json'); if (j === undefined) return R('NO_DATA', 'defs_uses.json / def_use.json are missing');
      if (/NOT_IMPLEMENTED/i.test(String(j.status || '')) || /not_implemented/i.test(String(j.detail_code || ''))) return empty0('the analyzer is only a stub (status NOT_IMPLEMENTED, no definitions or uses were computed)');
      if (/FAIL|ERROR/i.test(String(j.status || ''))) return R('FAILED', `def_use status ${j.status}${j.detail_code ? ` (${j.detail_code})` : ''}`);
      const classes = len(j.classes);
      return classes || len(j.pairs) || len(j.definitions) ? ok(`${classes} class(es) with definition / use data${j.detail_code ? ` (${j.detail_code})` : ''}`, classes) : empty0('def_use.json has 0 classes');
    }
    case 'java-coverage-delta': {
      const j = main('coverage_delta.json') ?? main('java_coverage_delta.json'); if (j === undefined) return R('NO_DATA', 'coverage_delta.json is missing');
      if (/SKIPPED/i.test(String(j.status || '')) || j.skip_reason === 'baseline_missing' || j.resolution_source === 'baseline_missing') return R('NO_DATA', `no baseline commit to compare with (${j.skip_reason || j.resolution_source || 'skipped'}) — expected on a first run`);
      return !isBlank(j.metrics) || j.coverage_delta_metric != null ? ok('coverage delta calculated') : unk('coverage_delta.json has no metrics');
    }
    case 'java-perf-dependency': {
      const j = main('perf-dependency-java.json'); if (j === undefined) return R('NO_DATA', 'perf-dependency-java.json is missing');
      return Object.keys(j).some((k) => k.startsWith('perf_dependency')) ? ok('dependency / import-overhead metrics present') : unk('perf-dependency-java.json has no metrics');
    }
    case 'semgrep-perf-static': {
      const j = main('semgrep-perf-static.json'); if (j === undefined) return R('NO_DATA', 'semgrep-perf-static.json is missing');
      return !isBlank(j) ? ok('performance pattern results present') : unk('semgrep-perf-static.json is empty');
    }
    case 'lizard': {
      const j = main('lizard.json'); const x = txt('lizard.xml');
      if (j === undefined && x === undefined) return R('NO_DATA', 'lizard.json / lizard.xml are missing');
      if (Array.isArray(j) && j.length) return ok(`${j.length} file entr${j.length === 1 ? 'y' : 'ies'}`, j.length);
      if (x !== undefined) { const n = count(x, /<item\s/g); if (n) return ok(`${n} function / file measure(s) in lizard.xml`, n); }
      return empty0('lizard.json is [] and lizard.xml has no measures');
    }
    case 'pydriller': {
      const j = main('pydriller.json'); if (j === undefined) return R('NO_DATA', 'pydriller.json is missing');
      const c = num(j.commit_count); return c && c > 0 ? ok(`${c} commit(s), ${j.author_count ?? '?'} author(s)`) : unk('pydriller.json has 0 commits');
    }
    case 'git-churn': {
      const a = main('git-churn.json'); const b = main('git_churn.json');
      if (a === undefined && b === undefined) return R('NO_DATA', 'git-churn.json is missing');
      const files = a && !Array.isArray(a) ? Object.keys(a).filter((k) => !k.startsWith('__')).length : Array.isArray(a) ? a.length : 0; const commits = num(b?.commits);
      return files > 0 || (commits && commits > 0) ? ok(files ? `${files} file entr${files === 1 ? 'y' : 'ies'} with churn` : `${commits} commit(s)`) : unk('git churn has no commits / files');
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
export interface JavaSummary {
  language: 'java'; version: string; target: string; packageManager: string; assumption: string;
  expected: number; ok: number; clean: number; empty: number; falseEmpty: number; failed: number;
  missing: string[]; naByDesign: string[]; optionalMissing: string[]; optionalFailed: string[]; outsideMatrix: string[]; contamination: string[]; notApplicable: string[];
  defects: PyDefect[]; repoDefects: string[];
}
const sev = (s: PyStatus | 'NOT_APPLICABLE') => (s === 'FAILED' ? 5 : s === 'FALSE_EMPTY' ? 4 : s === 'NO_DATA' ? 3 : s === 'EMPTY_UNKNOWN' ? 2 : s === 'CLEAN' ? 1 : 0);

/** customer-repo failure vs worker failure (PROMPT_Java_Tool_Bug_Classification_and_Filing, section 2) */
export function javaFailureKind(note: string): { tag: string; repo: boolean } {
  if (/JAVA_HOME|java: (command )?not found|command not found|exit code 127|OutOfMemory|\bOOM\b|out of memory|Killed|timed? ?out|timeout|Traceback|unhandled|UnsupportedClassVersionError|class file major version|bad object|lock .* already exist|no space left/i.test(note)) return { tag: '[Runner Execution Defect]', repo: false };
  if (/COMPILATION ERROR|compilation failure|Could not resolve dependencies|Could not find artifact|Non-resolvable|There are test failures|Tests run:.*(Failures|Errors): [1-9]|No POM|pom\.xml.*(malformed|not found)|Unresolveable build extension/i.test(note)) return { tag: '[Repo Defect — not a platform bug]', repo: true };
  return { tag: '[Runner Execution Defect]', repo: false };
}

export function validateJava(bd: string, rows: any[], inventory: Record<string, string[]>): JavaSummary | null {
  const v = javaVersion(bd); if (!v) return null;
  const folders = Object.keys(inventory); const col = v.col;
  const NA = (r: PyResult) => (r.status as string) === 'NOT_APPLICABLE';
  const ign = (process.env.JAVA_IGNORE_TOOLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const load = (t: string) => { const fl = foldersFor(folders, t); return fl.length ? { fl, map: loadAll(bd, fl), txt: (n: string) => fullText(bd, fl, n) } : null; };
  const run = (t: string, l: NonNullable<ReturnType<typeof load>>) => checkJava(t, l.map, l.txt);

  // 1) rows of the taxonomy report
  for (const row of rows) {
    if (row.language !== 'java') continue;
    const names = String(row.tool || '').split(' + ').map((s) => s.trim()).map((n) => canonTool(n)).filter((n): n is string => !!n);
    if (!names.length) continue;
    const parts: { t: string; r: PyResult }[] = [];
    for (const t of names) { const l = load(t); if (l) parts.push({ t, r: run(t, l) }); }
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
      const f = real.find((p) => p.r.status === 'FAILED')!; const k = javaFailureKind(f.r.note);
      if (isOpt(f)) { row.result = 'EMPTY'; row.note = `optional on ${v.label} (⚠️) — failed, not filed as a bug: ${text}`; }
      else { row.result = k.repo ? 'EMPTY' : 'FAIL'; row.note = `${k.tag} ${text}`; }
    }
    else if (worst.r.status === 'FALSE_EMPTY' && best.r.status !== 'OK') { if (isOpt(worst)) { row.result = 'EMPTY'; row.note = `optional on ${v.label} (⚠️) — ${text}`; } else { row.result = 'FAIL'; row.note = `[False Empty Defect] ${text}`; } }
    else if (best.r.status === 'OK' || best.r.status === 'CLEAN') { row.result = 'PASS'; row.note = text; }
    else { row.result = 'EMPTY'; row.note = text; }
  }

  // 2) whole-run summary: every tool of the matrix, independent of the table rows
  const sum: JavaSummary = { language: 'java', version: v.version, target: v.target, packageManager: v.buildTool, assumption: v.note, expected: expectedTools(v).length, ok: 0, clean: 0, empty: 0, falseEmpty: 0, failed: 0, missing: [], naByDesign: [], optionalMissing: [], optionalFailed: [], outsideMatrix: [], contamination: [], notApplicable: [], defects: [], repoDefects: [] };
  for (const t of JAVA_TOOLS) {
    if (ign.includes(t) || EXTRA.includes(t)) continue;
    const lv = level(t, col); const l = load(t); const f = l?.fl[0];
    const r = l ? run(t, l) : null; const reportedNA = !!r && NA(r);
    if (lv === 'NO') {
      if (l && !reportedNA && r!.status !== 'FAILED') { sum.outsideMatrix.push(t); sum.defects.push({ tool: t, tag: '[Planning Defect]', observed: 'RAN_BUT_EXCLUDED', note: `${t} ran on ${v.label} although it must be excluded (${why(t, v)})`, folder: f, ranOutsideMatrix: true }); }
      else sum.naByDesign.push(t);
      continue;
    }
    if (!l) { if (lv === 'Y') { sum.missing.push(t); sum.defects.push({ tool: t, tag: '[Planning Defect]', observed: 'NOT_APPLICABLE', note: `${t} is expected for ${v.label} but was not triggered — no folder in the run` }); } else sum.optionalMissing.push(t); continue; }
    if (reportedNA) { sum.notApplicable.push(t); if (lv === 'Y') sum.defects.push({ tool: t, tag: '[Planning Defect]', observed: 'NOT_APPLICABLE', note: `${t} is expected for ${v.label} but only reported not_applicable — ${r!.note}`, folder: f }); continue; }
    if (lv === 'OPT' && (r!.status === 'OK' || r!.status === 'CLEAN')) continue; // optional tools that ran fine are not part of the expected count
    if (r!.status === 'OK') sum.ok++; else if (r!.status === 'CLEAN') sum.clean++;
    else if (r!.status === 'FALSE_EMPTY') { if (lv === 'OPT') { sum.empty++; sum.optionalFailed.push(t); } else { sum.falseEmpty++; sum.defects.push({ tool: t, tag: '[False Empty Defect]', observed: 'Empty report with 0 files scanned', note: r!.note, folder: f }); } }
    else if (r!.status === 'FAILED') { const k = javaFailureKind(r!.note); if (lv === 'OPT') { sum.optionalFailed.push(t); sum.empty++; continue; } sum.failed++; if (k.repo) sum.repoDefects.push(t); else sum.defects.push({ tool: t, tag: '[Runner Execution Defect]', observed: 'FAILED', note: r!.note, folder: f }); }
    else sum.empty++;
  }
  // tools of another language (Python tools are accepted when the repo itself contains Python files)
  for (const f of folders) {
    const name = f.replace(/\/$/, ''); const n = nn(name);
    if (IGNORE.includes(n) || canonTool(name)) continue;
    const isPy = PY_FOREIGN.map(nn).includes(n);
    if ((isPy && !v.hasPython) || OTHER_FOREIGN.test(name)) {
      sum.contamination.push(name);
      sum.defects.push({ tool: name, tag: '[Language Contamination]', observed: 'FOREIGN_TOOL_PLANNED', note: `${name} (a non-Java tool) was planned for a Java ${v.version} branch`, folder: f });
    }
  }
  return sum;
}

export function javaSummaryLine(s: JavaSummary): string {
  const bits = [`${s.ok} OK`, s.clean ? `${s.clean} clean` : '', s.empty ? `${s.empty} empty` : '', s.falseEmpty ? `${s.falseEmpty} false-empty` : '', s.failed ? `${s.failed} failed` : '', s.missing.length ? `${s.missing.length} missing (${s.missing.join(', ')})` : ''].filter(Boolean);
  return `Java ${s.version} (${s.target}, ${s.packageManager}) — ${s.expected} tools expected: ${bits.join(' · ')}${s.naByDesign.length ? ` · N/A by design: ${s.naByDesign.join(', ')}` : ''}${s.optionalMissing.length ? ` · optional (⚠️) not run: ${s.optionalMissing.join(', ')}` : ''}${s.optionalFailed.length ? ` · optional (⚠️) failed/empty, not filed: ${s.optionalFailed.join(', ')}` : ''}${s.notApplicable.length ? ` · reported not_applicable: ${s.notApplicable.join(', ')}` : ''}${s.outsideMatrix.length ? ` · ran outside the matrix: ${s.outsideMatrix.join(', ')}` : ''}${s.contamination.length ? ` · LANGUAGE CONTAMINATION: ${s.contamination.join(', ')}` : ''}${s.assumption ? ` · note: ${s.assumption}` : ''}`;
}
