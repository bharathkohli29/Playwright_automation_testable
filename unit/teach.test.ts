import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadPrompt, ruleAnswer, checkAnswer, type Case } from '../utils/teach';
import { liveEvidence, rcaInput, type LiveEvidence } from '../utils/eksDiagnose';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'teach-'));
const P = loadPrompt();
const mk = (tool: string, state: string, lines: string[]): Case => {
  const ev: LiveEvidence = { tool, lines, sources: [], signature: '', podReason: '' };
  const dir = tmp();
  return { tool, state, ev, runId: 'run-1', folder: dir, input: rcaInput(tool, 'run-1', dir, ev, { state, s3: state === 'NOT_TRIGGERED' ? 'no folder' : '[]' }) };
};
const ok = (c: Case, a: string | null) => { assert.ok(a, 'a rule answer was expected'); assert.deepEqual(checkAnswer(a!, c.input, P.verdicts), []); return a!; };

test('the prompt file gives the system prompt and the seven allowed verdicts', () => {
  assert.match(P.system, /^You are the Whitebox QA RCA writer/);
  assert.deepEqual(P.verdicts, ['Blocked at startup', 'Excluded in planning', 'Rejected at admission', 'Tool failed', 'Tool produced empty output', 'Skipped by the tool', 'Insufficient evidence']);
});

test('the training script and register_model.py list the same verdicts as RCA_PROMPT.md', () => {
  // the repo Modelfile is NOT checked here on purpose: it keeps the prompt of the deployed weights until register_model.py --promote writes the new one
  const root = path.join(__dirname, '..', 'qa-eks-mentor');
  const line = `Verdict: <${P.verdicts.join(' | ')}>`;
  for (const f of ['training/prepare_dataset.py', 'register_model.py']) assert.ok(fs.readFileSync(path.join(root, f), 'utf8').includes(line), `${f} has an older verdict list`);
});

test('every saved training row carries the current system prompt', () => {
  const f = path.join(__dirname, '..', 'qa-eks-mentor', 'training', 'dataset.jsonl');
  for (const l of fs.readFileSync(f, 'utf8').split('\n').filter((x) => x.trim())) assert.equal(JSON.parse(l).messages[0].content.trim(), P.system.trim());
});

test('readiness block names the tool: Blocked at startup, owner is the worker', () => {
  const c = mk('cdxgen', 'NOT_TRIGGERED', ['18:00:56 ERROR wb-cpu-worker: worker.tool_readiness_blocked_execution (tool_name=cdxgen reason=FAILED_STARTUP_CHECK readiness_status=NOT_APPLICABLE queue=wb.exec.cpu.cell-001.worker-node-20)']);
  const a = ok(c, ruleAnswer(c, P.verdicts));
  assert.match(a, /Verdict: Blocked at startup/); assert.match(a, /Owner: wb-cpu-worker/);
});

test('planning exclusion names the tool: Excluded in planning', () => {
  const c = mk('crosshair', 'NOT_TRIGGERED', ['18:52:35 INFO wb-orchestrator: planning.compatibility_excluded (tool_name=crosshair reason=CUSTOMER_CODE_INCOMPATIBLE_WITH_EXECUTION_ENV)']);
  assert.match(ok(c, ruleAnswer(c, P.verdicts)), /Verdict: Excluded in planning/);
});

test('handler.failed and failure.json both give Tool failed (failure.json names no component: Unknown)', () => {
  const h = mk('biome', 'FAILED', ['18:00:27 WARNING wb-cpu-worker: handler.failed (tool_name=biome reason=parse_error)']);
  assert.match(ok(h, ruleAnswer(h, P.verdicts)), /Verdict: Tool failed/);
  const f = mk('pydriller', 'FAILED', ['failure.json: permanent_runner_error · failed · pydriller traversal failed: [Errno 13] Permission denied']);
  const a = ok(f, ruleAnswer(f, P.verdicts));
  assert.match(a, /Verdict: Tool failed/); assert.match(a, /Owner: Unknown/);
});

test('no evidence at all: Insufficient evidence for NOT_TRIGGERED, EMPTY and FAILED; a tool with output needs no RCA', () => {
  for (const s of ['NOT_TRIGGERED', 'EMPTY', 'FAILED']) { const c = mk('lizard', s, []); assert.match(ok(c, ruleAnswer(c, P.verdicts)), /Verdict: Insufficient evidence/); }
  const o = mk('eslint', 'OUTPUT', []); assert.equal(ruleAnswer(o, P.verdicts), 'No RCA needed: the tool produced output.');
  assert.deepEqual(checkAnswer('No RCA needed: the tool produced output.', o.input, P.verdicts), []);
  assert.equal(checkAnswer('No RCA needed: the tool produced output.', mk('x', 'EMPTY', []).input, P.verdicts).length, 1);
});

test('admission rejection: Rejected at admission, owner is the orchestrator, and no rule answer when the prompt lacks that verdict', () => {
  const c = mk('cpd', 'NOT_TRIGGERED', ['09:11:14 WARNING wb-orchestrator: dispatch.admission_rejected_task (tool_name=cpd reason=CELL_CPU_CAPACITY environment_id=worker-jvm-21)']);
  const a = ok(c, ruleAnswer(c, P.verdicts));
  assert.match(a, /Verdict: Rejected at admission/); assert.match(a, /Owner: wb-orchestrator/); assert.match(a, /CELL_CPU_CAPACITY/);
  assert.equal(ruleAnswer(c, P.verdicts.filter((v) => v !== 'Rejected at admission')), null);
});

test('pod or console lines need a person (no rule answer)', () => {
  const c = mk('semgrep', 'FAILED', ['pod wb-exec-abc-def: OOMKilled · exit code 137']);
  assert.equal(ruleAnswer(c, P.verdicts), null);
});

test('answer checks: unknown verdict, speculation, invented identifier, too long, missing line', () => {
  const c = mk('lizard', 'EMPTY', []);
  const good = ruleAnswer(c, P.verdicts)!;
  assert.ok(checkAnswer(good.replace('Insufficient evidence', 'Probably fine'), c.input, P.verdicts).some((p) => /not one of/.test(p)));
  assert.ok(checkAnswer(good.replace('so the logs do not show why.', 'so it is probably transient.'), c.input, P.verdicts).some((p) => /speculation/.test(p)));
  assert.ok(checkAnswer(good + '\nSee wb-made-up-pod-1', c.input, P.verdicts).some((p) => /not in the input/.test(p)));
  assert.ok(checkAnswer(good + ' ' + 'word '.repeat(130), c.input, P.verdicts).some((p) => /words/.test(p)));
  assert.ok(checkAnswer(good.replace(/^Owner:.*$/m, ''), c.input, P.verdicts).some((p) => /owner:/.test(p)));
});

test('service evidence matches the tool NAME, not a piece of another name (cpd vs jscpd-py, ck vs check)', () => {
  const d = tmp(); fs.mkdirSync(path.join(d, 'eks-live'));
  const line = (o: object) => `[cell-001-wb-orchestrator] [pod/x/wb-orchestrator] 2026-11-02T09:11:14Z ${JSON.stringify({ timestamp: '2026-11-02T09:11:14+00:00', level: 'WARNING', service_name: 'wb-orchestrator', ...o })}`;
  fs.writeFileSync(path.join(d, 'eks-live', 'services.log'), [
    line({ message: 'dispatch.admission_rejected_task', tool_name: 'cpd', reason: 'CELL_CPU_CAPACITY' }),
    line({ message: 'dispatcher.task_published', tool_name: 'jscpd-py', queue: 'q' }),
    line({ message: 'dispatch.admission_rejected_task', tool_name: 'checkstyle', reason: 'CELL_CPU_CAPACITY' }),
  ].join('\n'));
  const cpd = liveEvidence(d, 'cpd')!; assert.ok(cpd); assert.equal(cpd.lines.length, 1); assert.match(cpd.lines[0], /tool_name=cpd /);
  assert.equal(liveEvidence(d, 'ck'), null); // nothing names "ck"; "checkstyle" contains it only as a piece of a longer name
});

test('production and training build the same input block, and an empty evidence list reads LOG EVIDENCE: none', () => {
  const c = mk('lizard', 'EMPTY', []);
  assert.match(c.input, /^INPUT\nTOOL: lizard\nSTATE: EMPTY\nLANGUAGE: unknown\nBRANCH: .+ {3}RUN: run-1\nS3: \[\]\nLOG EVIDENCE: none\nPOD STATE: not captured$/);
});
