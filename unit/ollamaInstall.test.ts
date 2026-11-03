import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureOllamaInstalled, findOllama, signedByOllama, INSTALLER_URL, MIN_FREE_GB, type Deps } from '../utils/ollamaInstall';

const LOCAL = 'C:\\Users\\t\\AppData\\Local';
const EXE = `${LOCAL}\\Programs\\Ollama\\ollama.exe`;

interface World { onPath?: boolean; atDefault?: boolean; winget?: boolean; wingetInstalls?: boolean; signed?: boolean; installerWorks?: boolean; free?: number; platform?: string; env?: Record<string, string> }
/** a fake PC: records every command, reacts like Windows would */
function fake(w: World) {
  const s = { onPath: !!w.onPath, atDefault: !!w.atDefault, downloaded: false };
  const calls: string[] = []; const said: string[] = [];
  const d: Deps = {
    platform: w.platform || 'win32', env: { LOCALAPPDATA: LOCAL, ...(w.env || {}) },
    run: (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'ollama') return { status: s.onPath ? 0 : null, out: '' };
      if (cmd.endsWith('ollama.exe')) return { status: s.atDefault ? 0 : null, out: '' };
      if (cmd === 'winget' && args[0] === '--version') return { status: w.winget ? 0 : null, out: 'v1' };
      if (cmd === 'winget') { if (w.wingetInstalls) { s.atDefault = true; return { status: 0, out: '' }; } return { status: 1, out: 'install failed' }; }
      if (cmd === 'powershell') return { status: 0, out: w.signed ? 'Valid|CN=Ollama Inc., O=Ollama Inc.' : 'NotSigned|' };
      if (cmd.endsWith('OllamaSetup.exe')) { s.atDefault = w.installerWorks !== false; return { status: 0, out: '' }; }
      return { status: null, out: '' };
    },
    exists: (p) => (p.endsWith('ollama.exe') ? s.atDefault && p === EXE : p.endsWith('OllamaSetup.exe') ? s.downloaded : false),
    freeGB: () => (w.free === undefined ? 100 : w.free),
    download: async (url) => { calls.push(`download ${url}`); s.downloaded = true; return true; },
    remove: () => { s.downloaded = false; },
  };
  return { d, calls, said, say: (m: string) => said.push(m) };
}
const ran = (calls: string[], what: string) => calls.some((c) => c.includes(what));

test('Ollama already on the PATH: used as it is, nothing is installed or downloaded', async () => {
  const f = fake({ onPath: true });
  assert.equal(await ensureOllamaInstalled(f.say, f.d), 'ollama');
  assert.equal(ran(f.calls, 'winget'), false); assert.equal(ran(f.calls, 'download'), false);
});

test('installed in the per-user folder but not on the PATH (a fresh install in an open terminal): found there and used', async () => {
  const f = fake({ atDefault: true });
  assert.equal(await ensureOllamaInstalled(f.say, f.d), EXE);
  assert.equal(f.d.env.EKS_OLLAMA, EXE); // later spawns use the full path
  assert.equal(ran(f.calls, 'winget'), false);
});

test('missing, winget works: installs Ollama.Ollama silently and does not download an installer', async () => {
  const f = fake({ winget: true, wingetInstalls: true });
  assert.equal(await ensureOllamaInstalled(f.say, f.d), EXE);
  const w = f.calls.find((c) => c.startsWith('winget install'))!;
  assert.match(w, /--id Ollama\.Ollama/); assert.match(w, /--silent/); assert.match(w, /--accept-package-agreements/);
  assert.equal(ran(f.calls, 'download'), false);
});

test('missing, no winget: downloads the official installer, checks the signature, then runs it silently', async () => {
  const f = fake({ winget: false, signed: true });
  assert.equal(await ensureOllamaInstalled(f.say, f.d), EXE);
  assert.ok(f.calls.includes(`download ${INSTALLER_URL}`));
  const iSig = f.calls.findIndex((c) => c.startsWith('powershell')); const iRun = f.calls.findIndex((c) => c.includes('OllamaSetup.exe /VERYSILENT'));
  assert.ok(iSig >= 0 && iRun > iSig, 'the signature is checked before the installer runs');
});

test('the installer is NOT signed by Ollama Inc.: it is never run and the message says so', async () => {
  const f = fake({ winget: false, signed: false });
  assert.equal(await ensureOllamaInstalled(f.say, f.d), null);
  assert.equal(ran(f.calls, 'OllamaSetup.exe /VERYSILENT'), false);
  assert.ok(f.said.some((m) => /NOT signed by Ollama Inc/.test(m)));
});

test('winget fails: falls back to the official installer', async () => {
  const f = fake({ winget: true, wingetInstalls: false, signed: true });
  assert.equal(await ensureOllamaInstalled(f.say, f.d), EXE);
  assert.ok(ran(f.calls, 'winget install')); assert.ok(f.calls.includes(`download ${INSTALLER_URL}`));
});

test('not enough free disk space: nothing is attempted and the message says how much is free', async () => {
  const f = fake({ free: 3.2 });
  assert.equal(await ensureOllamaInstalled(f.say, f.d), null);
  assert.equal(ran(f.calls, 'winget install'), false); assert.equal(ran(f.calls, 'download'), false);
  assert.ok(f.said.some((m) => m.includes('3.2 GB free') && m.includes(`${MIN_FREE_GB} GB`)));
});

test('OLLAMA_AUTO_INSTALL=off: nothing is installed, the message says what to do by hand', async () => {
  const f = fake({ env: { OLLAMA_AUTO_INSTALL: 'off' } });
  assert.equal(await ensureOllamaInstalled(f.say, f.d), null);
  assert.equal(ran(f.calls, 'winget'), false); assert.equal(ran(f.calls, 'download'), false);
  assert.ok(f.said.some((m) => /OLLAMA_AUTO_INSTALL=off/.test(m) && /ollama\.com\/download/.test(m)));
});

test('not Windows: no automatic installation, a manual instruction instead', async () => {
  const f = fake({ platform: 'linux' });
  assert.equal(await ensureOllamaInstalled(f.say, f.d), null);
  assert.equal(ran(f.calls, 'download'), false); assert.ok(f.said.some((m) => /Windows only/.test(m)));
});

test('signature check: only a Valid signature by Ollama Inc. passes', () => {
  const sig = (out: string): Deps => ({ ...fake({}).d, run: () => ({ status: 0, out }) });
  assert.equal(signedByOllama('x.exe', sig('Valid|CN=Ollama Inc.')), true);
  assert.equal(signedByOllama('x.exe', sig('Valid|CN="Ollama Inc.", O=Ollama Inc.')), true);
  assert.equal(signedByOllama('x.exe', sig('Valid|CN=Someone Else')), false);
  assert.equal(signedByOllama('x.exe', sig('HashMismatch|CN=Ollama Inc.')), false);
  assert.equal(signedByOllama('x.exe', sig('NotSigned|')), false);
});

test('findOllama prefers EKS_OLLAMA, then the PATH', () => {
  const f = fake({ onPath: true, env: { EKS_OLLAMA: 'D:\\tools\\ollama.exe' } });
  const real = f.d.run; f.d.run = (c, a, m) => (c === 'D:\\tools\\ollama.exe' ? { status: 0, out: '' } : real(c, a, m));
  assert.equal(findOllama(f.d), 'D:\\tools\\ollama.exe');
});
