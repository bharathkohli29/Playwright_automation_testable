import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { adfText, toIssue, JiraIssue } from '../utils/jira';
import { mergeIssues } from '../utils/jiraCache';
import { BugFact, collectFacts, parsePlacements } from '../utils/jiraFacts';
import { groupBugs, mentions, nameVariants, planGroup, planRun } from '../utils/jiraMatch';
import { commentText, createText, fingerprint, runAttachments, runComment, runText, runTitle } from '../utils/jiraDraft';
import { buildItems, summaryLine } from '../utils/jiraFile';

const issue = (key: string, summary: string, description: string, o: Partial<JiraIssue> = {}): JiraIssue => ({ key, summary, description, status: 'To Do', statusCategory: 'new', labels: [], updated: '2026-11-12T18:55:28.412+0530', attachments: [], url: `https://x/browse/${key}`, ...o });
const bug = (tool: string, tag: string, o: Partial<BugFact> = {}): BugFact => ({ tool, tag, observed: 'NOT_APPLICABLE', note: `${tool} was not triggered`, kind: 'Primary', metrics: 'primary for X', ...o });
const placement = (tool: string) => ({ tool, reason: 'EXECUTION_RUNTIME_UNAVAILABLE', detail: 'eligible, but no available runtime satisfies its DECOUPLED coupling', coupling: 'DECOUPLED', via: 'tools_unplaceable' as const });
const ctx = { branch: 'PY_V312_SETUPTOOLS_PIP_MICRO', language: 'Python', version: '3.12' };

// what TP-6370 looks like in Jira (hand-written, one ticket for several tools of the branch)
const TP6370 = issue('TP-6370', 'PY 3.12 SETUPTOOLS_PIP_MICRO — coverage-py / pymcdc / complexipy not executed on whitebox run c5512076 (planning gap; tools registered + worker READY)',
  'Repo Python_Corpus_Tool_Triggering Branch PY_V312_SETUPTOOLS_PIP_MICRO Python 3.12.11. coverage.py coverage-py pymcdc complexipy PyDriller pydriller. Failure mode is whitebox planning / orchestration, not RUNTIME_IMAGE_DRIFT.');
const TP6335 = issue('TP-6335', 'Python 3.12 – 11/14 primary tools not triggered due to RUNTIME_IMAGE_DRIFT in run 4936290a', 'Branch PY_V312_UV_PIP_MONO Python 3.12 coverage-py pymcdc refused with RUNTIME_IMAGE_DRIFT');
const TP6369 = issue('TP-6369', 'Semgrep and jscpd-py Fail Due to Missing Runtime Dependencies', 'jscpd-py could not start: command not found (exit 127).');
const TP6371 = issue('TP-6371', 'Java Tool Catalog Missing Declarations – 7 Tools Not Triggered During Java Runs', 'Java tools lizard pmd');

test('name variants: coverage.py / coverage-py / PyDriller are found, other words are not', () => {
  assert.ok(nameVariants('coverage-py').includes('coverage.py'));
  assert.ok(mentions('uses coverage.py and pytest', 'coverage-py'));
  assert.ok(mentions('PyDriller only', 'pydriller'));
  assert.ok(!mentions('the pylinting step', 'pylint'));
  assert.ok(!mentions('ck and cks', 'cpd'));
});

test('groups: all not-placed tools of a run are one group, a runner failure is its own group', () => {
  const g = groupBugs([bug('coverage-py', '[Planning Defect]'), bug('jscpd-py', '[Runner Execution Defect]', { observed: 'FAILED' }), bug('pymcdc', '[Planning Defect]')]);
  assert.equal(g.length, 2); assert.equal(g[0].kind, 'planning'); assert.deepEqual(g[0].tools.map((t) => t.tool), ['coverage-py', 'pymcdc']); assert.equal(g[1].kind, 'runner');
});

test('planning group: tools named in the open ticket of this branch get a comment, the others a new bug', () => {
  const [g] = groupBugs(['coverage-py', 'pymcdc', 'complexipy', 'pydriller', 'gitleaks', 'cosmic-ray'].map((t) => bug(t, '[Planning Defect]')));
  const a = planGroup(g, ctx, [TP6370, TP6335, TP6369, TP6371], 'r1');
  const c = a.find((x) => x.type === 'comment'); const n = a.find((x) => x.type === 'create');
  assert.ok(c && c.type === 'comment' && c.key === 'TP-6370'); assert.deepEqual(c.tools.sort(), ['complexipy', 'coverage-py', 'pydriller', 'pymcdc']);
  assert.ok(n && n.type === 'create'); assert.deepEqual(n.tools.sort(), ['cosmic-ray', 'gitleaks']);
});

test('a ticket of another branch with a different cause (TP-6335, RUNTIME_IMAGE_DRIFT) is only a possible match: a person decides', () => {
  const [g] = groupBugs([bug('coverage-py', '[Planning Defect]')]);
  const a = planGroup(g, ctx, [TP6335], 'r1');
  assert.equal(a.length, 1); assert.equal(a[0].type, 'review'); assert.ok(a[0].type === 'review' && a[0].keys.includes('TP-6335'));
});

test('runner failure with the same cause words (exit 127 / could not start) is covered by TP-6369', () => {
  const [g] = groupBugs([bug('jscpd-py', '[Runner Execution Defect]', { observed: 'FAILED' })]);
  const a = planGroup(g, ctx, [TP6369, TP6370], 'r1');
  assert.equal(a.length, 1); assert.ok(a[0].type === 'comment' && a[0].key === 'TP-6369');
});

test('nothing in Jira names the tool: a new bug', () => {
  const [g] = groupBugs([bug('gitleaks', '[Planning Defect]')]);
  const a = planGroup(g, ctx, [TP6371], 'r1'); assert.equal(a.length, 1); assert.equal(a[0].type, 'create');
});

test('a tool already logged for this run id is skipped, not logged twice', () => {
  const [g] = groupBugs([bug('coverage-py', '[Planning Defect]'), bug('gitleaks', '[Planning Defect]')]);
  const a = planGroup(g, ctx, [TP6370], 'r1', [{ runId: 'r1', tool: 'coverage-py', key: 'TP-6370', action: 'comment', at: 'x' }]);
  assert.ok(a.some((x) => x.type === 'skip' && x.tools.includes('coverage-py'))); assert.ok(a.some((x) => x.type === 'create' && x.tools.includes('gitleaks')));
  assert.ok(!a.some((x) => x.type === 'comment'));
});

const facts = (bugs: BugFact[]) => ({ dir: '/x', language: 'Python', langKey: 'python', version: '3.12', branch: 'PY_V312_SETUPTOOLS_PIP_MICRO', runId: '55603dcd-4274-44c2-9c07-b8e874930691', short: '55603dcd', repo: 'Nandhini-Testable/Python_Corpus_Tool_Triggering', commit: '0fe0932838c8cfd978922ef6f5ccaf3a45beaefe', buildLine: 'SETUPTOOLS · Python 3.12.11', runLine: 'failed · 17/18 tasks completed · 1 failed', cluster: 'qa-eks', bugs, notBugs: [], placementOnly: [placement('lizard')], okTools: 15, expected: 26, fullVersion: '3.12.11', date: '12-11-2026', rows: [{ tool: 'radon', kind: 'Primary', state: 'OUTPUT', verdict: 'ok', metrics: 'x', note: '' }, ...bugs.map((b) => ({ tool: b.tool, kind: 'Primary', state: b.observed === 'FAILED' ? 'FAILED' : 'NOT_TRIGGERED', verdict: 'bug', metrics: 'x', note: '' }))], prior: { short: 'df4ee1e1', ok: 20, expected: 26, date: '2026-11-10' }, taxonomyHtml: '/x/taxonomy-gate-55603dcd-4274-44c2-9c07-b8e874930691.html', resultsXlsx: '/x/Tool_Execution_Results_55603dcd_PY_V312_SETUPTOOLS_PIP_MICRO_12-11-2026.xlsx' });

test('new bug text has the sections of TP-6370 and names the tools, the run and the attachments', () => {
  const bugs = [bug('coverage-py', '[Planning Defect]', { placement: placement('coverage-py'), defectPdf: '/x/bugs/Defect_Report_coverage-py.pdf', rcaPdf: '/x/RCA Report/Not triggered/RCA_coverage-py.pdf' }), bug('gitleaks', '[Planning Defect]', { placement: { ...placement('gitleaks'), reason: 'HOST_RUNTIME_UNAVAILABLE', via: 'compatibility_excluded' } })];
  const f = facts(bugs); const [g] = groupBugs(bugs); const t = createText(f, g, bugs);
  for (const h of ['h2. Environment', 'h2. Summary', 'h2. Affected tools', 'h2. Evidence', 'h2. Root cause', 'h2. Suggested fix', 'h2. Acceptance criteria', 'h2. Attachments']) assert.ok(t.description.includes(h), h);
  assert.ok(t.description.includes('55603dcd-4274-44c2-9c07-b8e874930691')); assert.ok(t.description.includes('EXECUTION_RUNTIME_UNAVAILABLE') && t.description.includes('HOST_RUNTIME_UNAVAILABLE'));
  assert.ok(t.description.includes('[^Defect_Report_coverage-py_55603dcd.pdf]') && t.description.includes('[^RCA_coverage-py_55603dcd.pdf]')); assert.ok(t.description.includes('lizard'));
  assert.match(t.summary, /coverage-py \/ gitleaks not executed on whitebox run 55603dcd/); assert.ok(t.labels.some((l) => /^wb-fp-[0-9a-f]{10}$/.test(l)));
  assert.equal(t.labels.at(-1), fingerprint(f, g, ['coverage-py', 'gitleaks']));
});

test('comment text carries the run id, the tools and the reason', () => {
  const bugs = [bug('pymcdc', '[Planning Defect]', { placement: placement('pymcdc') })]; const [g] = groupBugs(bugs);
  const c = commentText(facts(bugs), g, bugs);
  assert.ok(c.includes('55603dcd-4274-44c2-9c07-b8e874930691') && c.includes('pymcdc') && c.includes('EXECUTION_RUNTIME_UNAVAILABLE'));
});

test('buildItems: comment + create + summary line for the run', () => {
  const bugs = ['coverage-py', 'gitleaks'].map((t) => bug(t, '[Planning Defect]', { placement: placement(t) }));
  const items = buildItems(facts(bugs), [TP6370], [], true, 'cause');
  assert.deepEqual(items.map((i) => i.action).sort(), ['comment', 'create']); assert.equal(summaryLine(items), '1 comment (TP-6370) · 1 new');
  assert.ok(items.every((i) => i.status === 'planned' && i.text.length > 20));
});

test('placements are read from the orchestrator log lines', () => {
  const line = '[cell-001-wb-orchestrator] [pod/x] 2026-11-12T11:51:32Z ' + JSON.stringify({ message: 'planning.tools_unplaceable', cell_id: 'cell-001', fabric_id: 'fabric-us-01', tools: [{ tool: 'coverage-py', toolVersion: '7.16.2', reason: 'EXECUTION_RUNTIME_UNAVAILABLE', detail: 'eligible,_but_no_available_runtime_satisfies_its_DECOUPLED_coupling' }] })
    + '\n[a] [b] t ' + JSON.stringify({ message: 'planning.compatibility_excluded', excluded: [{ tool_name: 'gitleaks', tool_version: '8.18.2', reason: 'HOST_RUNTIME_UNAVAILABLE', detail: "no registered environment for runtime family 'native'", runtime_coupling: 'TARGET_COMPATIBLE' }] });
  const p = parsePlacements(line);
  assert.equal(p.map.get('coverage-py')!.reason, 'EXECUTION_RUNTIME_UNAVAILABLE'); assert.equal(p.map.get('coverage-py')!.coupling, 'DECOUPLED'); assert.equal(p.map.get('gitleaks')!.coupling, 'TARGET_COMPATIBLE'); assert.equal(p.cell, 'cell-001 (fabric-us-01)');
});

test('collectFacts reads a branch folder (s3-check, run-details, bugs.json, services log, failure.json, RCA index)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-facts-')); const w = (f: string, c: unknown) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), typeof c === 'string' ? c : JSON.stringify(c)); };
  w('s3-check.json', { repo: 'o/r', branch: 'PY_V312_X', run_id: 'abcdef12-0000', commit_sha: 'c0ffee', python: { version: '3.12', expected: 3, ok: 1, clean: 0, tools: [{ tool: 'jscpd-py', kind: 'Primary', metrics: 'primary for Code Duplication' }, { tool: 'coverage-py', kind: 'Primary', metrics: '' }, { tool: 'lizard', kind: 'Secondary', metrics: '' }], defects: [{ tool: 'jscpd-py', tag: '[Runner Execution Defect]', observed: 'FAILED', note: 'failure.json' }, { tool: 'coverage-py', tag: '[Planning Defect]', observed: 'NOT_APPLICABLE', note: 'not triggered' }] } });
  w('run-details.json', { status: 'failed', total_tasks: 18, completed_tasks: 17, failed_tasks: 1, overall_score: 67 }); w('repo-details.json', { 'Project type': 'SETUPTOOLS', 'Language version': '3.12.11' });
  w('bugs/bugs.json', { bugs: [{ tool: 'jscpd-py', pdf: 'Defect_Report_jscpd-py.pdf', summary: '[Whitebox][Python 3.12][jscpd-py] Tool failed to run on the worker' }] });
  w('eks-live/services.log', 'x ' + JSON.stringify({ message: 'planning.tools_unplaceable', tools: [{ tool: 'coverage-py', reason: 'EXECUTION_RUNTIME_UNAVAILABLE', detail: 'd' }, { tool: 'lizard', reason: 'EXECUTION_RUNTIME_UNAVAILABLE', detail: 'd' }] }));
  w('s3-evidence/jscpd-py/u/0/failure.json', { reason: '/usr/bin/jscpd could not start (exit 127, no output)', error_code: 'permanent_runner_error', tool_version: '5.4.1' });
  w('RCA Report/index.json', { reports: [{ tool: 'jscpd-py', file: 'Triggered/RCA_jscpd-py.pdf' }] }); w('RCA Report/Triggered/RCA_jscpd-py.pdf', 'pdf');
  const f = collectFacts(d)!;
  assert.equal(f.language, 'Python'); assert.equal(f.short, 'abcdef12'); assert.equal(f.bugs.length, 2);
  const j = f.bugs.find((b) => b.tool === 'jscpd-py')!; assert.equal(j.failure!.errorCode, 'permanent_runner_error'); assert.ok(j.rcaPdf!.endsWith('RCA_jscpd-py.pdf')); assert.ok(j.defectPdf!.endsWith('Defect_Report_jscpd-py.pdf'));
  assert.equal(f.bugs.find((b) => b.tool === 'coverage-py')!.placement!.reason, 'EXECUTION_RUNTIME_UNAVAILABLE'); assert.deepEqual(f.placementOnly.map((p) => p.tool), ['lizard']);
});

test('local copy: a changed issue is replaced, a closed one leaves, a new one is added', () => {
  const c = { project: 'TP', lastSync: '', issues: [TP6370, TP6335] };
  const m = mergeIssues(c, [{ ...TP6370, summary: 'changed' }, { ...TP6335, statusCategory: 'done' }, TP6369]);
  assert.deepEqual(m.issues.map((i) => i.key).sort(), ['TP-6369', 'TP-6370']); assert.equal(m.issues.find((i) => i.key === 'TP-6370')!.summary, 'changed');
});

test('Jira document format is flattened to text; an issue is read from the search result', () => {
  const adf = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'coverage-py ' }, { type: 'text', text: 'missing' }] }, { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'pymcdc' }] }] }] }] }] };
  assert.match(adfText(adf), /coverage-py missing/); assert.match(adfText(adf), /pymcdc/);
  const i = toIssue('https://t.atlassian.net', { key: 'TP-1', fields: { summary: 's', description: adf, status: { name: 'To Do', statusCategory: { key: 'new' } }, labels: ['a'], attachment: [{ filename: 'RCA.pdf' }] } });
  assert.equal(i.url, 'https://t.atlassian.net/browse/TP-1'); assert.deepEqual(i.attachments, ['RCA.pdf']); assert.match(i.description, /coverage-py/);
});

/* ---- one ticket per branch run (TP-6335 layout) ---- */
const runBugs = () => [bug('coverage-py', '[Planning Defect]', { placement: placement('coverage-py'), rcaPdf: '/x/RCA Report/Not triggered/RCA_coverage-py.pdf', defectPdf: '/x/bugs/Defect_Report_coverage-py_PY312_55603dcd.pdf' }),
  bug('gitleaks', '[Planning Defect]', { placement: { ...placement('gitleaks'), reason: 'HOST_RUNTIME_UNAVAILABLE', via: 'compatibility_excluded' } }),
  bug('jscpd-py', '[Runner Execution Defect]', { observed: 'FAILED', failure: { reason: '/usr/bin/jscpd could not start (exit 127, no output)', errorCode: 'permanent_runner_error', version: '5.4.1' } })];

test('run title: language, version, n/total, causes, full run id (like TP-6335)', () => {
  const t = runTitle(facts(runBugs()));
  assert.equal(t, 'Python 3.12 – 3/26 tools not triggered or failed due to EXECUTION_RUNTIME_UNAVAILABLE / HOST_RUNTIME_UNAVAILABLE / permanent_runner_error in run 55603dcd-4274-44c2-9c07-b8e874930691');
});

test('run text has the TP-6335 sections, the three outcome tables, prior-run comparison and the five attachments', () => {
  const f = facts(runBugs()); const t = runText(f).description;
  for (const h of ['h2. Environment', 'h2. Summary', 'h2. Tools - triggered', 'h2. Tools - dispatched but failed', 'h2. Tools - not triggered', 'h2. Root cause', 'h2. Suggested Fix', 'h2. Acceptance criteria', 'h2. Attachments']) assert.ok(t.includes(h), h);
  assert.ok(t.includes('3.12.11') && t.includes('df4ee1e1') && t.includes('15 of 26') && t.includes('permanent_runner_error'));
  assert.ok(t.includes('[^Tool_Execution_Results_55603dcd_PY_V312_SETUPTOOLS_PIP_MICRO_12-11-2026.xlsx]') && t.includes('[^taxonomy-gate-55603dcd-4274-44c2-9c07-b8e874930691.html]') && t.includes('[^RCA_coverage-py_55603dcd.pdf]') && t.includes('[^Defect_Report_coverage-py_PY312_55603dcd.pdf]'));
  assert.deepEqual(runText(f).labels, []);
  assert.equal(runAttachments(f).length, 4);
});

test('planRun: create when nobody covers the branch, comment when an open ticket names the branch and tools, review when only the tools match, skip when filed', () => {
  const f = facts(runBugs());
  assert.equal(planRun(f, [TP6369, TP6371], [])[0].type, 'create');
  const mine = issue('TP-7000', 'Python 3.12 – 3/26 tools not triggered', 'Branch PY_V312_SETUPTOOLS_PIP_MICRO coverage-py gitleaks EXECUTION_RUNTIME_UNAVAILABLE');
  const c = planRun(f, [mine, TP6371], [])[0]; assert.equal(c.type, 'comment'); assert.equal((c as any).key, 'TP-7000');
  const other = issue('TP-7001', 'coverage.py and gitleaks missing', 'coverage-py gitleaks on another branch PY_V311_OTHER');
  assert.equal(planRun(f, [other], [])[0].type, 'review');
  const drift = issue('TP-7002', 'RUNTIME_IMAGE_DRIFT', 'Branch PY_V312_SETUPTOOLS_PIP_MICRO coverage-py RUNTIME_IMAGE_DRIFT');
  assert.notEqual(planRun(f, [drift], [])[0].type, 'comment');
  const filed = ['coverage-py', 'gitleaks', 'jscpd-py'].map((tool) => ({ runId: f.runId, tool, key: 'TP-7000', action: 'create', at: 'x' }));
  assert.equal(planRun(f, [], filed)[0].type, 'skip');
});

test('buildItems (default = run): one create item for the whole run, with all attachments; comment text carries counts and the earlier run', () => {
  const f = facts(runBugs()); const items = buildItems(f, [], [], true);
  assert.equal(items.length, 1); assert.equal(items[0].action, 'create'); assert.equal(items[0].title, runTitle(f)); assert.equal(items[0].attachments.length, 4); assert.equal(summaryLine(items), '1 new');
  const c = runComment(f); assert.ok(c.includes('15/26') && c.includes('df4ee1e1') && c.includes('jscpd-py'));
});

test('a tool that ran and reported not_applicable is NOT written up as "never started": it has its own table, cause and fix', () => {
  const bugs = [bug('semgrep', '[Planning Defect]'), bug('npm-audit', '[Planning Defect]', { note: 'npm-audit is expected for Node 21 but only reported not_applicable (file_missing_or_empty)', observed: 'NOT_APPLICABLE' }), bug('pydriller', '[Runner Execution Defect]', { observed: 'FAILED', failure: { reason: 'git exit 128', errorCode: 'permanent_runner_error', version: '' } })];
  const f = { ...facts(bugs), language: 'JavaScript', version: '21', rows: [{ tool: 'semgrep', kind: 'Primary', state: 'NOT_TRIGGERED', verdict: 'bug', metrics: '', note: '' }, { tool: 'npm-audit', kind: 'Primary', state: 'SKIPPED', verdict: 'bug', metrics: '', note: '' }, { tool: 'pydriller', kind: 'Primary', state: 'FAILED', verdict: 'bug', metrics: '', note: '' }] };
  assert.equal(runTitle(f), 'JavaScript 21 – 3/26 tools not triggered or failed due to no S3 folder / not_applicable (file_missing_or_empty) / permanent_runner_error in run 55603dcd-4274-44c2-9c07-b8e874930691');
  const t = runText(f).description;
  assert.ok(t.includes('h2. Tools - ran but reported not applicable') && t.includes('*ran but reported not applicable*') && t.includes('h2. Tools - not triggered (no S3 folder)') && t.includes('h2. Tools - dispatched but failed'));
  assert.ok(!/\*npm-audit\*[^.]*never started/.test(t)); assert.ok(t.includes('orchestrator log of this run was not captured')); assert.ok(runComment(f).includes('reported not_applicable (file_missing_or_empty)'));
});
