import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

/**
 * Ollama on THIS PC: use it when it is there, install it when it is not (Windows), so a teammate who pulls the script needs no manual step.
 *   1. found (EKS_OLLAMA, the PATH, or the per-user install folder): used as it is, nothing is downloaded
 *   2. missing: winget (winget install --id Ollama.Ollama, the package is checked by winget), else the official installer
 *      https://ollama.com/download/OllamaSetup.exe, which is run only when it is signed by "Ollama Inc."
 *      Both install per user: no administrator rights. The installer is about 1.6 GB, so the script first checks the free disk space.
 * OLLAMA_AUTO_INSTALL=off turns the installation off (a clear message says what to do by hand). Not used with a shared host (OLLAMA_HOST).
 * Never throws; returns the command to run Ollama with, or null.
 */
export const INSTALLER_URL = 'https://ollama.com/download/OllamaSetup.exe';
export const MIN_FREE_GB = 8; // installer download + installed files, with some room

export interface Deps {
  platform: string;
  env: NodeJS.ProcessEnv;
  run(cmd: string, args: string[], ms: number): { status: number | null; out: string };
  exists(p: string): boolean;
  freeGB(dir: string): number;
  download(url: string, to: string, say: (m: string) => void): Promise<boolean>;
  remove(p: string): void;
}

const clean = (s?: string) => (s || '').trim().replace(/^["']|["']$/g, '');

export const defaultDeps: Deps = {
  platform: process.platform,
  env: process.env,
  run: (cmd, args, ms) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: ms, windowsHide: true }); return { status: r.error ? null : r.status, out: `${r.stdout || ''}${r.stderr || ''}` }; },
  exists: (p) => fs.existsSync(p),
  freeGB: (dir) => { try { const s = fs.statfsSync(dir); return (s.bavail * s.bsize) / 1e9; } catch { return Infinity; } },
  remove: (p) => { try { fs.rmSync(p, { force: true }); } catch { /* ignore */ } },
  download: async (url, to, say) => {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) { say(`download failed: HTTP ${res.status}`); return false; }
    const total = Number(res.headers.get('content-length')) || 0; let got = 0; let shown = 0;
    const out = fs.createWriteStream(to); const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      got += value.length; if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      if (total && got - shown > total / 10) { shown = got; say(`downloading the Ollama installer ... ${Math.round((got / total) * 100)}%`); }
    }
    await new Promise<void>((r) => out.end(r)); return true;
  },
};

/** the command that runs Ollama on this PC, or null: EKS_OLLAMA, then the PATH, then the per-user and the all-users install folders */
export function findOllama(d: Deps = defaultDeps): string | null {
  const works = (cmd: string) => d.run(cmd, ['--version'], 20_000).status === 0;
  const fromEnv = clean(d.env.EKS_OLLAMA); if (fromEnv && works(fromEnv)) return fromEnv;
  if (works('ollama')) return 'ollama';
  const candidates = [path.join(d.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'), 'C:\\Program Files\\Ollama\\ollama.exe'];
  for (const c of candidates) if (d.exists(c) && works(c)) return c;
  return null;
}

/** true when the file is signed by Ollama Inc. (Authenticode status Valid) */
export function signedByOllama(file: string, d: Deps = defaultDeps): boolean {
  const ps = "$s = Get-AuthenticodeSignature -LiteralPath '" + file.replace(/'/g, "''") + "'; $s.Status.ToString() + '|' + $s.SignerCertificate.Subject";
  const r = d.run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], 60_000);
  return r.status === 0 && /^Valid\|/.test(r.out.trim()) && /CN="?Ollama Inc/i.test(r.out);
}

export async function ensureOllamaInstalled(say: (m: string) => void, d: Deps = defaultDeps): Promise<string | null> {
  try {
    const found = findOllama(d);
    if (found) { if (found !== 'ollama') d.env.EKS_OLLAMA = found; return found; }
    const manual = 'install it by hand from https://ollama.com/download (about 1.6 GB), then run: npm run model:setup';
    if (/^(off|no|0|false)$/i.test(clean(d.env.OLLAMA_AUTO_INSTALL))) { say(`Ollama is not installed on this PC and OLLAMA_AUTO_INSTALL=off: ${manual}`); return null; }
    if (d.platform !== 'win32') { say(`Ollama is not installed on this PC (automatic installation is for Windows only): ${manual}`); return null; }
    const dir = d.env.LOCALAPPDATA || os.tmpdir(); const free = d.freeGB(dir);
    if (free < MIN_FREE_GB) { say(`Ollama is not installed and the drive of ${dir} has only ${free.toFixed(1)} GB free (about ${MIN_FREE_GB} GB are needed for the installer and Ollama): free some space, or ${manual}`); return null; }
    say('Ollama is not installed on this PC, installing it now (official package, per user, no administrator rights, a few minutes) ...');
    const after = (how: string) => { const f = findOllama(d); if (f) { if (f !== 'ollama') d.env.EKS_OLLAMA = f; say(`Ollama installed (${how})`); return f; } return null; };
    if (d.run('winget', ['--version'], 20_000).status === 0) {
      const r = d.run('winget', ['install', '--id', 'Ollama.Ollama', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'], 20 * 60_000);
      const f = r.status === 0 ? after('winget') : null; if (f) return f;
      say(`winget could not install it (${r.out.trim().split('\n').pop()?.slice(0, 120) || 'no message'}); trying the official installer`);
    }
    const file = path.join(os.tmpdir(), 'OllamaSetup.exe'); d.remove(file);
    if (!(await d.download(INSTALLER_URL, file, say))) { d.remove(file); say(`the installer could not be downloaded: ${manual}`); return null; }
    if (!signedByOllama(file, d)) { d.remove(file); say(`the downloaded installer is NOT signed by Ollama Inc., so it was not run and was deleted: ${manual}`); return null; }
    say('installer verified (signed by Ollama Inc.), running it silently ...');
    const r = d.run(file, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES'], 20 * 60_000); d.remove(file);
    const f = r.status === 0 ? after('official installer') : null; if (f) return f;
    say(`the installer finished without Ollama being found (exit ${r.status}): ${manual}`); return null;
  } catch (e) { say(`Ollama installation stopped: ${e instanceof Error ? e.message : e}`); return null; }
}
