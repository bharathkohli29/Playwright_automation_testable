import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAnswer, parseAnswer, scoreAll } from '../utils/rcaEval';

const gold = { oneLine: 'flake8 was expected for Python <V> but never ran.', whatHappened: ['The S3 check found no folder for flake8.'], why: 'No task was created for flake8, so it never reached a worker.', impact: 'flake8 is missing from the score input.', fix: 'Check why planning left flake8 out for Python <V>.' };
const row = { id: 'abc-flake8', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'TOOL: flake8 (python <V>)\nS3 RESULT: [Planning Defect] NOT_APPLICABLE: flake8 is expected for Python <V> but was not triggered\nSTATE OF THE TOOL: NOT TRIGGERED' }, { role: 'assistant', content: JSON.stringify(gold) }] };

test('parseAnswer: clean JSON, JSON inside a code fence or text (not clean), and text that is no JSON', () => {
  assert.deepEqual(parseAnswer('{"a":1}'), { json: { a: 1 }, clean: true });
  assert.deepEqual(parseAnswer('Here you go:\n```json\n{"a":1}\n```'), { json: { a: 1 }, clean: false });
  assert.equal(parseAnswer('no json at all').json, null);
});

test('checkAnswer accepts a grounded answer and rejects a missing part, an invented path or number, another tool and broken JSON', () => {
  const ok = checkAnswer(row, { id: row.id, answer: JSON.stringify(gold) }, gold); assert.equal(ok.accepted, true); assert.equal(ok.f1, 1);
  const noPart = checkAnswer(row, { id: row.id, answer: JSON.stringify({ ...gold, fix: '' }) }, gold); assert.equal(noPart.complete, false); assert.equal(noPart.accepted, false);
  const inv = checkAnswer(row, { id: row.id, answer: JSON.stringify({ ...gold, fix: 'Edit /etc/planner/rules.toml and retry 9999 times.' }) }, gold); assert.equal(inv.accepted, false); assert.ok(inv.bad.length >= 2);
  const other = checkAnswer(row, { id: row.id, answer: JSON.stringify({ ...gold, oneLine: 'radon never ran.', why: 'radon was skipped.', whatHappened: ['radon had no folder.'], impact: 'radon is missing.', fix: 'Check radon.' }) }, gold); assert.equal(other.names, false);
  const wrapped = checkAnswer(row, { id: row.id, answer: `Sure!\n${JSON.stringify(gold)}` }, gold); assert.equal(wrapped.valid, false); assert.equal(wrapped.accepted, false); assert.ok(wrapped.parsed); // usable JSON, but not clean
  const broken = checkAnswer(row, { id: row.id, answer: '{"oneLine": "x"' }, gold); assert.equal(broken.accepted, false); assert.equal(broken.parsed, null);
  const leftover = checkAnswer(row, { id: row.id, answer: JSON.stringify({ ...gold, why: 'No task was created for flake8 on Python <:V>.' }) }, gold); assert.equal(leftover.accepted, false);
});

test('scoreAll scores every source on every case and treats a missing answer as not accepted', () => {
  const r = scoreAll([row], { good: [{ id: row.id, answer: JSON.stringify(gold) }], missing: [] });
  assert.equal(r.good[0].accepted, true); assert.equal(r.missing[0].accepted, false);
});
