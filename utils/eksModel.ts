import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import { ensureOllama } from './eksAnalyze';
import { sessionFileRequest } from './sharepointSession';

/**
 * Makes the QA EKS Mentor model available on THIS PC, so the analysis works for everyone who pulls the script from git:   npm run model:setup
 * The weights (GGUF, ~1.9 GB) are not in git. qa-eks-mentor/model.json says which model is expected (name, version, sha256, file, url):
 *   1. Ollama installed and running (started by the script when it is down)
 *   2. the model <name> is registered with exactly those weights (Ollama names its blob sha256-<hash>, so the check is a string compare)
 *   3. when it is not: the GGUF is looked for in EKS_MODEL_FILE, qa-eks-mentor/models/, qa-eks-mentor/<file>, then downloaded from EKS_MODEL_URL (or "url" of model.json)
 *      into qa-eks-mentor/models/, its sha256 is checked, and `ollama create` registers it from qa-eks-mentor/Modelfile
 * The first successful run per PC does the download/registration; after that this is only a quick check. Never throws: without the model the
 * reports are written from the rules and the log lines (no model text), and the log says why.
 */
const DIR = path.join(__dirname, '..', 'qa-eks-mentor');
const OLLAMA = () => (process.env.EKS_OLLAMA || 'ollama').trim().replace(/^["']|["']$/g, '');
interface Manifest { name: string; version: string; sha256: string; file: string; url: string }

const readManifest = (): Manifest | null => { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'model.json'), 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const ollama = (args: string[], ms = 60_000) => spawnSync(OLLAMA(), args, { encoding: 'utf8', shell: process.platform === 'win32', timeout: ms, windowsHide: true });

function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => { const h = crypto.createHash('sha256'); fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject); });
}
/** sha256 of the weights the registered model uses, or '' when it is not registered */
function registeredSha(name: string): string {
  const r = ollama(['show', name, '--modelfile'], 30_000);
  return /^FROM .*sha256-([0-9a-f]{64})/m.exec(r.stdout || '')?.[1] || '';
}
async function download(url: string, to: string, say: (m: string) => void): Promise<boolean> {
  // "sharepoint:<path under the evidence folder>" = the team SharePoint folder, read with the saved sign-in (npm run sp:login); anything else is a plain https address
  let headers: Record<string, string> = {};
  if (/^sharepoint:/i.test(url)) {
    try { const r = sessionFileRequest(url.replace(/^sharepoint:/i, '').split('/').filter(Boolean)); url = r.url; headers = r.headers; }
    catch (e) { say(`${e instanceof Error ? e.message : e}`); return false; }
  }
  const res = await fetch(url, { headers, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) { say('SharePoint sign-in expired: run  npm run sp:login  and try again'); return false; }
  if (!res.ok || !res.body) { say(`download failed: HTTP ${res.status}${res.status === 404 ? ' (the file is not in the SharePoint folder yet)' : ''}`); return false; }
  const total = Number(res.headers.get('content-length')) || 0; let got = 0, shown = 0;
  const out = fs.createWriteStream(to);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    got += value.length; if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
    if (total && got - shown > total / 10) { shown = got; say(`downloading the model ... ${Math.round((got / total) * 100)}%`); }
  }
  await new Promise<void>((r) => out.end(r)); return true;
}

let done: Promise<boolean> | null = null;
/** true when the model is ready (registered with the expected weights). Runs once per process. */
export function ensureEksModel(say: (m: string) => void = (m) => console.log(`  QA EKS model: ${m}`)): Promise<boolean> {
  return (done ||= (async () => {
    try {
      const m = readManifest(); if (!m) { say('qa-eks-mentor/model.json is missing, model not checked'); return false; }
      if (ollama(['--version'], 20_000).status !== 0) { say('Ollama is not installed on this PC. Install it from https://ollama.com/download , then run: npm run model:setup'); return false; }
      if (!(await ensureOllama(say))) return false;
      if (registeredSha(m.name) === m.sha256) return true;
      say(`model ${m.name} (version ${m.version}) is not registered on this PC, setting it up ...`);
      const modelsDir = path.join(DIR, 'models'); fs.mkdirSync(modelsDir, { recursive: true });
      const candidates = [process.env.EKS_MODEL_FILE, path.join(modelsDir, m.file), path.join(DIR, m.file)].filter((p): p is string => !!p && fs.existsSync(p));
      let gguf = '';
      for (const c of candidates) { if ((await sha256File(c)) === m.sha256) { gguf = c; break; } say(`${c} is not the expected version (sha256 differs), skipped`); }
      if (!gguf) {
        const url = (process.env.EKS_MODEL_URL || m.url || '').trim();
        if (!url) { say(`the model file ${m.file} was not found and no download address is set: put the file in qa-eks-mentor/models/ , or set EKS_MODEL_FILE / EKS_MODEL_URL in .env (ask the QA lead where the model file is kept)`); return false; }
        const target = path.join(modelsDir, m.file);
        say(`downloading ${m.file} ...`);
        if (!(await download(url, target, say))) return false;
        if ((await sha256File(target)) !== m.sha256) { fs.rmSync(target, { force: true }); say('the downloaded file does not match the expected sha256, deleted; the model was not registered'); return false; }
        gguf = target;
      }
      const mf = fs.readFileSync(path.join(DIR, 'Modelfile'), 'utf8').replace(/^FROM .*$/m, () => `FROM ${gguf}`);
      const tmp = path.join(os.tmpdir(), `qa-eks-mentor-${process.pid}.Modelfile`); fs.writeFileSync(tmp, mf);
      const r = ollama(['create', m.name, '-f', tmp], 10 * 60_000); fs.rmSync(tmp, { force: true });
      if (r.status !== 0) { say(`ollama create failed: ${(r.stderr || r.stdout || '').trim().slice(-200)}`); return false; }
      say(`model ${m.name} is ready`); return registeredSha(m.name) === m.sha256;
    } catch (e) { say(`model setup stopped: ${e instanceof Error ? e.message : e}`); return false; }
  })());
}

if (require.main === module) {
  ensureEksModel().then((ok) => { console.log(ok ? '\nThe QA EKS model is ready on this PC.' : '\nThe model is NOT ready (see above). The script still runs; reports use rule-based text until it is.'); process.exit(ok ? 0 : 1); });
}
