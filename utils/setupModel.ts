import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import './env'; // loads .env
import { chromium } from '@playwright/test';
import { rcaModelEnabled } from './rcaWriter';

/**
 * One-command setup of everything the RCA Report needs on THIS PC, with a green tick for every part, then the run goes on.
 *   npm run model:setup     only the setup
 *   npm run go              the setup, then the whole test run (npm test)
 *   npm test                runs the setup first by itself (the "pretest" step), so nobody has to remember it
 * What it does (each part only acts when something is missing; when all is in place it takes a second or two):
 *   1 Ollama is installed          2 Ollama answers (started if it is not running)        3 the base model is pulled (ollama pull)
 *   4 the model "rca-writer" exists (ollama create -f rca-model/Modelfile)                  5 the browser for the PDFs is installed (Playwright Chromium)
 *   6 the model is loaded and answers a test question (so the first report is not slow)
 * It never stops the run: whatever fails is shown in yellow or red and the RCA Report then uses the rule-written text. Always exits with 0.
 * Switches (.env or the terminal): RCA_SETUP=off  skips this setup · RCA_MODEL=off  needs no model · RCA_SETUP_PULL=no  never downloads a model
 *   RCA_SETUP_INSTALL_OLLAMA=yes  installs Ollama itself when it is missing (Windows, winget); without it the script says how to install it.
 * Needs Ollama on the same PC. With OLLAMA_HOST pointing at another machine it only checks, it does not start, pull or create anything.
 */
export interface ExecResult { status: number | null; out: string }
export type Exec = (cmd: string, args: string[], opts?: { inherit?: boolean }) => ExecResult;
export interface Line { level: 'ok' | 'warn' | 'fail' | 'skip'; text: string }
export interface SetupOptions { host?: string; model?: string; modelfile?: string; exec?: Exec; print?: (l: Line) => void; env?: NodeJS.ProcessEnv; waitServerMs?: number; startServer?: () => void; browserInstalled?: () => boolean }

const G = '\u001b[32m', Y = '\u001b[33m', R = '\u001b[31m', D = '\u001b[2m', X = '\u001b[0m';
const MARK = { ok: `${G}✔${X}`, warn: `${Y}⚠${X}`, fail: `${R}✖${X}`, skip: `${D}–${X}` };
const defaultPrint = (l: Line) => console.log(`  ${MARK[l.level]} ${l.text}`);
const WIN = process.platform === 'win32';

export const realExec: Exec = (cmd, args, o = {}) => {
  // only the npm tools (npx.cmd) need a shell on Windows; ollama is run directly, so a path with spaces (F:\Tool Validation Automation) stays ONE argument
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: WIN && /^(npx|npm)$/i.test(cmd), stdio: o.inherit ? 'inherit' : 'pipe', timeout: 3 * 60 * 60_000, windowsHide: true });
  return { status: r.error ? null : r.status, out: r.error ? String(r.error.message) : `${r.stdout || ''}${r.stderr || ''}`.trim() };
};

function ollamaCommand(exec: Exec): string | null {
  const candidates = ['ollama'];
  if (WIN && process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'));
  if (process.platform === 'darwin') candidates.push('/usr/local/bin/ollama', '/opt/homebrew/bin/ollama');
  for (const c of candidates) { if (c !== 'ollama' && !fs.existsSync(c)) continue; if (exec(c, ['--version']).status === 0) return c; }
  return null;
}

async function tags(host: string): Promise<string[] | null> {
  try { const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(4000) }); if (!r.ok) return null; return (((await r.json()) as any).models || []).map((m: any) => String(m.name || '')); } catch { return null; }
}
const has = (names: string[], want: string) => names.some((n) => n === want || n === `${want}:latest`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function setupRcaModel(o: SetupOptions = {}): Promise<{ ready: boolean; lines: Line[] }> {
  const env = o.env || process.env; const exec = o.exec || realExec; const lines: Line[] = []; const say = (level: Line['level'], text: string) => { const l = { level, text }; lines.push(l); (o.print || defaultPrint)(l); };
  const host = (o.host || env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '').replace(/^(?!https?:\/\/)/, 'http://');
  const model = (o.model || env.RCA_MODEL_NAME || 'rca-writer').trim(); const remote = !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(host);
  const mf = o.modelfile || path.join(__dirname, '..', 'rca-model', 'Modelfile');
  if (/^(off|no|0|false)$/i.test((env.RCA_SETUP || '').trim())) { say('skip', 'RCA setup skipped (RCA_SETUP=off)'); return { ready: false, lines }; }
  if (!rcaModelEnabledIn(env)) { say('skip', 'RCA model is off (RCA_MODEL=off): the RCA Report uses the rule-written text'); return { ready: false, lines }; }

  // 1 Ollama installed (only needed on this PC)
  let cmd: string | null = null;
  if (!remote) {
    cmd = ollamaCommand(exec);
    if (!cmd && /^(1|yes|on|true)$/i.test((env.RCA_SETUP_INSTALL_OLLAMA || '').trim()) && WIN) { say('warn', 'Ollama is missing: installing it with winget ...'); exec('winget', ['install', '-e', '--id', 'Ollama.Ollama', '--silent', '--accept-package-agreements', '--accept-source-agreements'], { inherit: true }); cmd = ollamaCommand(exec); }
    if (!cmd) { say('fail', `Ollama is not installed. Install it from https://ollama.com/download (or set RCA_SETUP_INSTALL_OLLAMA=yes to let this script do it on Windows), then start again. The run goes on without the model.`); return { ready: false, lines }; }
    say('ok', `Ollama installed (${exec(cmd, ['--version']).out.replace(/\s+/g, ' ').slice(0, 60)})`);
  } else say('skip', `Ollama is on another machine (${host}): only checking it`);

  // 2 Ollama answers
  let names = await tags(host);
  if (!names && !remote && cmd) {
    (o.startServer || (() => { const c = spawn(cmd!, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }); c.on('error', () => { /* shown below as not answering */ }); c.unref(); }))();
    const until = Date.now() + (o.waitServerMs ?? 30_000); while (!names && Date.now() < until) { await sleep(500); names = await tags(host); }
  }
  if (!names) { say('fail', `Ollama does not answer at ${host}. Start it (ollama serve) and start again. The run goes on without the model.`); return { ready: false, lines }; }
  say('ok', `Ollama answers at ${host}`);

  // 3 base model, 4 the rca-writer model
  const base = (fs.existsSync(mf) ? /^FROM\s+(\S+)/im.exec(fs.readFileSync(mf, 'utf8'))?.[1] : '') || 'qwen3:4b'; const pull = !/^(no|off|0|false)$/i.test((env.RCA_SETUP_PULL || '').trim());
  if (has(names, model)) say('ok', `Model "${model}" is there`);
  else if (remote) { say('fail', `Model "${model}" does not exist on ${host}. Ask whoever runs it to create it (ollama create ${model} -f rca-model/Modelfile).`); return { ready: false, lines }; }
  else if (model !== 'rca-writer') { say('fail', `Model "${model}" does not exist. Create it first, or set RCA_MODEL_NAME=rca-writer.`); return { ready: false, lines }; }
  else {
    if (!has(names, base)) {
      if (!pull) { say('fail', `Base model "${base}" is missing and RCA_SETUP_PULL=no: run  ollama pull ${base}`); return { ready: false, lines }; }
      say('warn', `Base model "${base}" is missing: downloading it (about 2.5 GB, once; the time depends on your network) ...`);
      const r = exec(cmd!, ['pull', base], { inherit: true }); names = (await tags(host)) || names;
      if (r.status !== 0 || !has(names, base)) { say('fail', `Could not download "${base}". Check the network and run  ollama pull ${base}`); return { ready: false, lines }; }
    }
    say('ok', `Base model "${base}" is there`);
    if (!fs.existsSync(mf)) { say('fail', `rca-model/Modelfile is missing (${mf})`); return { ready: false, lines }; }
    const c = exec(cmd!, ['create', model, '-f', mf]); names = (await tags(host)) || names;
    if (c.status !== 0 || !has(names, model)) { say('fail', `Could not create "${model}": ${c.out.split(/\r?\n/).filter(Boolean).slice(-1)[0] || 'unknown error'}`); return { ready: false, lines }; }
    say('ok', `Model "${model}" created from rca-model/Modelfile`);
  }

  // 5 browser for the PDFs
  const installed = (o.browserInstalled || (() => { try { return fs.existsSync(chromium.executablePath()); } catch { return false; } }))();
  if (installed) say('ok', 'Browser for the PDF reports is installed');
  else { say('warn', 'Browser for the PDF reports is missing: installing Chromium ...'); const b = exec('npx', ['playwright', 'install', 'chromium'], { inherit: true }); (o.browserInstalled || (() => { try { return fs.existsSync(chromium.executablePath()); } catch { return false; } }))() && b.status === 0 ? say('ok', 'Chromium installed') : say('fail', 'Could not install Chromium: run  npx playwright install chromium'); }

  // 6 load the model and ask a test question
  const t0 = Date.now();
  try {
    const res = await fetch(`${host}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180_000), body: JSON.stringify({ model, stream: false, think: false, keep_alive: '30m', format: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }, options: { temperature: 0, num_predict: 20 }, messages: [{ role: 'user', content: 'Answer with JSON: {"ok": true}' }] }) });
    const j: any = await res.json().catch(() => ({})); if (!res.ok || !String(j?.message?.content || '').trim()) throw new Error(`HTTP ${res.status}`);
    say('ok', `Model loaded and answering (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) { say('fail', `The model did not answer a test question (${e instanceof Error ? e.message : e}). The RCA Report will use the rule-written text.`); return { ready: false, lines }; }
  return { ready: !lines.some((l) => l.level === 'fail'), lines };
}

const rcaModelEnabledIn = (env: NodeJS.ProcessEnv) => (env === process.env ? rcaModelEnabled() : !/^(off|no|0|false)$/i.test((env.RCA_MODEL || '').trim()));

if (require.main === module) {
  (async () => {
    console.log(`\n  ${D}RCA model setup${X}`);
    let r: { ready: boolean; lines: Line[] };
    try { r = await setupRcaModel(); } catch (e) { r = { ready: false, lines: [] }; console.log(`  ${MARK.fail} setup stopped: ${e instanceof Error ? e.message : e}`); }
    const hasFail = r.lines.some((l) => l.level === 'fail');
    console.log(r.ready ? `\n  ${G}✔ RCA model ready: starting the run${X}\n` : hasFail ? `\n  ${Y}⚠ RCA model not ready (see above): the run starts anyway and the RCA Report uses the rule-written text${X}\n` : `\n  ${D}RCA setup skipped: starting the run${X}\n`);
    process.exit(0); // never stops what comes next
  })();
}
