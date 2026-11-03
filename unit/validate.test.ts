import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocalReader, languageFromName } from '../utils/validateFolder';

const BASE = 'cells/cell-001/qa/cell-001/local/local/local/local/B1/local/run/';
const mkTree = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'val-'));
  fs.mkdirSync(path.join(root, 'lizard', 'id1', '0'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lizard', 'id1', '0', 'lizard.json'), '{"summary":{"files":3}}');
  fs.mkdirSync(path.join(root, 'radon', 'id2', '0'), { recursive: true });
  fs.writeFileSync(path.join(root, 'radon', 'id2', '0', 'radon_cc.json'), '[]');
  fs.writeFileSync(path.join(root, 'radon', 'id2', '0', 'radon_mi.json'), '{}');
  return root;
};

test('LocalReader lists tool folders like S3 does: keys are base + path, folders end with a slash', async () => {
  const r = new LocalReader(mkTree(), BASE);
  const top = await r.list(BASE);
  assert.deepEqual(top.folders.sort(), [`${BASE}lizard/`, `${BASE}radon/`]);
  assert.deepEqual(top.files, []);
  assert.deepEqual((await r.list(`${BASE}radon/id2/0/`)).files.sort(), [`${BASE}radon/id2/0/radon_cc.json`, `${BASE}radon/id2/0/radon_mi.json`]);
});

test('LocalReader walk finds every file below a tool folder, and a missing folder does not exist', async () => {
  const r = new LocalReader(mkTree(), BASE);
  const w = await r.walk(`${BASE}radon/`);
  assert.equal(w.exists, true); assert.equal(w.files.length, 2);
  assert.equal((await r.walk(`${BASE}nope/`)).exists, false);
});

test('LocalReader reads text, bytes and the head of a file', async () => {
  const r = new LocalReader(mkTree(), BASE); const key = `${BASE}lizard/id1/0/lizard.json`;
  assert.equal(await r.readText(key), '{"summary":{"files":3}}');
  assert.equal(Buffer.from(await r.readBytes(key)).toString('utf8'), '{"summary":{"files":3}}');
  assert.equal(await r.readHead(key, 9), '{"summary');
});

test('the language and version come from the branch folder name', () => {
  assert.equal(languageFromName('PY_V36_UV_UV_MONO'), 'python, 3.6');
  assert.equal(languageFromName('PY_V312_SETUPTOOLS_PIP_MICRO'), 'python, 3.12');
  assert.equal(languageFromName('JV_V17_MAVEN_THINJAR_MICRO'), 'java, 17');
  assert.equal(languageFromName('TS_V20_VITE_NPM_MICRO'), 'typescript, Node 20');
  assert.equal(languageFromName('JS_V18_X'), 'javascript, Node 18');
  assert.equal(languageFromName('something-else'), '');
});
