import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { liveEvidence, compactServiceLine } from '../utils/eksEvidence';
import { liveDiagnosis } from '../utils/eksRootCause';
import { matchToolRules as matchToolPattern } from '../utils/eksRules';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'));
const withLog = (lines: string[]) => { const d = tmp(); fs.mkdirSync(path.join(d, 'eks-live')); fs.writeFileSync(path.join(d, 'eks-live', 'services.log'), lines.join('\n')); return d; };
const svc = (o: object) => `[cell-001-wb-orchestrator] [pod/x/wb-orchestrator] 2026-11-03T10:31:47Z ${JSON.stringify({ timestamp: '2026-11-03T10:31:47.716219+00:00', level: 'INFO', service_name: 'wb-orchestrator', ...o })}`;
const UNPLACEABLE = svc({
  message: 'planning.tools_unplaceable', count: 2,
  tools: [
    { toolVersionId: null, tool: 'pip-outdated', toolVersion: '0.8.0', language: 'python', reason: 'EXECUTION_RUNTIME_UNAVAILABLE', detail: 'eligible, but no available runtime satisfies its DECOUPLED coupling' },
    { toolVersionId: null, tool: 'semgrep-pii', toolVersion: '1.0', language: 'python', reason: 'EXECUTION_RUNTIME_UNAVAILABLE', detail: 'eligible, but no available runtime satisfies its TARGET_COMPATIBLE coupling' },
  ],
});

test('planning.tools_unplaceable: the entry of the tool (reason, detail) reaches the evidence; a tool not in the list gets nothing', () => {
  const d = withLog([UNPLACEABLE]);
  const a = liveEvidence(d, 'pip-outdated')!; assert.ok(a); assert.equal(a.lines.length, 1);
  assert.match(a.lines[0], /tool_name=pip-outdated/); assert.match(a.lines[0], /reason=EXECUTION_RUNTIME_UNAVAILABLE/); assert.match(a.lines[0], /DECOUPLED_coupling/);
  assert.doesNotMatch(a.lines[0], /semgrep-pii/); // only its own entry
  assert.match(liveEvidence(d, 'semgrep-pii')!.lines[0], /TARGET_COMPATIBLE_coupling/);
  assert.equal(liveEvidence(d, 'semgrep'), null); // "semgrep" is only a piece of "semgrep-pii"
});

test('known pattern runtime-unavailable-unplaceable fires for the tool named in the line only', () => {
  const a = liveEvidence(withLog([UNPLACEABLE]), 'pip-outdated')!;
  const kp = matchToolPattern({ tool: 'pip-outdated', text: a.lines.join('\n') })!;
  assert.equal(kp.id, 'runtime-unavailable-unplaceable'); assert.match(kp.rootCause, /no available runtime satisfies its DECOUPLED coupling/);
  assert.equal(matchToolPattern({ tool: 'pymcdc', text: a.lines.join('\n') }), null);
});

test('service evidence matches the tool NAME, not a piece of another name (cpd vs jscpd-py, ck vs checkstyle)', () => {
  const d = withLog([
    svc({ level: 'WARNING', message: 'dispatch.admission_rejected_task', tool_name: 'cpd', reason: 'CELL_CPU_CAPACITY' }),
    svc({ level: 'WARNING', message: 'dispatcher.task_published', tool_name: 'jscpd-py', queue: 'q' }),
    svc({ level: 'WARNING', message: 'dispatch.admission_rejected_task', tool_name: 'checkstyle', reason: 'CELL_CPU_CAPACITY' }),
  ]);
  const cpd = liveEvidence(d, 'cpd')!; assert.ok(cpd); assert.equal(cpd.lines.length, 1); assert.match(cpd.lines[0], /tool_name=cpd /);
  assert.equal(liveEvidence(d, 'ck'), null); // "checkstyle" contains "ck" only as a piece of a longer name
});

test('diagnosis by rules: a known pattern is answered with the real line, other lines are returned as NO_KNOWN_PATTERN, no lines give null', async () => {
  const known = await liveDiagnosis('pip-outdated', 'run-1', withLog([UNPLACEABLE]), { observed: 'NOT_APPLICABLE' });
  assert.match(known!.verdict!, /^KNOWN PATTERN: runtime-unavailable-unplaceable/); assert.match(known!.evidence!, /tool_name=pip-outdated/); assert.match(known!.owner!, /Platform/);
  const other = await liveDiagnosis('lizard', 'run-1', withLog([svc({ level: 'WARNING', message: 'dispatcher.task_published', tool_name: 'lizard', queue: 'q' })]), { observed: 'EMPTY' });
  assert.match(other!.verdict!, /^NO_KNOWN_PATTERN/); assert.match(other!.evidence!, /tool_name=lizard/);
  assert.equal(await liveDiagnosis('semgrep', 'run-1', withLog([UNPLACEABLE]), { observed: 'x' }), null);
});

test('rules that replace the model: readiness block, planning skipped_tools (language:tool), pod completed without a result', async () => {
  // 1. the worker's startup check refused the tool
  const blocked = withLog([svc({ level: 'ERROR', service_name: 'wb-cpu-worker', message: 'worker.tool_readiness_blocked_execution', tool_name: 'semgrep-perf-static', skip_reason: 'MISSING_BINARY', readiness_status: 'NOT_INSTALLED' })]);
  const d1 = await liveDiagnosis('semgrep-perf-static', 'run-1', blocked, { observed: 'NOT_APPLICABLE' })!;
  assert.match(d1!.verdict!, /^KNOWN PATTERN: tool-readiness-blocked/); assert.match(d1!.rootCause!, /readiness_status NOT_INSTALLED, skip_reason MISSING_BINARY/); assert.match(d1!.owner!, /Platform/);
  // 2. planning lists the tool as "python:semgrep" in skipped_tools; "python:semgrep-pii" is another tool
  const skipped = withLog([svc({ message: 'planning.tools_skipped_startup_readiness', skipped_tools: ['python:semgrep'] })]);
  const d2 = await liveDiagnosis('semgrep', 'run-1', skipped, { observed: 'NOT_APPLICABLE' });
  assert.match(d2!.verdict!, /^KNOWN PATTERN: planning-skipped-startup-readiness/);
  assert.equal(await liveDiagnosis('semgrep-pii', 'run-1', skipped, { observed: 'NOT_APPLICABLE' }), null);
  // 3. the pod ended Completed but S3 has no result for the tool
  const d = tmp(); fs.mkdirSync(path.join(d, 'eks-live'));
  fs.writeFileSync(path.join(d, 'eks-live', 'tools.json'), JSON.stringify([{ tool: 'testmon', pod: 'wb-exec-abc-def', namespace: 'x', phase: 'Succeeded', exit_code: 0, reason: 'Completed' }]));
  const d3 = await liveDiagnosis('testmon', 'run-1', d, { observed: 'NOT_APPLICABLE', note: 'testmon is expected but not triggered: no folder in the run' });
  assert.match(d3!.verdict!, /^KNOWN PATTERN: pod-completed-no-output/);
  const fine = await liveDiagnosis('testmon', 'run-1', d, { observed: 'tool produced output', note: 'has data' });
  assert.doesNotMatch(fine!.verdict!, /pod-completed-no-output/); // a tool that has a result is not explained this way
  // 4. the checker says the tool ran although the matrix of this version excludes it
  const ran = await liveDiagnosis('testmon', 'run-1', d, { observed: 'RAN_BUT_EXCLUDED', note: 'testmon ran on Python 3.12 although the matrix excludes it' });
  assert.match(ran!.verdict!, /^KNOWN PATTERN: ran-but-excluded/); assert.match(ran!.evidence!, /pod wb-exec-abc-def/);
});

test('the model is gone: no module of the script imports Ollama or the model setup', () => {
  const utils = path.join(__dirname, '..', 'utils');
  for (const f of fs.readdirSync(utils).filter((x) => x.endsWith('.ts'))) assert.doesNotMatch(fs.readFileSync(path.join(utils, f), 'utf8'), /from '\.\/(eksModel|ollamaHost|ollamaInstall|teach)'/, `${f} still imports a model module`);
  assert.match(fs.readFileSync(path.join(utils, 'eksMentor.ts'), 'utf8').replace(/^\/\/.*$/gm, '').trim(), /^export type \{ EksAiDiagnosis \} from/, 'eksMentor.ts must stay a type-only stub');
});
