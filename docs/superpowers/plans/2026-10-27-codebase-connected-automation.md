# Codebase-Connected CI/CD Automation Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an event-driven, codebase-introspective CI/CD automation engine in `F:\Tool Validation Automation` that reads the platform codebase (`F:\ai-testable-platform`) strictly in read-only mode, auto-discovers active static tools and Next.js routes, analyzes git commit diffs, self-heals renamed UI buttons, and publishes executive deliverables to Jira with zero ongoing maintenance.

**Architecture:** Codebase-Introspective Hybrid Automation (Modular + Data-Driven + CI/CD):
1. **Platform Inspector & Read-Only Sensors (`core/platform_inspector.py`, `core/catalog_sync.py`, `core/route_discoverer.py`):** Pure AST and filesystem parsing of platform ground truth without modifying or executing platform code.
2. **Git Diff Impact Analyzer (`core/build_analyzer.py`):** Filters commits using `git diff HEAD~1` to run targeted test suites or exit in 3s on docs-only changes.
3. **Self-Healing Action Engine (`core/smart_actions.py`):** Semantic intent matching and auto-kebab unfurling to prevent test breaks when UI buttons are renamed or moved.
4. **Cloud Reporting & Delivery (`core/jira_bot_poster.py`, `cli.py`, `.github/workflows/whitebox-validation-bot.yml`):** Formats native Jira pills `[^filename.ext]` and executes autonomously in serverless CI/CD.

**Tech Stack:**
- Python 3.13+
- Pydantic v2
- Playwright (Headless Chromium)
- Git CLI (Read-only status and diff queries)
- ReportLab & OpenPyXL (Exporters)
- Pytest (Verification)

## Global Constraints

- **STRICT NON-DESTRUCTIVE ACCESS:** Under NO circumstances may any file inside `F:\ai-testable-platform` be created, modified, staged, or deleted. All reading must be pure read-only inspection.
- **ZERO CODE CHANGES IN PLATFORM:** No test packages, libraries, or hooks may be installed in `F:\ai-testable-platform`.
- **EXECUTIVE QA STANDARD:** Reporting deliverables must adhere to the Saravanan Selvaraj / Rathiba / Benny QA standard (Executive BLUF, zero code clutter, native Jira pills `[^filename.ext]`).
- **SERVERLESS EFFICIENCY:** Immediate power-down when commits touch only non-testable files (`*.md`, `docs/*`, `.gitignore`).

---

## File Structure & Responsibilities

| File Path | Responsibility |
| :--- | :--- |
| `conftest.py` | Pytest path resolution ensuring `core` and `reporters` are discoverable. |
| `core/platform_inspector.py` | Validates platform root, queries Git commit/branch metadata, reads platform version. |
| `core/catalog_sync.py` | AST parser reading `shared/scoring/technique_tool.py` to dynamically construct `ToolSpec` catalog. |
| `core/route_discoverer.py` | Scans `frontend/web-console/src/app` for `page.tsx` files to map live URL routes. |
| `core/build_analyzer.py` | Runs `git diff HEAD~1 --name-only` to categorize build changes (`NO_OP`, `WHITEBOX`, `E2E_UI`, `FULL_RUN`). |
| `core/smart_actions.py` | Resolves buttons by semantic intent (`AUTH`, `TRIGGER`, etc.) and handles 3-dots kebab dropdowns. |
| `core/jira_bot_poster.py` | Formats Jira REST API payloads with native attachment pills `[^filename.ext]` and status comments. |
| `cli.py` | Unified CLI exposing `auto-validate` command connecting all phases. |
| `.github/workflows/whitebox-validation-bot.yml` | Serverless event-driven GitHub Actions runner workflow. |
| `tests/` | Comprehensive test suite verifying all components with mocked and live platform data. |

---

## Task Decomposition

### Task 1: Read-Only Platform Inspector (`core/platform_inspector.py`)
- [x] Verify directory structure and read-only access.
- [x] Implement version extraction from `VERSION` file.
- [x] Implement read-only Git commit and branch queries (`git rev-parse`).
- [x] Write tests in `tests/test_platform_inspector.py`.
- [x] Verify `pytest tests/test_platform_inspector.py -v` passes.

### Task 2: Tool Catalog & Taxonomy Synchronizer (`core/catalog_sync.py`)
- [x] Write failing test in `tests/test_catalog_sync.py` to extract primary/secondary tools from Python AST.
- [x] Implement `core/catalog_sync.py` with AST parser for `shared/scoring/technique_tool.py` and `shared/whitebox/tool_registry.py`.
- [x] Support mapping tools across JavaScript/TypeScript, Python, C#, and Java.
- [x] Verify `pytest tests/test_catalog_sync.py -v` passes.

### Task 3: Next.js Frontend Route & Page Discoverer (`core/route_discoverer.py`)
- [x] Write failing test in `tests/test_route_discoverer.py` for route scanning.
- [x] Implement `core/route_discoverer.py` scanning `frontend/web-console/src/app` and `admin-console`.
- [x] Parse Next.js App Router dynamic segments (e.g. `[runId]`, `[tenantId]`) into parameterized route maps.
- [x] Verify `pytest tests/test_route_discoverer.py -v` passes.

### Task 4: Git Build Impact Analyzer (`core/build_analyzer.py`)
- [x] Write failing test in `tests/test_build_analyzer.py` verifying commit diff classification.
- [x] Implement `core/build_analyzer.py` executing `git diff HEAD~1 --name-only`.
- [x] Implement impact rules (`NO_OP` for docs, `WHITEBOX` for tools, `E2E_UI` for console, `FULL_RUN` for orchestrator).
- [x] Verify `pytest tests/test_build_analyzer.py -v` passes.

### Task 5: Self-Healing Smart Action Engine (`core/smart_actions.py`)
- [x] Write failing test in `tests/test_smart_actions.py` for intent resolution and kebab menu unfurling.
- [x] Implement `core/smart_actions.py` with Intent mappings (`AUTH`, `TRIGGER`, `EXPORT`, `CONFIRM`, `CREATE`).
- [x] Implement auto-kebab unfurler (`[aria-label='Actions']` trigger) and `form button[type='submit']` role fallback.
- [x] Verify `pytest tests/test_smart_actions.py -v` passes.

### Task 6: Cloud Jira REST Poster & Native Pill Formatter (`core/jira_bot_poster.py`)
- [x] Write failing test in `tests/test_jira_bot_poster.py` for payload structure and native pills `[^filename.ext]`.
- [x] Implement `core/jira_bot_poster.py` with mockable Jira REST API client.
- [x] Format Saravanan/Rathiba/Benny executive BLUF summary and attachment badges.
- [x] Verify `pytest tests/test_jira_bot_poster.py -v` passes.

### Task 7: Unified CLI & Serverless CI/CD Bot Runner (`cli.py` & `.github/workflows/whitebox-validation-bot.yml`)
- [x] Write test for `cli.py auto-validate` in `tests/test_cli_auto_validate.py`.
- [x] Implement `auto-validate` command in `cli.py` chaining: Platform Inspector ➜ Catalog Sync ➜ Route Discoverer ➜ Build Analyzer ➜ Deliverables.
- [x] Create `.github/workflows/whitebox-validation-bot.yml` configuring event triggers (push, PR, S3).
- [x] Verify `pytest -v` across the entire test suite.

### Task 8: End-to-End Live Dry Run & Verification
- [x] Execute `python cli.py auto-validate --platform-path "F:/ai-testable-platform" --run-path "F:/ts_work/v21"` in dry-run mode.
- [x] Verify generated Excel tracker, PDF report, and Jira markdown output.
- [x] Confirm zero modifications or dirty files inside `F:\ai-testable-platform`.
