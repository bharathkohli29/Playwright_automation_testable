import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { setupRcaModel, realExec, Exec, Line } from '../utils/setupModel';

/** a fake Ollama: /api/tags lists `models` (the fake commands change it), /api/chat answers a test question */
async function fakeOllama(models: string[], chat = true) {
  const srv = http.createServer((req, res) => {
    req.resume().on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/tags') res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
      else res.end(JSON.stringify(chat ? { message: { content: '{"ok": true}' } } : { message: { content: '' } }));
    });
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok()));
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close() };
}
const modelfile = () => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-')), 'Modelfile'); fs.writeFileSync(f, 'FROM qwen3:4b\nPARAMETER temperature 0.1\n'); return f; };
const levels = (lines: Line[]) => lines.map((l) => l.level);
const fakeExec = (models: string[], calls: string[], opts: { installed?: boolean } = {}): Exec => (cmd, args) => {
  calls.push(args.join(' '));
  if (args[0] === '--version') return opts.installed === false ? { status: 1, out: 'not found' } : { status: 0, out: 'ollama version is 0.40.14' };
  if (args[0] === 'pull') { models.push(`${args[1]}:latest`); return { status: 0, out: '' }; }
  if (args[0] === 'create') { models.push(`${args[1]}:latest`); return { status: 0, out: '' }; }
  return { status: 0, out: '' };
};

test('everything in place: all green, nothing is downloaded or created', async () => {
  const models = ['qwen3:4b', 'rca-writer:latest']; const s = await fakeOllama(models); const calls: string[] = [];
  try { const r = await setupRcaModel({ host: s.url, modelfile: modelfile(), exec: fakeExec(models, calls), print: () => {}, env: {}, browserInstalled: () => true });
    assert.equal(r.ready, true); assert.ok(levels(r.lines).every((l) => l === 'ok')); assert.deepEqual(calls, ['--version', '--version']); // only the version check (once to find, once to print)
  } finally { s.close(); }
});

test('base model missing: it is pulled, rca-writer is created from the Modelfile, then the model answers', async () => {
  const models: string[] = []; const s = await fakeOllama(models); const calls: string[] = [];
  try { const r = await setupRcaModel({ host: s.url, modelfile: modelfile(), exec: fakeExec(models, calls), print: () => {}, env: {}, browserInstalled: () => true });
    assert.equal(r.ready, true); assert.ok(calls.some((c) => c === 'pull qwen3:4b')); assert.ok(calls.some((c) => c.startsWith('create rca-writer -f ')));
    assert.ok(calls.indexOf('pull qwen3:4b') < calls.findIndex((c) => c.startsWith('create '))); assert.ok(r.lines.some((l) => /created from rca-model\/Modelfile/.test(l.text)));
  } finally { s.close(); }
});

test('RCA_SETUP_PULL=no never downloads: it says what to run', async () => {
  const models: string[] = []; const s = await fakeOllama(models); const calls: string[] = [];
  try { const r = await setupRcaModel({ host: s.url, modelfile: modelfile(), exec: fakeExec(models, calls), print: () => {}, env: { RCA_SETUP_PULL: 'no' }, browserInstalled: () => true });
    assert.equal(r.ready, false); assert.ok(!calls.some((c) => c.startsWith('pull'))); assert.match(r.lines.at(-1)!.text, /ollama pull qwen3:4b/);
  } finally { s.close(); }
});

test('Ollama installed but not answering: it tries to start it, then says so and the run can go on', async () => {
  let started = 0; const r = await setupRcaModel({ host: 'http://127.0.0.1:1', modelfile: modelfile(), exec: fakeExec([], []), print: () => {}, env: {}, waitServerMs: 600, startServer: () => { started++; }, browserInstalled: () => true });
  assert.equal(started, 1); assert.equal(r.ready, false); assert.match(r.lines.at(-1)!.text, /does not answer/); assert.equal(r.lines.at(-1)!.level, 'fail');
});

test('Ollama not installed: it says how to install it and does nothing else', async () => {
  const calls: string[] = []; const r = await setupRcaModel({ host: 'http://127.0.0.1:1', modelfile: modelfile(), exec: fakeExec([], calls, { installed: false }), print: () => {}, env: {}, browserInstalled: () => true });
  assert.equal(r.ready, false); assert.match(r.lines.at(-1)!.text, /ollama\.com\/download/); assert.ok(!calls.some((c) => /pull|create|serve/.test(c)));
});

test('model answers nothing: reported as a failure, not as ready', async () => {
  const models = ['qwen3:4b', 'rca-writer:latest']; const s = await fakeOllama(models, false);
  try { const r = await setupRcaModel({ host: s.url, modelfile: modelfile(), exec: fakeExec(models, []), print: () => {}, env: {}, browserInstalled: () => true });
    assert.equal(r.ready, false); assert.match(r.lines.at(-1)!.text, /did not answer a test question/);
  } finally { s.close(); }
});

test('the off switches: RCA_SETUP=off and RCA_MODEL=off do nothing and touch nothing', async () => {
  for (const env of [{ RCA_SETUP: 'off' }, { RCA_MODEL: 'off' }]) { const calls: string[] = []; const r = await setupRcaModel({ host: 'http://127.0.0.1:1', exec: fakeExec([], calls), print: () => {}, env }); assert.equal(r.ready, false); assert.deepEqual(calls, []); assert.equal(r.lines[0].level, 'skip'); }
});

test('a model name other than rca-writer is never created by the script (it only checks)', async () => {
  const models = ['qwen3:4b']; const s = await fakeOllama(models); const calls: string[] = [];
  try { const r = await setupRcaModel({ host: s.url, model: 'rca-writer-v0', modelfile: modelfile(), exec: fakeExec(models, calls), print: () => {}, env: {}, browserInstalled: () => true });
    assert.equal(r.ready, false); assert.match(r.lines.at(-1)!.text, /does not exist/); assert.ok(!calls.some((c) => /^(pull|create)/.test(c)));
  } finally { s.close(); }
});

test('the command runner keeps an argument with spaces as ONE argument (a Modelfile path like F:/Tool Validation Automation/...)', () => {
  const r = realExec(process.execPath, ['-e', 'console.log(process.argv.length - 1 + "|" + process.argv[1])', 'F:/Tool Validation Automation/rca-model/Modelfile']);
  assert.equal(r.status, 0); assert.equal(r.out, '1|F:/Tool Validation Automation/rca-model/Modelfile');
});
