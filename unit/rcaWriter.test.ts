import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { buildFactPack } from '../utils/rcaFacts';
import { writeReport, ungrounded, factsText, rcaModelStatus } from '../utils/rcaWriter';
import { reportFromRules } from '../utils/rcaReport';

function branch() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rcaw-')); const live = path.join(d, 'eks-live'); fs.mkdirSync(path.join(live, 'pods', 'p1'), { recursive: true });
  fs.writeFileSync(path.join(live, 'pods', 'p1', 'console.log'), ["Usage: cosmic-ray init [OPTIONS] CONFIG_FILE SESSION_FILE", "Error: No such option '--force'."].map((l) => `[pod/p1/analyzer] 2026-11-03T10:32:52.5Z ${l}`).join('\n'));
  fs.writeFileSync(path.join(live, 'tools.json'), JSON.stringify([{ tool: 'cosmic-ray', task: 't1', pod: 'p1', phase: 'Failed', exit_code: 2, reason: 'Error', command: 'cosmic-ray init', console_file: 'pods/p1/console.log' }]));
  fs.writeFileSync(path.join(live, 'services.log'), ''); fs.writeFileSync(path.join(live, 'summary.json'), JSON.stringify({ run_id: 'r1', branch: 'PY_X' }));
  return d;
}
/** a fake Ollama: answers every /api/chat with the given content (or status) and counts the calls */
function fake(content: string, status = 200): Promise<{ url: string; calls: () => number; close: () => void }> {
  let n = 0; const s = http.createServer((req, res) => { req.resume().on('end', () => { n++; res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: { content } })); }); });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, calls: () => n, close: () => s.close() })));
}
const GOOD = JSON.stringify({ oneLine: 'cosmic-ray stopped at once because the runner gave it an option it does not have.', whatHappened: ['The init step of cosmic-ray ended with exit code 2.', "Its own message was: No such option '--force'."], why: 'The runner calls cosmic-ray with --force, but the version in the image does not accept it, so the tool stopped at once.', impact: 'The tool did not finish, so there is no result from it for this branch.', fix: 'Remove --force from the runner command, or install a cosmic-ray version that supports it.' });

test('the model wording is used when every identifier is in the facts; evidence and owner stay from the facts', async () => {
  const d = branch(); const f = await fake(GOOD);
  try {
    const p = buildFactPack(d, 'cosmic-ray'); const w = await writeReport(p, { host: f.url, model: 'x' });
    assert.equal(w.used, 'model'); assert.equal(w.report.source, 'model'); assert.equal(f.calls(), 1);
    assert.match(w.report.oneLine, /option it does not have/); assert.equal(w.report.evidence, reportFromRules(p).evidence); assert.equal(w.report.owner, reportFromRules(p).owner);
  } finally { f.close(); }
});

test('an answer with a path, option or number that is not in the facts is thrown away', async () => {
  const d = branch(); const f = await fake(GOOD.replace('--force from the runner command', '--retries 55 from /etc/cosmic/config.toml'));
  try { const w = await writeReport(buildFactPack(d, 'cosmic-ray'), { host: f.url, model: 'x' }); assert.equal(w.used, 'rules'); assert.match(w.note || '', /not in the facts/); assert.equal(w.report.source, 'rules'); } finally { f.close(); }
});

test('bad JSON, a missing field, another tool, an HTTP error and no server all fall back to the rule report', async () => {
  const d = branch(); const p = buildFactPack(d, 'cosmic-ray');
  for (const [body, status, why] of [['not json', 200, /valid JSON/], [JSON.stringify({ oneLine: 'cosmic-ray broke' }), 200, /missing/], [GOOD.replace(/cosmic-ray/g, 'radon'), 200, /name the tool/], [GOOD, 404, /HTTP 404/], [GOOD.replace('stopped at once.', 'stopped at once <:V>.'), 200, /placeholder/]] as [string, number, RegExp][]) {
    const f = await fake(body, status);
    try { const w = await writeReport(p, { host: f.url, model: 'x' }); assert.equal(w.used, 'rules'); assert.match(w.note || '', why); assert.equal(w.report.oneLine, reportFromRules(p).oneLine); } finally { f.close(); }
  }
  const w = await writeReport(p, { host: 'http://127.0.0.1:1', model: 'x', timeoutSec: 2 }); assert.equal(w.used, 'rules');
});

test('the model sees only this tool: facts text names the failed pod lines and the known cause, no other tool', () => {
  const p = buildFactPack(branch(), 'cosmic-ray'); const t = factsText(p, reportFromRules(p));
  assert.match(t, /KNOWN CAUSE/); assert.match(t, /No such option '--force'/); assert.doesNotMatch(t, /radon|gitleaks/);
  assert.deepEqual(ungrounded('see /etc/a/b and --foo 1234', t).sort(), ['--foo', '/etc/a/b', '1234'].sort());
  assert.deepEqual(ungrounded('a long-running job on Python 3.1', 'python 3.12 long running'), ['3.1']); // 3.1 is not 3.12; "long-running" is no option
  assert.deepEqual(ungrounded('Python 3.12 and /workspaces/x', 'python 3.12 at /workspaces/cell-001/source'), []);
});

test('model status for the pre-flight: reachable and present, reachable but missing, not reachable, switched off', async () => {
  const srv = http.createServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ models: [{ name: 'rca-writer:latest' }, { name: 'qwen3:4b' }] })); });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok())); const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    assert.deepEqual(await rcaModelStatus(url, 'rca-writer'), { enabled: true, reachable: true, present: true, name: 'rca-writer' });
    assert.equal((await rcaModelStatus(url, 'other-model')).present, false);
    assert.equal((await rcaModelStatus('http://127.0.0.1:1', 'rca-writer')).reachable, false);
    process.env.RCA_MODEL = 'off'; assert.equal((await rcaModelStatus(url, 'rca-writer')).enabled, false);
  } finally { delete process.env.RCA_MODEL; srv.close(); }
});
