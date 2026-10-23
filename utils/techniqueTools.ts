/**
 * Technique → primary tool → name(s) of the tool's folder inside the run folder in S3, per language.
 * JS / TS: the dictionaries from the platform. C# / Python: tool names as folder names — folders seen in S3 are
 * marked as confirmed, the others are best guesses (a FAIL on a guessed name says so).
 * Several candidate folder names are tried in order (e.g. TypeScript often shares the JavaScript folder).
 */
export type Language = 'javascript' | 'typescript' | 'csharp' | 'python';

/** Classifications of a technique that have their own tool(s). primary: [] = primary tool is N/A (only the secondary is checked);
 *  one name = that tool; several names = a combined tool (every folder is checked and the data is shown together). */
export interface TechniqueRow { classes: string[]; primary: string[]; secondary?: string[] }
export interface TechniqueTool { testingType: string; technique: string; tools: string[]; guess?: boolean; rows?: TechniqueRow[]; rowsOnly?: boolean; tryFirst?: string }

const m = (testingType: string, technique: string, ...tools: string[]): TechniqueTool => ({ testingType, technique, tools });
const g = (testingType: string, technique: string, ...tools: string[]): TechniqueTool => ({ testingType, technique, tools, guess: true });

const JS: TechniqueTool[] = [
  m('Structural Analysis', 'Cyclomatic Complexity', 'lizard', 'debtmap'),
  m('Readability / Maintainability', 'Cognitive Complexity', 'eslint-sonarjs', 'cccc'),
  m('Code Quality Auditing', 'Code Duplication', 'jscpd-js', 'dolos'),
  { ...m('Static Code Analysis', 'Lint / Rule Violations', 'eslint', 'oxlint'), rows: [{ classes: ['Custom Rule Validation'], primary: [], secondary: ['oxlint'] }] },
  m('Security White-box Testing', 'Static Vulnerabilities (SAST)', 'eslint-security', 'opengrep'),
  { ...m('Security White-box Testing', 'Dependency Risk (SCA)', 'npm-audit', 'trivy'), rowsOnly: true, rows: [
    { classes: ['Transitive Dependency Analysis'], primary: ['npm-ls'], secondary: ['trivy'] },
    { classes: ['License Compliance Testing'], primary: [], secondary: ['trivy'] },
    { classes: ['Supply Chain Security Analysis', 'Dependency Health Monitoring', 'Risk Prioritization', 'Continuous Dependency Monitoring', 'Vulnerability Dependency Detection'], primary: ['npm-audit', 'npm-ls'], secondary: ['trivy'] }, // npm audit + npm ls: both folders, shown together
    { classes: ['Outdated Dependency Detection'], primary: [], secondary: ['trivy'] },
  ] },
  m('Control Flow Testing', 'Statement Coverage', 'nyc-mocha', 'monocart-coverage-reports'),
  m('Control Flow Testing', 'Branch Coverage', 'nyc-mocha', 'monocart-coverage-reports'),
  { ...m('Control Flow Testing', 'Path Coverage', 'js-path-coverage', 'monocart-coverage-reports'), rowsOnly: true, rows: [
    { classes: ['Path Execution Tracking', 'Complete Coverage Path Verification', 'Partial Path Coverage Detection', 'Nested Condition Path Testing'], primary: ['js-path-coverage'], secondary: ['monocart-coverage-reports'] }, // nyc
    { classes: ['Loop Path Detection', 'Unreachable Path Detection', 'Exception Path Handling'], primary: [], secondary: ['monocart-coverage-reports'] },
    { classes: ['Multi-Function Path Tracking', 'CI/CD Integration Test', 'Path Detection Testing'], primary: ['js-all-defs-uses'], secondary: ['monocart-coverage-reports'] }, // ESLint (eslint-scope) + nyc
  ] },
  m('Mutation Testing', 'Mutation Score', 'stryker-js', 'gutcheck'),
  m('Test Regression/Coverage Analysis', 'Coverage Delta', 'coverage_delta', 'monocart-coverage-reports'),
  { ...m('Data Flow Testing', 'All Definition Coverage', 'js-all-defs-uses'), rowsOnly: true, rows: [
    { classes: ['Variable Definition Detection'], primary: ['js-all-defs-uses'], secondary: ['gutcheck'] },
    { classes: ['Definition-Use Mapping'], primary: ['js-all-defs-uses'], secondary: ['codeql'] },
    { classes: ['Coverage Measurement'], primary: ['js-all-defs-uses'], secondary: ['gutcheck'] },
    { classes: ['Uncovered Definition Detection'], primary: ['js-all-defs-uses'], secondary: ['knip'] },
    { classes: ['Edge Case Handling'], primary: ['js-all-defs-uses'], secondary: ['opengrep'] },
    { classes: ['Reporting Validation'], primary: ['js-all-defs-uses'], secondary: ['knip'] },
  ] },
  { ...m('Data Flow Testing', 'All Uses Coverage', 'js-all-defs-uses'), rowsOnly: true, rows: [
    { classes: ['Computational Use Detection (C-Use)', 'Predicate Use Detection (P-Use)'], primary: ['js-all-defs-uses'], secondary: ['opengrep'] },
    { classes: ['Definition-Use Pair Identification', 'All-Uses Coverage Verification', 'Partial Uses Coverage Detection', 'Multiple Definitions Handling', 'Cross-Function Use Detection', 'Unreachable Use Detection', 'Coverage Reporting Validation', 'Variable Use Detection'], primary: ['js-all-defs-uses'], secondary: ['knip'] },
  ] },
  m('Development Process Analysis', 'Code Churn', 'pydriller', 'git-spark'),
  m('Code Quality', 'Technical Debt', 'pydriller'),
  m('Code Quality', 'Test Coverage', 'nyc-mocha'),
  m('Compliance Testing', 'Secret Detection', 'gitleaks'),
];

const TS: TechniqueTool[] = [
  { ...m('Structural Analysis', 'Cyclomatic Complexity', 'lizard', 'cccc'), rows: [{ classes: ['Condition Coverage', 'Logic Coverage Metric'], primary: ['lizard'], secondary: ['debtmap'] }] },
  m('Readability / Maintainability', 'Cognitive Complexity', 'ts-eslint-sonarjs', 'cccc'),
  m('Code Quality Auditing', 'Code Duplication', 'jscpd-ts', 'reson'),
  m('Static Code Analysis', 'Lint / Rule Violations', 'biome', 'oxlint'),
  m('Security White-box Testing', 'Static Vulnerabilities (SAST)', 'ts-eslint-security', 'bearer-cli'),
  { ...m('Security White-box Testing', 'Dependency Risk (SCA)', 'cdxgen', 'cve-lite-cli'), rowsOnly: true, rows: [
    { classes: ['Transitive Dependency Analysis'], primary: ['cdxgen'], secondary: ['cve-lite-cli'] },
    { classes: ['License Compliance Testing'], primary: ['cdxgen'], secondary: ['license-checker'] }, // ORT (cdxgen license proxy)
    { classes: ['Supply Chain Security Analysis'], primary: ['osv-scanner-ts'], secondary: ['sigstore-cli'] },
    { classes: ['Dependency Health Monitoring'], primary: ['github-vitality', 'npm-view'], secondary: ['nodesecure-cli'] }, // GitHub API + npm downloads API
    { classes: ['Risk Prioritization'], primary: ['grype'], secondary: ['cve-lite-cli'] },
    { classes: ['Continuous Dependency Monitoring'], primary: ['dependabot'], secondary: ['cve-lite-cli'] },
    { classes: ['Vulnerability Dependency Detection'], primary: ['osv-scanner-ts'], secondary: ['cve-lite-cli'] },
    { classes: ['Outdated Dependency Detection'], primary: ['ncu'], secondary: ['cve-lite-cli'] },
  ] },
  m('Control Flow Testing', 'Statement Coverage', 'vitest-coverage', 'monocart-coverage-reports'),
  m('Control Flow Testing', 'Branch Coverage', 'vitest-coverage', 'oxc-coverage-instrument'),
  { ...m('Control Flow Testing', 'Path Coverage', 'vitest-coverage', 'monocart-coverage-reports'), tryFirst: 'ts-path-coverage', rowsOnly: true, rows: [
    { classes: ['Path Execution Tracking', 'Unreachable Path Detection'], primary: ['vitest-coverage'], secondary: ['monocart-coverage-reports'] },
    { classes: ['Complete Coverage Path Verification'], primary: ['opentelemetry'], secondary: ['mewt'] }, // @opentelemetry/sdk-node
    { classes: ['Partial Path Coverage Detection', 'Loop Path Detection'], primary: ['fast-check'], secondary: ['mewt'] },
    { classes: ['Nested Condition Path Testing'], primary: ['vitest-coverage'], secondary: ['mewt'] },
    { classes: ['Exception Path Handling'], primary: ['knip'], secondary: ['mewt'] },
    { classes: ['Multi-Function Path Tracking'], primary: ['ts-eslint-security'], secondary: ['tracegraph'] },
    { classes: ['CI/CD Integration Test'], primary: ['dependency-cruiser-ts'], secondary: ['mewt'] },
    { classes: ['Path Detection Testing'], primary: ['eslint', 'ts-eslint-sonarjs'], secondary: ['monocart-coverage-reports'] }, // eslint + eslint-plugin-sonarjs
  ] },
  m('Mutation Testing', 'Mutation Score', 'stryker-ts', 'mewt'),
  m('Test Regression/Coverage Analysis', 'Coverage Delta', 'ts-coverage-delta', 'diff-cover'),
  { ...m('Data Flow Testing', 'All Definition Coverage', 'ts-all-defs-uses'), rowsOnly: true, rows: [
    { classes: ['Variable Definition Detection', 'Definition-Use Mapping'], primary: ['ts-all-defs-uses'], secondary: ['ts-unused-exports'] },
    { classes: ['Coverage Measurement'], primary: ['ts-all-defs-uses'], secondary: ['red-dragon', 'oxc-coverage-instrument'] },
    { classes: ['Uncovered Definition Detection'], primary: ['ts-all-defs-uses'], secondary: ['ts-unused-exports'] },
    { classes: ['Edge Case Handling'], primary: ['ts-all-defs-uses'], secondary: ['opengrep'] },
    { classes: ['Reporting Validation'], primary: ['ts-all-defs-uses'], secondary: ['ts-unused-exports'] },
  ] },
  { ...m('Data Flow Testing', 'All Uses Coverage', 'ts-all-defs-uses'), rowsOnly: true, rows: [
    { classes: ['Computational Use Detection (C-Use)', 'Predicate Use Detection (P-Use)', 'Definition-Use Pair Identification'], primary: ['ts-all-defs-uses'], secondary: ['red-dragon'] },
    { classes: ['All-Uses Coverage Verification', 'Partial Uses Coverage Detection'], primary: ['ts-all-defs-uses'], secondary: ['ts-unused-exports'] },
    { classes: ['Multiple Definitions Handling', 'Cross-Function Use Detection'], primary: ['ts-all-defs-uses'], secondary: ['red-dragon'] },
    { classes: ['Unreachable Use Detection', 'Coverage Reporting Validation', 'Variable Use Detection'], primary: ['ts-all-defs-uses'], secondary: ['ts-unused-exports'] },
  ] },
  { ...m('Development Process Analysis', 'Code Churn', 'pydriller', 'git-hot'), rows: [{ classes: ['Test Case Maintenance Identification', 'Change Impact Analysis'], primary: ['pydriller'], secondary: ['covgate'] }] },
  m('Code Quality', 'Technical Debt', 'pydriller'),
  m('Code Quality', 'Test Coverage', 'vitest-coverage'),
  m('Compliance Testing', 'Secret Detection', 'gitleaks'),
];

const CS: TechniqueTool[] = [
  m('Structural Analysis', 'Cyclomatic Complexity', 'lizard', 'csharp-cyclomatic'),
  m('Readability / Maintainability', 'Cognitive Complexity', 'sonar-cs', 'simple-cognitive'),
  m('Code Quality Auditing', 'Code Duplication', 'jscpd-cs', 'pmd-cpd'),
  m('Static Code Analysis', 'Lint / Rule Violations', 'roslyn-analyzers', 'roslyn'),
  m('Security White-box Testing', 'Static Vulnerabilities (SAST)', 'semgrep', 'roslyn-sast'),
  m('Security White-box Testing', 'Dependency Risk (SCA)', 'dotnet-sca', 'cvebin'),
  m('Control Flow Testing', 'Statement Coverage', 'coverlet'),
  m('Control Flow Testing', 'Branch Coverage', 'coverlet'),
  m('Control Flow Testing', 'Path Coverage', 'altcover', 'csharp-call-paths'),
  m('Mutation Testing', 'Mutation Score', 'stryker-net'),
  m('Test Regression/Coverage Analysis', 'Coverage Delta', 'cs_coverage_delta', 'coverlet-delta'),
  m('Data Flow Testing', 'All Definition Coverage', 'cs_all_defs_uses', 'csharp-def-use'),
  m('Data Flow Testing', 'All Uses Coverage', 'cs_all_defs_uses', 'csharp-use-coverage'),
  m('Development Process Analysis', 'Code Churn', 'pydriller', 'git-churn', 'git-churn'),
];

const PY: TechniqueTool[] = [
  { ...m('Structural Analysis', 'Cyclomatic Complexity', 'lizard', 'mccabe'), rowsOnly: true, rows: [
    { classes: ['Static Analysis Metric', 'Logic Coverage Metric'], primary: ['crosshair'], secondary: ['mccabe'] },
    { classes: ['Decision Coverage'], primary: ['coverage-py'], secondary: ['mccabe'] },
    { classes: ['Condition Coverage'], primary: ['pymcdc'], secondary: ['mccabe'] },
    { classes: ['Maintainability Analysis'], primary: ['radon', 'lizard'], secondary: ['mccabe'] },
    { classes: ['Test Prioritization'], primary: ['testmon'], secondary: ['mccabe'] } ] },
  m('Readability / Maintainability', 'Cognitive Complexity', 'cognitive-ast', 'radon_cc'),
  m('Code Quality Auditing', 'Code Duplication', 'jscpd-py', 'copydetect'),
  m('Static Code Analysis', 'Lint / Rule Violations', 'pylint', 'flake8'),
  { ...m('Security White-box Testing', 'Static Vulnerabilities (SAST)', 'semgrep', 'bandit'), rowsOnly: true, rows: [
    { classes: ['Secure Coding Validation', 'Dependency & Library Vulnerability Detection'], primary: ['semgrep', 'bandit'], secondary: ['semgrep'] },
    { classes: ['Input Validation Testing', 'Data Flow Security Analysis', 'Authentication & Authorization Weakness Detection', 'Compliance & Security Standard Validation', 'Security Vulnerability Detection'], primary: ['semgrep', 'bandit'], secondary: ['bandit'] } ] },
  m('Security White-box Testing', 'Dependency Risk (SCA)', 'pip-audit', 'safety'),
  m('Control Flow Testing', 'Statement Coverage', 'coverage-py', 'pytest-cov'),
  m('Control Flow Testing', 'Branch Coverage', 'coverage-py', 'pytest-cov --cov-branch'),
  { ...m('Control Flow Testing', 'Path Coverage', 'coverage-py', 'coverage_paths'), rowsOnly: true, rows: [
    { classes: ['Path Execution Tracking', 'Complete Coverage Path Verification', 'Partial Path Coverage Detection', 'Path Detection Testing'], primary: ['coverage-py'], secondary: ['coverage.py + ast paths'] },
    { classes: ['Nested Condition Path Testing', 'Loop Path Detection', 'Unreachable Path Detection', 'Exception Path Handling', 'Multi-Function Path Tracking', 'CI/CD Integration Test'], primary: ['coverage-py'], secondary: ['coverage_paths'] } ] },
  m('Mutation Testing', 'Mutation Score', 'cosmic-ray', 'mutmut'),
  m('Test Regression/Coverage Analysis', 'Coverage Delta', 'py-coverage-delta', 'coveragepy'),
  { ...m('Data Flow Testing', 'All Definition Coverage', 'py-all-defs-uses', 'pyflakes'), rowsOnly: true, rows: [
    { classes: ['Variable Definition Detection', 'Coverage Measurement'], primary: ['py-all-defs-uses'], secondary: ['pyflakes'] },
    { classes: ['Definition-Use Mapping'], primary: ['coverage-py'], secondary: ['pyflakes'] },
    { classes: ['Uncovered Definition Detection'], primary: ['pylint'], secondary: ['pyflakes'] },
    { classes: ['Edge Case Handling'], primary: ['crosshair'], secondary: ['pyflakes'] },
    { classes: ['Reporting Validation'], primary: ['pydriller'], secondary: ['pyflakes'] } ] },
  m('Data Flow Testing', 'All Uses Coverage', 'py-all-defs-uses', 'all_uses'),
  m('Development Process Analysis', 'Code Churn', 'pydriller', 'git_churn'),
];

const MAPS: Record<Language, TechniqueTool[]> = { javascript: JS, typescript: TS, csharp: CS, python: PY };

export const toolsFor = (language: Language): TechniqueTool[] => MAPS[language];

/** "C#, JavaScript, TypeScript" (Repository details → Language) → supported languages; the rest is returned as ignored. */
export function parseLanguages(names: string[]): { languages: Language[]; ignored: string[] } {
  const languages = new Set<Language>(); const ignored: string[] = [];
  for (const raw of names) {
    const n = raw.trim().toLowerCase();
    if (/^c#$|c-?sharp|\.net/.test(n)) languages.add('csharp');
    else if (/^(java ?script|js)$/.test(n)) languages.add('javascript');
    else if (/^(type ?script|ts)$/.test(n)) languages.add('typescript');
    else if (/^(python|py)$/.test(n)) languages.add('python');
    else if (n) ignored.push(raw.trim());
  }
  return { languages: [...languages], ignored };
}
