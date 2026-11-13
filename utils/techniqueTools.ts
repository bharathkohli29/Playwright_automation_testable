/**
 * Technique → primary tool → name(s) of the tool's folder inside the run folder in S3, per language.
 * JS / TS: the dictionaries from the platform. C# / Python: tool names as folder names — folders seen in S3 are
 * marked as confirmed, the others are best guesses (a FAIL on a guessed name says so).
 * Several candidate folder names are tried in order (e.g. TypeScript often shares the JavaScript folder).
 */
export type Language = 'javascript' | 'typescript' | 'csharp' | 'python' | 'java';

/** Classifications of a technique that have their own tool(s). primary: [] = primary tool is N/A (only the secondary is checked);
 *  one name = that tool; several names = a combined tool (every folder is checked and the data is shown together). */
export interface TechniqueRow { classes: string[]; primary: string[]; secondary?: string[] }
export interface TechniqueTool { testingType: string; technique: string; tools: string[]; guess?: boolean; rows?: TechniqueRow[]; rowsOnly?: boolean; tryFirst?: string }

const m = (testingType: string, technique: string, ...tools: string[]): TechniqueTool => ({ testingType, technique, tools });
const g = (testingType: string, technique: string, ...tools: string[]): TechniqueTool => ({ testingType, technique, tools, guess: true });

const JS: TechniqueTool[] = [
  // JavaScript mapping from JavaScript_Primary_Secondary_Tools_by_Technique.md, platform qa ae5ad4fd3 (13 Nov 2026): primary / secondary per classification as the platform code reads them. Several primaries = combined (all must run); primary [] = only the listed co-providers are checked.
  { ...m('Structural Analysis', 'Cyclomatic Complexity', 'lizard', 'nyc-mocha'), rowsOnly: true, rows: [
    { classes: ['Static Analysis Metric', 'Maintainability Analysis', 'Test Prioritization'], primary: ['lizard'], secondary: [] },
    { classes: ['Decision Coverage', 'Logic Coverage Metric'], primary: ['nyc-mocha'], secondary: [] },
  ] },
  { ...m('Readability / Maintainability', 'Cognitive Complexity', 'eslint-sonarjs', 'lizard'), rowsOnly: true, rows: [
    { classes: ['Maintainability Evaluation', 'Refactoring Guidance', 'Code Review Support', 'Code Understandability Analysis'], primary: ['eslint-sonarjs'], secondary: [] },
    { classes: ['Testability Analysis', 'Risk Detection'], primary: ['lizard'], secondary: [] },
  ] },
  { ...m('Code Quality Auditing', 'Code Duplication', 'jscpd-js'), rowsOnly: true, rows: [
    { classes: ['Defect Propagation Risk Detection', 'Refactoring Identification', 'Code Quality Assessment', 'Test Maintenance Reduction', 'Refactoring Opportunity Detection', 'Risk-Based Testing Prioritization', 'Maintainability Testing'], primary: ['jscpd-js'], secondary: [] },
  ] },
  { ...m('Static Code Analysis', 'Lint / Rule Violations', 'eslint', 'lizard'), rowsOnly: true, rows: [
    { classes: ['Rule Detection Test', 'Unused Variable Detection', 'Naming Convention Validation', 'Code Style Rule Validation', 'Rule Severity Classification', 'Multiple Violations Detection', 'False Positive Prevention', 'Custom Rule Validation', 'Configuration File Handling', 'CI/CD Integration Validation', 'Violation Reporting Validation'], primary: ['eslint'], secondary: [] },
    { classes: ['Complexity Rule Detection'], primary: ['lizard'], secondary: [] },
  ] },
  { ...m('Security White-box Testing', 'Static Vulnerabilities (SAST)', 'semgrep', 'eslint-security', 'npm-audit'), rowsOnly: true, rows: [
    { classes: ['Secure Coding Validation', 'Authentication & Authorization Weakness Detection', 'Security Vulnerability Detection'], primary: ['semgrep'], secondary: [] },
    { classes: ['Input Validation Testing', 'Data Flow Security Analysis', 'Compliance & Security Standard Validation'], primary: [], secondary: ['eslint-security', 'semgrep'] },
    { classes: ['Dependency & Library Vulnerability Detection'], primary: ['npm-audit'], secondary: [] },
  ] },
  { ...m('Security White-box Testing', 'Dependency Risk (SCA)', 'npm-ls', 'npm-audit', 'license-checker', 'osv-scanner', 'npm-view', 'npm-outdated'), rowsOnly: true, rows: [
    { classes: ['Transitive Dependency Analysis'], primary: ['npm-ls'], secondary: ['npm-audit'] },
    { classes: ['License Compliance Testing'], primary: ['license-checker'], secondary: [] },
    { classes: ['Supply Chain Security Analysis'], primary: [], secondary: ['npm-audit', 'osv-scanner'] },
    { classes: ['Dependency Health Monitoring'], primary: ['npm-view'], secondary: [] },
    { classes: ['Risk Prioritization', 'Continuous Dependency Monitoring', 'Vulnerability Dependency Detection'], primary: ['npm-audit'], secondary: [] },
    { classes: ['Outdated Dependency Detection'], primary: ['npm-outdated'], secondary: [] },
  ] },
  { ...m('Control Flow Testing', 'Statement Coverage', 'nyc-mocha', 'js-test-assertions'), rowsOnly: true, rows: [
    { classes: ['Unit Testing Support', 'Dead Code Detection', 'Test Completeness Evaluation', 'Code Execution Verification'], primary: ['nyc-mocha'], secondary: [] },
    { classes: ['Basic Logic Validation'], primary: ['nyc-mocha'], secondary: ['js-test-assertions'] },
  ] },
  { ...m('Mutation Testing', 'Mutation Score', 'stryker-js'), rowsOnly: true, rows: [
    { classes: ['Fault Detection Capability', 'Test Coverage Quality Validation', 'Test Case Improvement Identification', 'Edge Case Detection', 'Regression Testing Validation', 'Code Logic Validation', 'Test Suite Effectiveness Evaluation'], primary: ['stryker-js'], secondary: [] },
  ] },
  { ...m('Data Flow Testing', 'All Definition Coverage', 'js-all-defs-uses'), rowsOnly: true, rows: [
    { classes: ['Variable Definition Detection', 'Definition-Use Mapping', 'Coverage Measurement', 'Uncovered Definition Detection', 'Edge Case Handling', 'Reporting Validation'], primary: ['js-all-defs-uses'], secondary: [] },
  ] },
  { ...m('Data Flow Testing', 'All Uses Coverage', 'js-all-defs-uses'), rowsOnly: true, rows: [
    { classes: ['Computational Use Detection (C-Use)', 'Predicate Use Detection (P-Use)', 'Definition-Use Pair Identification', 'All-Uses Coverage Verification', 'Partial Uses Coverage Detection', 'Multiple Definitions Handling', 'Cross-Function Use Detection', 'Unreachable Use Detection', 'Coverage Reporting Validation', 'Variable Use Detection'], primary: ['js-all-defs-uses'], secondary: [] },
  ] },
  { ...m('Development Process Analysis', 'Code Churn', 'git-churn'), rowsOnly: true, rows: [
    { classes: ['Risk-Based Testing Prioritization', 'Regression Testing Focus', 'Defect Prediction', 'Test Case Maintenance Identification', 'Change Impact Analysis'], primary: ['git-churn'], secondary: [] },
  ] },
  { ...m('Code Quality', 'Technical Debt', 'pydriller'), rowsOnly: true, rows: [
    { classes: ['Code Churn in Performance-Critical Paths'], primary: ['pydriller'], secondary: [] },
  ] },
  { ...m('Code Quality', 'Test Coverage', 'nyc-mocha'), rowsOnly: true, rows: [
    { classes: ['Performance Test Code Coverage'], primary: ['nyc-mocha'], secondary: [] },
  ] },
  { ...m('Static Code Analysis', 'Secret Detection', 'detect-secrets', 'gitleaks'), rowsOnly: true, rows: [
    { classes: ['Hardcoded Secret Scan', 'Pre-Commit Secret Prevention'], primary: [], secondary: ['detect-secrets', 'gitleaks'] },
  ] },
  { ...m('Security Testing', 'Secret Detection', 'detect-secrets', 'gitleaks'), rowsOnly: true, rows: [
    { classes: ['Hardcoded Secret Detection', 'Pre-Commit Secret Prevention', 'Secrets in Git History'], primary: [], secondary: ['detect-secrets', 'gitleaks'] },
  ] },
  { ...m('Control Flow Testing', 'Branch Coverage', 'js-boundary-decisions'), rowsOnly: true, rows: [
    { classes: ['Edge Case Detection'], primary: ['js-boundary-decisions'], secondary: [] },
  ] },
  { ...m('Control Flow Testing', 'Path Coverage', 'js-path-coverage', 'nyc-mocha'), rowsOnly: true, rows: [
    { classes: ['Complete Coverage Path Verification', 'Nested Condition Path Testing', 'Exception Path Handling', 'Multi-Function Path Tracking'], primary: ['js-path-coverage'], secondary: ['nyc-mocha'] },
    { classes: ['Unreachable Path Detection', 'CI/CD Integration Test'], primary: ['nyc-mocha'], secondary: [] },
  ] },
  { ...m('Performance Testing', 'Static Analysis', 'lizard', 'semgrep-perf-static'), rowsOnly: true, rows: [
    { classes: ['Complexity-Based Perf Risk'], primary: ['lizard'], secondary: [] },
    { classes: ['Big-O Complexity Review', 'N+1 Query Pattern Detection', 'Memory Allocation Analysis', 'Thread-Safety Detection'], primary: ['semgrep-perf-static'], secondary: [] },
  ] },
  { ...m('Performance Testing', 'Dependency Analysis', 'javascript-perf-dependency'), rowsOnly: true, rows: [
    { classes: ['Unused Dependency Detection', 'Circular Dependency Detection', 'Build Time Regression'], primary: ['javascript-perf-dependency'], secondary: [] },
  ] },
  { ...m('FERPA/COPPA Compliance', 'Student PII Exposure Scan', 'presidio'), rowsOnly: true, rows: [
    { classes: ['PII in Codebase Detection'], primary: ['presidio'], secondary: [] },
  ] },
  { ...m('FERPA/COPPA Compliance', 'PII Logging Detection', 'semgrep-pii'), rowsOnly: true, rows: [
    { classes: ['PII in Log Statements'], primary: ['semgrep-pii'], secondary: [] },
  ] },
];

const TS: TechniqueTool[] = [
  // TypeScript mapping from TypeScript_Primary_Secondary_Tools_by_Technique.md, platform qa ae5ad4fd3 (13 Nov 2026): primary / secondary per classification as the platform code reads them. Several primaries = combined (all must run); primary [] = only the listed co-providers are checked.
  { ...m('Structural Analysis', 'Cyclomatic Complexity', 'lizard', 'vitest-coverage', 'nyc-mocha', 'ts-condition-probe', 'ts-eslint-sonarjs'), rowsOnly: true, rows: [
    { classes: ['Static Analysis Metric'], primary: ['lizard'], secondary: [] },
    { classes: ['Decision Coverage'], primary: ['vitest-coverage'], secondary: ['nyc-mocha'] },
    { classes: ['Condition Coverage'], primary: ['ts-condition-probe'], secondary: ['vitest-coverage'] },
    { classes: ['Logic Coverage Metric'], primary: ['ts-condition-probe'], secondary: [] },
    { classes: ['Maintainability Analysis'], primary: ['ts-eslint-sonarjs'], secondary: [] },
    { classes: ['Test Prioritization'], primary: ['lizard'], secondary: ['ts-eslint-sonarjs'] },
  ] },
  { ...m('Readability / Maintainability', 'Cognitive Complexity', 'ts-eslint-sonarjs', 'lizard', 'git-churn'), rowsOnly: true, rows: [
    { classes: ['Maintainability Evaluation', 'Refactoring Guidance', 'Code Review Support', 'Code Understandability Analysis'], primary: ['ts-eslint-sonarjs'], secondary: [] },
    { classes: ['Testing Effort Prioritization'], primary: ['lizard'], secondary: ['ts-eslint-sonarjs'] },
    { classes: ['Testability Analysis'], primary: ['ts-eslint-sonarjs'], secondary: ['lizard'] },
    { classes: ['Risk Detection'], primary: ['git-churn'], secondary: ['ts-eslint-sonarjs'] },
  ] },
  { ...m('Code Quality Auditing', 'Code Duplication', 'jscpd-ts'), rowsOnly: true, rows: [
    { classes: ['Defect Propagation Risk Detection', 'Refactoring Identification', 'Code Quality Assessment', 'Test Maintenance Reduction', 'Refactoring Opportunity Detection', 'Risk-Based Testing Prioritization', 'Maintainability Testing'], primary: ['jscpd-ts'], secondary: [] },
  ] },
  { ...m('Static Code Analysis', 'Lint / Rule Violations', 'ts-eslint-sonarjs'), rowsOnly: true, rows: [
    { classes: ['Rule Detection Test', 'Unused Variable Detection', 'Naming Convention Validation', 'Code Style Rule Validation', 'Complexity Rule Detection', 'Rule Severity Classification', 'Multiple Violations Detection', 'False Positive Prevention', 'Custom Rule Validation', 'Configuration File Handling', 'CI/CD Integration Validation', 'Violation Reporting Validation'], primary: ['ts-eslint-sonarjs'], secondary: [] },
  ] },
  { ...m('Security White-box Testing', 'Static Vulnerabilities (SAST)', 'semgrep', 'ts-eslint-sonarjs', 'pnpm-audit'), rowsOnly: true, rows: [
    { classes: ['Secure Coding Validation', 'Data Flow Security Analysis'], primary: ['semgrep'], secondary: ['ts-eslint-sonarjs'] },
    { classes: ['Input Validation Testing', 'Authentication & Authorization Weakness Detection', 'Security Vulnerability Detection'], primary: ['semgrep'], secondary: [] },
    { classes: ['Dependency & Library Vulnerability Detection'], primary: ['pnpm-audit'], secondary: [] },
  ] },
  { ...m('Security White-box Testing', 'Dependency Risk (SCA)', 'pnpm-audit', 'osv-scanner-ts', 'license-checker-ts', 'osv-scanner'), rowsOnly: true, rows: [
    { classes: ['Transitive Dependency Analysis', 'Supply Chain Security Analysis'], primary: ['pnpm-audit'], secondary: ['osv-scanner-ts'] },
    { classes: ['License Compliance Testing'], primary: ['license-checker-ts'], secondary: [] },
    { classes: ['Dependency Health Monitoring', 'Outdated Dependency Detection'], primary: ['pnpm-audit'], secondary: [] },
    { classes: ['Vulnerability Dependency Detection'], primary: ['osv-scanner-ts'], secondary: ['osv-scanner'] },
  ] },
  { ...m('Control Flow Testing', 'Statement Coverage', 'vitest-coverage', 'nyc-mocha', 'ts-path-coverage'), rowsOnly: true, rows: [
    { classes: ['Unit Testing Support', 'Test Completeness Evaluation', 'Code Execution Verification'], primary: ['vitest-coverage'], secondary: ['nyc-mocha'] },
    { classes: ['Dead Code Detection'], primary: ['vitest-coverage'], secondary: ['nyc-mocha', 'ts-path-coverage'] },
    { classes: ['Basic Logic Validation'], primary: ['vitest-coverage'], secondary: [] },
  ] },
  { ...m('Control Flow Testing', 'Branch Coverage', 'vitest-coverage', 'nyc-mocha', 'ts-condition-probe'), rowsOnly: true, rows: [
    { classes: ['Conditional Logic Testing', 'Control Flow Validation', 'Test Case Completeness', 'Decision Outcome Verification'], primary: ['vitest-coverage'], secondary: ['nyc-mocha'] },
    { classes: ['Loop Condition Testing'], primary: ['ts-condition-probe'], secondary: ['vitest-coverage', 'nyc-mocha'] },
    { classes: ['Edge Case Detection'], primary: ['ts-condition-probe'], secondary: [] },
  ] },
  { ...m('Control Flow Testing', 'Path Coverage', 'ts-path-coverage', 'vitest-coverage'), rowsOnly: true, rows: [
    { classes: ['Path Execution Tracking', 'Complete Coverage Path Verification', 'Partial Path Coverage Detection', 'Nested Condition Path Testing', 'Loop Path Detection', 'Exception Path Handling', 'Multi-Function Path Tracking', 'CI/CD Integration Test', 'Path Detection Testing'], primary: ['ts-path-coverage'], secondary: [] },
    { classes: ['Unreachable Path Detection'], primary: ['ts-path-coverage'], secondary: ['vitest-coverage'] },
  ] },
  { ...m('Mutation Testing', 'Mutation Score', 'stryker-ts', 'vitest-coverage', 'nyc-mocha'), rowsOnly: true, rows: [
    { classes: ['Fault Detection Capability', 'Test Case Improvement Identification', 'Edge Case Detection', 'Regression Testing Validation', 'Code Logic Validation', 'Test Suite Effectiveness Evaluation'], primary: ['stryker-ts'], secondary: [] },
    { classes: ['Test Coverage Quality Validation'], primary: ['vitest-coverage'], secondary: ['nyc-mocha', 'stryker-ts'] },
  ] },
  { ...m('Test Regression/Coverage Analysis', 'Coverage Delta', 'ts-coverage-delta', 'stryker-ts'), rowsOnly: true, rows: [
    { classes: ['Regression Testing Monitoring', 'CI/CD Quality Gate Enforcement', 'New Code Testing Validation', 'Quality Improvement Measurement'], primary: ['ts-coverage-delta'], secondary: [] },
    { classes: ['Test Suite Effectiveness Tracking', 'Change Impact Analysis'], primary: ['stryker-ts'], secondary: [] },
  ] },
  { ...m('Development Process Analysis', 'Code Churn', 'ts-coverage-delta', 'git-churn'), rowsOnly: true, rows: [
    { classes: ['Risk-Based Testing Prioritization', 'Regression Testing Focus'], primary: ['ts-coverage-delta'], secondary: [] },
    { classes: ['Defect Prediction', 'Test Case Maintenance Identification', 'Change Impact Analysis'], primary: ['git-churn'], secondary: [] },
  ] },
  { ...m('Data Flow Testing', 'All Definition Coverage', 'ts-all-defs-uses'), rowsOnly: true, rows: [
    { classes: ['Variable Definition Detection', 'Definition-Use Mapping', 'Coverage Measurement', 'Uncovered Definition Detection', 'Edge Case Handling', 'Reporting Validation'], primary: ['ts-all-defs-uses'], secondary: [] },
  ] },
  { ...m('Data Flow Testing', 'All Uses Coverage', 'ts-all-defs-uses'), rowsOnly: true, rows: [
    { classes: ['Computational Use Detection (C-Use)', 'Predicate Use Detection (P-Use)', 'Definition-Use Pair Identification', 'All-Uses Coverage Verification', 'Partial Uses Coverage Detection', 'Multiple Definitions Handling', 'Cross-Function Use Detection', 'Unreachable Use Detection', 'Coverage Reporting Validation', 'Variable Use Detection'], primary: ['ts-all-defs-uses'], secondary: [] },
  ] },
  { ...m('Performance Testing', 'Static Analysis', 'lizard', 'semgrep-perf-static'), rowsOnly: true, rows: [
    { classes: ['Complexity-Based Perf Risk'], primary: ['lizard'], secondary: [] },
    { classes: ['Big-O Complexity Review', 'N+1 Query Pattern Detection', 'Memory Allocation Analysis', 'Thread-Safety Detection'], primary: ['semgrep-perf-static'], secondary: [] },
  ] },
  { ...m('Performance Testing', 'Dependency Analysis', 'typescript-perf-dependency'), rowsOnly: true, rows: [
    { classes: ['Unused Dependency Detection', 'Circular Dependency Detection', 'Build Time Regression'], primary: ['typescript-perf-dependency'], secondary: [] },
  ] },
  { ...m('FERPA/COPPA Compliance', 'Student PII Exposure Scan', 'presidio'), rowsOnly: true, rows: [
    { classes: ['PII in Codebase Detection'], primary: ['presidio'], secondary: [] },
  ] },
  { ...m('FERPA/COPPA Compliance', 'PII Logging Detection', 'semgrep-pii'), rowsOnly: true, rows: [
    { classes: ['PII in Log Statements'], primary: ['semgrep-pii'], secondary: [] },
  ] },
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
  // Python mapping from the platform's own tool bindings (technique_tool / wb0026, 12 Nov 2026). Roles come from the platform catalog: the PRIMARY-role tools of a row are its
  // primary (several = combined, every one must trigger), its SECONDARY-role tools are the secondary. Retired / replaced tools (testmon, mccabe, cognitive-ast, copydetect,
  // mutmut, pyflakes, pytest-cov, coveragepy, coverage_paths, all_uses) are no longer mapped.
  { ...m('Structural Analysis', 'Cyclomatic Complexity', 'radon', 'lizard'), rowsOnly: true, rows: [
    { classes: ['Static Analysis Metric', 'Maintainability Analysis', 'Test Prioritization'], primary: ['radon'], secondary: ['lizard'] },
    { classes: ['Decision Coverage'], primary: ['coverage-py'], secondary: [] },
    { classes: ['Condition Coverage'], primary: ['pymcdc'], secondary: [] } ] },
  { ...m('Readability / Maintainability', 'Cognitive Complexity', 'complexipy'), rowsOnly: true, rows: [
    { classes: ['Refactoring Guidance', 'Maintainability Evaluation', 'Code Review Support', 'Code Understandability Analysis'], primary: ['complexipy'], secondary: [] },
    { classes: ['Testability Analysis', 'Risk Detection'], primary: ['radon'], secondary: ['lizard'] } ] },
  m('Code Quality Auditing', 'Code Duplication', 'jscpd-py'),
  { ...m('Static Code Analysis', 'Lint / Rule Violations', 'pylint', 'flake8'), rows: [
    { classes: ['Unused Variable Detection'], primary: ['pylint'], secondary: ['vulture'] },
    { classes: ['Complexity Rule Detection'], primary: ['radon'], secondary: ['lizard'] } ] },
  { ...m('Security White-box Testing', 'Static Vulnerabilities (SAST)', 'semgrep', 'bandit'), rowsOnly: true, rows: [
    { classes: ['Secure Coding Validation', 'Input Validation Testing', 'Data Flow Security Analysis', 'Authentication & Authorization Weakness Detection', 'Compliance & Security Standard Validation', 'Security Vulnerability Detection'], primary: ['semgrep', 'bandit'], secondary: [] } ] }, // bandit + semgrep are both PRIMARY on the platform
  { ...m('Security White-box Testing', 'Dependency Risk (SCA)', 'pip-audit', 'safety'), rows: [
    { classes: ['Outdated Dependency Detection'], primary: ['pip-outdated'], secondary: ['pip-audit'] } ] },
  m('Control Flow Testing', 'Statement Coverage', 'coverage-py'),
  { ...m('Control Flow Testing', 'Branch Coverage', 'coverage-py'), rows: [
    { classes: ['Conditional Logic Testing'], primary: ['coverage-py', 'pymcdc'], secondary: [] } ] },
  { ...m('Control Flow Testing', 'Path Coverage', 'crosshair'), rows: [
    { classes: ['Path Execution Tracking'], primary: ['crosshair', 'coverage-py'], secondary: [] } ] },
  m('Mutation Testing', 'Mutation Score', 'cosmic-ray'),
  m('Test Regression/Coverage Analysis', 'Coverage Delta', 'py-coverage-delta'),
  m('Data Flow Testing', 'All Definition Coverage', 'py-all-defs-uses'),
  m('Data Flow Testing', 'All Uses Coverage', 'py-all-defs-uses'),
  { ...m('Development Process Analysis', 'Code Churn', 'git-churn', 'pydriller'), rows: [
    { classes: ['Change Impact Analysis'], primary: [], secondary: ['pydriller'] } ] },
  // groups whose tools are SECONDARY-role on the platform; mapped here as the primary (user's choice, 13 Nov 2026)
  { ...m('Security Testing', 'Secret Detection', 'gitleaks', 'detect-secrets'), rowsOnly: true, rows: [
    { classes: ['Secrets in Git History'], primary: ['gitleaks'], secondary: [] },
    { classes: ['Hardcoded Secret Scan'], primary: ['detect-secrets', 'gitleaks'], secondary: [] },
    { classes: ['Pre-Commit Secret Prevention'], primary: ['detect-secrets'], secondary: [] } ] },
  { ...m('Performance Testing', 'Static Analysis', 'semgrep-perf-static'), rowsOnly: true, rows: [
    { classes: ['Complexity-Based Perf Risk', 'Big-O Complexity Review', 'N+1 Query Pattern Detection', 'Memory Allocation Analysis', 'Thread-Safety Detection'], primary: ['semgrep-perf-static'], secondary: [] } ] },
  { ...m('Performance Testing', 'Dependency Analysis', 'python-perf-dependency'), rowsOnly: true, rows: [
    { classes: ['Unused Dependency Detection', 'Circular Dependency Detection', 'Build Time Regression'], primary: ['python-perf-dependency'], secondary: [] } ] },
  { ...m('FERPA/COPPA Compliance', 'Student PII Exposure Scan', 'presidio'), rowsOnly: true, rows: [
    { classes: ['PII in Codebase Detection'], primary: ['presidio'], secondary: [] } ] },
  { ...m('FERPA/COPPA Compliance', 'PII Logging Detection', 'semgrep-pii'), rowsOnly: true, rows: [
    { classes: ['PII in Log Statements'], primary: ['semgrep-pii'], secondary: [] } ] },
];

const JV: TechniqueTool[] = [
  // Java mapping derived from the platform's own selection code (qa ae5ad4fd3: gate_scoring._primary_tools_for_row over the 132 taxonomy leaves, Java registry tools) on 13 Nov 2026.
  // Ordered list = first tool is primary; co-providers (the registry's 'declares the metric' list, no order) = primary [] and any one of them is enough.
  { ...m('Structural Analysis', 'Cyclomatic Complexity', 'lizard', 'ck', 'jacoco'), rowsOnly: true, rows: [
    { classes: ['Static Analysis Metric', 'Test Prioritization'], primary: ['lizard'], secondary: ['ck'] },
    { classes: ['Decision Coverage'], primary: ['jacoco'], secondary: [] },
    { classes: ['Maintainability Analysis'], primary: ['lizard'], secondary: [] },
  ] },
  { ...m('Readability / Maintainability', 'Cognitive Complexity', 'pmd', 'lizard', 'ck'), rowsOnly: true, rows: [
    { classes: ['Maintainability Evaluation', 'Refactoring Guidance', 'Code Review Support', 'Code Understandability Analysis'], primary: ['pmd'], secondary: [] },
    { classes: ['Testability Analysis', 'Risk Detection'], primary: ['lizard'], secondary: ['ck'] },
  ] },
  { ...m('Code Quality Auditing', 'Code Duplication', 'cpd'), rowsOnly: true, rows: [
    { classes: ['Defect Propagation Risk Detection', 'Refactoring Identification', 'Code Quality Assessment', 'Test Maintenance Reduction', 'Refactoring Opportunity Detection', 'Risk-Based Testing Prioritization', 'Maintainability Testing'], primary: ['cpd'], secondary: [] },
  ] },
  { ...m('Static Code Analysis', 'Lint / Rule Violations', 'checkstyle', 'pmd', 'lizard', 'ck'), rowsOnly: true, rows: [
    { classes: ['Rule Detection Test', 'Unused Variable Detection', 'Naming Convention Validation', 'Code Style Rule Validation', 'Rule Severity Classification', 'Multiple Violations Detection', 'False Positive Prevention', 'Custom Rule Validation', 'Configuration File Handling', 'CI/CD Integration Validation', 'Violation Reporting Validation'], primary: [], secondary: ['checkstyle', 'pmd'] },
    { classes: ['Complexity Rule Detection'], primary: ['lizard'], secondary: ['ck'] },
  ] },
  { ...m('Security White-box Testing', 'Static Vulnerabilities (SAST)', 'semgrep', 'spotbugs', 'owasp-depcheck'), rowsOnly: true, rows: [
    { classes: ['Secure Coding Validation', 'Authentication & Authorization Weakness Detection', 'Security Vulnerability Detection'], primary: ['semgrep'], secondary: ['spotbugs'] },
    { classes: ['Input Validation Testing', 'Data Flow Security Analysis', 'Compliance & Security Standard Validation'], primary: [], secondary: ['semgrep', 'spotbugs'] },
    { classes: ['Dependency & Library Vulnerability Detection'], primary: ['owasp-depcheck'], secondary: [] },
  ] },
  { ...m('Security White-box Testing', 'Dependency Risk (SCA)', 'license-maven-plugin', 'grype', 'owasp-depcheck', 'deps-dev', 'maven-versions'), rowsOnly: true, rows: [
    { classes: ['License Compliance Testing'], primary: ['license-maven-plugin'], secondary: [] },
    { classes: ['Supply Chain Security Analysis'], primary: [], secondary: ['grype', 'owasp-depcheck'] },
    { classes: ['Dependency Health Monitoring'], primary: ['deps-dev'], secondary: [] },
    { classes: ['Risk Prioritization'], primary: ['grype'], secondary: [] },
    { classes: ['Continuous Dependency Monitoring'], primary: ['owasp-depcheck'], secondary: [] },
    { classes: ['Vulnerability Dependency Detection'], primary: ['owasp-depcheck'], secondary: ['grype'] },
    { classes: ['Outdated Dependency Detection'], primary: ['maven-versions'], secondary: ['deps-dev'] },
  ] },
  { ...m('Control Flow Testing', 'Statement Coverage', 'jacoco'), rowsOnly: true, rows: [
    { classes: ['Unit Testing Support', 'Dead Code Detection', 'Test Completeness Evaluation', 'Basic Logic Validation', 'Code Execution Verification'], primary: ['jacoco'], secondary: [] },
  ] },
  { ...m('Control Flow Testing', 'Branch Coverage', 'jacoco'), rowsOnly: true, rows: [
    { classes: ['Conditional Logic Testing', 'Control Flow Validation', 'Loop Condition Testing', 'Edge Case Detection', 'Logic Error Detection', 'Test Case Completeness', 'Decision Outcome Verification'], primary: ['jacoco'], secondary: [] },
  ] },
  { ...m('Mutation Testing', 'Mutation Score', 'pitest'), rowsOnly: true, rows: [
    { classes: ['Fault Detection Capability', 'Test Coverage Quality Validation', 'Test Case Improvement Identification', 'Edge Case Detection', 'Regression Testing Validation', 'Code Logic Validation', 'Test Suite Effectiveness Evaluation'], primary: ['pitest'], secondary: [] },
  ] },
  { ...m('Data Flow Testing', 'All Definition Coverage', 'java-all-defs-uses'), rowsOnly: true, rows: [
    { classes: ['Variable Definition Detection', 'Definition-Use Mapping', 'Coverage Measurement', 'Uncovered Definition Detection', 'Edge Case Handling', 'Reporting Validation'], primary: ['java-all-defs-uses'], secondary: [] },
  ] },
  { ...m('Data Flow Testing', 'All Uses Coverage', 'java-all-defs-uses'), rowsOnly: true, rows: [
    { classes: ['Computational Use Detection (C-Use)', 'Predicate Use Detection (P-Use)', 'Definition-Use Pair Identification', 'All-Uses Coverage Verification', 'Partial Uses Coverage Detection', 'Multiple Definitions Handling', 'Cross-Function Use Detection', 'Unreachable Use Detection', 'Coverage Reporting Validation', 'Variable Use Detection'], primary: ['java-all-defs-uses'], secondary: [] },
  ] },
  { ...m('Development Process Analysis', 'Code Churn', 'git-churn'), rowsOnly: true, rows: [
    { classes: ['Risk-Based Testing Prioritization', 'Regression Testing Focus', 'Defect Prediction', 'Test Case Maintenance Identification', 'Change Impact Analysis'], primary: ['git-churn'], secondary: [] },
  ] },
  { ...m('Code Quality', 'Technical Debt', 'pydriller'), rowsOnly: true, rows: [
    { classes: ['Code Churn in Performance-Critical Paths'], primary: ['pydriller'], secondary: [] },
  ] },
  { ...m('Code Quality', 'Test Coverage', 'jacoco'), rowsOnly: true, rows: [
    { classes: ['Performance Test Code Coverage'], primary: ['jacoco'], secondary: [] },
  ] },
  { ...m('Static Code Analysis', 'Secret Detection', 'detect-secrets', 'gitleaks'), rowsOnly: true, rows: [
    { classes: ['Hardcoded Secret Scan', 'Pre-Commit Secret Prevention'], primary: [], secondary: ['detect-secrets', 'gitleaks'] },
  ] },
  { ...m('Security Testing', 'Secret Detection', 'detect-secrets', 'gitleaks'), rowsOnly: true, rows: [
    { classes: ['Hardcoded Secret Detection', 'Pre-Commit Secret Prevention', 'Secrets in Git History'], primary: [], secondary: ['detect-secrets', 'gitleaks'] },
  ] },
  { ...m('Performance Testing', 'Static Analysis', 'lizard', 'semgrep-perf-static'), rowsOnly: true, rows: [
    { classes: ['Complexity-Based Perf Risk'], primary: ['lizard'], secondary: [] },
    { classes: ['Big-O Complexity Review', 'N+1 Query Pattern Detection', 'Memory Allocation Analysis', 'Thread-Safety Detection'], primary: ['semgrep-perf-static'], secondary: [] },
  ] },
  { ...m('Performance Testing', 'Dependency Analysis', 'java-perf-dependency'), rowsOnly: true, rows: [
    { classes: ['Unused Dependency Detection', 'Circular Dependency Detection', 'Build Time Regression'], primary: ['java-perf-dependency'], secondary: [] },
  ] },
  { ...m('FERPA/COPPA Compliance', 'Student PII Exposure Scan', 'presidio'), rowsOnly: true, rows: [
    { classes: ['PII in Codebase Detection'], primary: ['presidio'], secondary: [] },
  ] },
  { ...m('FERPA/COPPA Compliance', 'PII Logging Detection', 'semgrep-pii'), rowsOnly: true, rows: [
    { classes: ['PII in Log Statements'], primary: ['semgrep-pii'], secondary: [] },
  ] },
];

const MAPS: Record<Language, TechniqueTool[]> = { javascript: JS, typescript: TS, csharp: CS, python: PY, java: JV };

export const toolsFor = (language: Language): TechniqueTool[] => MAPS[language];

/** "C#, JavaScript, TypeScript" (Repository details → Language) → supported languages; the rest is returned as ignored. */
export function parseLanguages(names: string[]): { languages: Language[]; ignored: string[] } {
  const languages = new Set<Language>(); const ignored: string[] = [];
  for (const raw of names) {
    const n = raw.trim().toLowerCase();
    if (/^c#$|c-?sharp|\.net/.test(n)) languages.add('csharp');
    else if (/^java$/.test(n)) languages.add('java');
    else if (/^(java ?script|js)$/.test(n)) languages.add('javascript');
    else if (/^(type ?script|ts)$/.test(n)) languages.add('typescript');
    else if (/^(python|py)$/.test(n)) languages.add('python');
    else if (n) ignored.push(raw.trim());
  }
  return { languages: [...languages], ignored };
}
