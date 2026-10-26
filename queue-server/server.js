// Branch queue + live output page for the team. Plain Node (no packages). Start: npm run queue   (then open http://localhost:3000)
// - everyone adds GitHub branch links with their name (the web page is add-only and read-only otherwise)
// - the OWNER controls everything from this terminal in VS Code: type  start | pause | stop | clear | list | remove <id> | status | help
// - the run is the normal "npm test" flow, started by this terminal, one round at a time; its output shows here AND on the /output page
// - a round = ONE branch from each person who is waiting (the person served longest ago goes first), so nobody waits behind a long list
// - /output shows the terminal output live; secrets from .env are masked
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');
const PORT = Number(process.env.QUEUE_PORT || 3000);
const ROUND_MAX = Number(process.env.QUEUE_ROUND_MAX || 10);       // most persons served in one round
const RUN_CMD = process.env.QUEUE_CMD || 'npm test';              // what runs a round (the branch list is passed in BRANCHES)
const LINK = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/tree\/(\S+?)\/?$/i;
fs.mkdirSync(path.join(DATA, 'logs'), { recursive: true });

// ---------- ingest token (lets a run started from the VS Code Test Explorer send its log lines to /output; only a program on this PC can read the token file) ----------
const TOKEN = require('crypto').randomBytes(16).toString('hex');
try { fs.writeFileSync(path.join(DATA, 'ingest.json'), JSON.stringify({ port: PORT, token: TOKEN })); } catch { /* ignore */ }
let lastIngest = 0;
let lastLineAt = Date.now(); // when the last output line arrived (for the stuck-run watchdog)

// ---------- state ----------
const stateFile = path.join(DATA, 'queue.json');
let S = { seq: 0, round: 0, paused: false, items: [], lastServed: {} };
try { S = Object.assign(S, JSON.parse(fs.readFileSync(stateFile, 'utf8'))); } catch { /* first start */ }
S.items.forEach((i) => { if (i.status === 'running') i.status = 'waiting'; }); // a server restart ended any running round
S.paused = true; // the queue is HELD at every start: nothing runs until the owner types  start  in this terminal
// write a file in one piece: a reader (the flow loads builds.json whenever a test worker starts) never sees half a file
function writeAtomic(file, text) {
  const tmp = `${file}.tmp${process.pid}`;
  fs.writeFileSync(tmp, text);
  try { fs.renameSync(tmp, file); } catch { fs.writeFileSync(file, text); try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}
// builds.json mirrors the queue (running first, then waiting in the fair order), so it shows in VS Code. The flow itself gets the list from BRANCHES, so this file is for looking at.
const buildsFile = path.join(ROOT, 'builds.json');
function fairOrder() {
  const served = { ...S.lastServed };
  let left = S.items.filter((i) => i.status === 'waiting').slice();
  const out = [];
  while (left.length) {
    const by = new Map();
    for (const i of left) { if (!by.has(i.person)) by.set(i.person, []); by.get(i.person).push(i); }
    const persons = [...by.keys()].sort((x, y) => (served[x] || 0) - (served[y] || 0) || by.get(x)[0].id - by.get(y)[0].id);
    persons.forEach((p, k) => { out.push(by.get(p)[0]); served[p] = 1e9 + k; });
    left = left.filter((i) => !out.includes(i));
  }
  return out;
}
function syncBuilds() {
  try {
    const bak = path.join(DATA, 'builds.original.json');
    if (!fs.existsSync(bak) && fs.existsSync(buildsFile)) fs.copyFileSync(buildsFile, bak); // your own list is kept once
    const list = [...S.items.filter((i) => i.status === 'running'), ...fairOrder()];
    writeAtomic(buildsFile, JSON.stringify({ branches: list.map((i) => i.url), queue: list.map((i) => `${i.person}: ${i.branch} (${i.status})`) }, null, 2) + '\n');
  } catch { /* ignore */ }
}
const save = () => { try { writeAtomic(stateFile, JSON.stringify(S, null, 2)); } catch { /* ignore */ } syncBuilds(); };
if (S.items.some((i) => i.status === 'waiting')) syncBuilds(); // show the waiting branches in builds.json right at start
let cur = null; // { child, runDir, ids, started, logFile }
let lines = []; // output lines of the current/last round (kept in memory + file)
const clients = new Set();

function envValue(key) {
  try {
    for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = new RegExp('^\\s*' + key + '\\s*=\\s*(.+?)\\s*$').exec(l);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env */ }
  return '';
}

// ---------- access code (set QUEUE_CODE=... in .env; needed before you share the page outside the office network) ----------
function accessCode() {
  if (process.env.QUEUE_CODE) return process.env.QUEUE_CODE;
  try {
    for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*QUEUE_CODE\s*=\s*(.+?)\s*$/.exec(l);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env */ }
  return '';
}
const cookieOf = (req) => { const m = /(?:^|;\s*)qc=([^;]*)/.exec(req.headers.cookie || ''); return m ? decodeURIComponent(m[1]) : ''; };
const LOGIN_PAGE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Branch queue</title><style>body{font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f6f5f1}form{background:#fff;padding:24px;border-radius:12px;border:1px solid #e3e1da;display:grid;gap:10px;width:300px}input,button{padding:10px;font:inherit;border-radius:8px;border:1px solid #ccc}button{background:#1f5eff;color:#fff;border:0}#e{color:#c0392b;font-size:14px}</style><form onsubmit="go(event)"><b>Branch queue</b><span>Enter the team access code</span><input id="c" type="password" autofocus><button>Open</button><span id="e"></span></form><script>async function go(e){e.preventDefault();const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:document.getElementById("c").value})});if(r.ok)location.reload();else document.getElementById("e").textContent="Wrong code"}</script>';

// ---------- secrets masking ----------
function secrets() {
  const out = [];
  try {
    for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|WEBHOOK|QUEUE_CODE)[A-Z0-9_]*)\s*=\s*(.+?)\s*$/i.exec(l);
      if (m) { const v = m[3].replace(/^["']|["']$/g, ''); if (v.length >= 6) out.push(v); }
    }
  } catch { /* no .env */ }
  return out;
}
const mask = (t) => { let s = t; for (const v of secrets()) s = s.split(v).join('••••'); return s; };
const strip = (t) => t.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r(?!\n)/g, '\n');

// ---------- Teams (only for a round that stopped BEFORE a branch could start, e.g. the site is down at login; normal branch results are sent by the flow itself) ----------
function webhook() {
  try {
    for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*TEAMS_WEBHOOK_URL\s*=\s*(.+?)\s*$/.exec(l);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env */ }
  return '';
}
async function teamsNoStart(items, code) {
  const url = webhook();
  if (!url || !items.length) return;
  const reason = (lines.find((l) => /TimeoutError|Error:|BLOCKED|ENVIRONMENT/.test(l)) || `the run ended with exit code ${code} before the branch started`).slice(0, 300);
  const body = [
    { type: 'TextBlock', text: `❌ ${items.length > 1 ? 'Branches' : 'Branch'} ${items.map((i) => i.branch).join(', ')} did not start`, weight: 'Bolder', wrap: true, color: 'Attention' },
    { type: 'TextBlock', text: `Added by ${[...new Set(items.map((i) => i.person))].join(', ')} · round ${S.round}`, isSubtle: true, wrap: true, spacing: 'Small' },
    { type: 'TextBlock', text: `Why: the run stopped before the branch (usually the login or the site is down). ${reason}`, wrap: true },
  ];
  const payload = { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body } }] };
  for (const wait of [0, 4000, 10000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) }); if (r.ok) { emit('Teams: "did not start" message sent'); return; } } catch { /* retry */ }
  }
  emit('Teams: "did not start" message could not be sent');
}

// ---------- output ----------
function emit(text) {
  if (!text) return;
  for (const raw of strip(mask(text)).split('\n')) {
    if (raw === '') continue;
    lines.push(raw); if (lines.length > 6000) lines.shift();
    lastLineAt = Date.now();
    try { process.stdout.write(raw + '\n'); } catch { /* ignore */ } // same text in the terminal that runs the queue
    if (cur) try { fs.appendFileSync(cur.logFile, raw + '\n'); } catch { /* ignore */ }
    for (const c of clients) c.write(`data: ${JSON.stringify(raw)}\n\n`);
  }
}
const ping = () => { for (const c of clients) c.write(`event: state\ndata: ${JSON.stringify(view())}\n\n`); };

// ---------- queue logic ----------
function pickRound() {
  const waiting = S.items.filter((i) => i.status === 'waiting');
  const by = new Map();
  for (const i of waiting) { if (!by.has(i.person)) by.set(i.person, []); by.get(i.person).push(i); }
  const persons = [...by.keys()].sort((a, b) => (S.lastServed[a] || 0) - (S.lastServed[b] || 0) || by.get(a)[0].id - by.get(b)[0].id);
  return persons.slice(0, ROUND_MAX).map((p) => by.get(p)[0]);
}

function readSummary(runDir) {
  try { return JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8')); } catch { return []; }
}

function applySummary() {
  if (!cur) return;
  const sum = readSummary(cur.runDir);
  for (const id of cur.ids) {
    const it = S.items.find((x) => x.id === id);
    const r = sum.find((x) => x.branch === it.branch);
    if (r && it.status === 'running') { it.status = r.status; it.minutes = r.minutes; it.note = r.note || ''; it.finished = new Date().toISOString(); }
  }
}

function startRound() {
  if (cur || S.paused) return;
  const round = pickRound();
  if (!round.length) return;
  S.round += 1;
  // same folder name as a run started by hand: results/merge-flow_<date>_<hhmm>  (merge-flow_dev_... for DEV). One round = one login, all its branches, one logout.
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
  const testEnv = (process.env.TEST_ENV || envValue('TEST_ENV') || 'qa').toLowerCase();
  let runDir = path.join(ROOT, 'results', `merge-flow_${testEnv === 'dev' ? 'dev_' : ''}${stamp}`);
  for (let n = 2; fs.existsSync(runDir); n++) runDir = path.join(ROOT, 'results', `merge-flow_${testEnv === 'dev' ? 'dev_' : ''}${stamp}_${n}`); // only if a second round starts in the same minute
  const logFile = path.join(DATA, 'logs', `round-${S.round}-${stamp}.log`);
  for (const i of round) { i.status = 'running'; i.round = S.round; i.started = new Date().toISOString(); S.lastServed[i.person] = S.round; }
  save();
  lines = [];
  cur = { runDir, ids: round.map((i) => i.id), started: Date.now(), logFile };
  emit(`=== Round ${S.round}: ${round.map((i) => `${i.person}: ${i.branch}`).join(' | ')} ===`);
  const env = { ...process.env, BRANCHES: round.map((i) => i.url).join(','), RUN_DIR: runDir, QUEUE_ROUND: '1' };
  const child = spawn(RUN_CMD, { cwd: ROOT, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  cur.child = child;
  child.stdout.on('data', (d) => emit(d.toString()));
  child.stderr.on('data', (d) => emit(d.toString()));
  child.on('error', (e) => emit(`!! could not start the run: ${e.message}`));
  const poll = setInterval(() => { applySummary(); save(); ping(); }, 5000);
  child.on('close', (code) => {
    clearInterval(poll);
    applySummary();
    const noStart = [];
    for (const id of cur.ids) { const it = S.items.find((x) => x.id === id); if (it.status === 'running') { noStart.push(it); it.status = cur.stopped ? 'stopped' : 'failed'; it.note = it.note || (cur.stopped ? 'stopped from the PC' : `no result written (exit code ${code})`); it.finished = new Date().toISOString(); } }
    emit(`=== Round ${S.round} finished (exit code ${code}) ===`);
    if (code !== 0 && !cur.stopped) { // crashed / failed: say why, from the last error lines of the output
      const errs = lines.filter((l) => /Error|Timeout|failed|ECONN|ENOTFOUND|expired|Expired|denied|crash|closed|Target page|browser has been closed/i.test(l)).slice(-3).map((l) => l.trim().slice(0, 200));
      emit(`⚠ The run ended with exit code ${code}.${errs.length ? ' Last problems printed:' : ' Nothing error-like was printed — check the browser window / VS Code Test Results.'}`);
      errs.forEach((e) => emit(`   • ${e}`));
      if (lines.some((l) => /ExpiredToken|AWS keys/i.test(l))) emit('   Most likely cause: the AWS keys in .env expired — copy fresh keys and rerun.');
      else if (lines.some((l) => /Timeout.*Email or username|auth\.setup|log in/i.test(l))) emit('   Most likely cause: the login page did not load (QA site down or slow).');
      else if (lines.some((l) => /browser has been closed|Target page.*closed/i.test(l))) emit('   Most likely cause: the browser window was closed or crashed during the run.');
    }
    const wasStopped = cur.stopped;
    cur = null; save(); ping();
    if (noStart.length && !wasStopped) teamsNoStart(noStart, code).catch(() => {});
    setTimeout(startRound, 3000); // next round
  });
  ping();
}

// ---------- runs started outside the queue (VS Code Test Explorer) + stuck-run watchdog ----------
const RESULTS = path.join(ROOT, 'results');
const STUCK_MIN = Number(process.env.QUEUE_STUCK_MIN || 8); // minutes without any output / new file before the terminal explains what the run is waiting for
function newestRunDir() {
  try {
    const ds = fs.readdirSync(RESULTS).filter((d) => /^merge-flow_/.test(d)).map((d) => ({ d, t: fs.statSync(path.join(RESULTS, d)).mtimeMs })).sort((a, b) => b.t - a.t);
    return ds.length ? path.join(RESULTS, ds[0].d) : null;
  } catch { return null; }
}
/** newest file change inside a run folder (two levels deep) */
function lastFileChange(dir) {
  let best = { t: 0, f: '' };
  const walk = (d, depth) => {
    let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(d, e.name);
      let st; try { st = fs.statSync(f); } catch { continue; }
      if (st.mtimeMs > best.t) best = { t: st.mtimeMs, f: path.relative(dir, f) };
      if (e.isDirectory() && depth < 2 && e.name !== 's3-evidence' && e.name !== 'gates') walk(f, depth + 1);
    }
  };
  walk(dir, 0);
  return best;
}
/** A run started in the Test Explorer writes its results into results/merge-flow_…; follow it so the queue shows the real status. */
function watchExternal() {
  if (cur) return;
  const dir = newestRunDir(); if (!dir) return;
  const sum = readSummary(dir);
  let changed = false;
  for (const it of S.items) {
    if (it.status !== 'waiting' && it.status !== 'running') continue;
    const r = sum.slice().reverse().find((x) => x.branch === it.branch); // the latest result of this branch
    const bdir = path.join(dir, it.branch);
    let bt = 0; try { bt = fs.statSync(path.join(bdir, 'run-details.json')).mtimeMs; } catch { /* not there: a blocked / failed branch never gets a run-details.json */ }
    let st = 0; try { st = fs.statSync(path.join(dir, 'summary.json')).mtimeMs; } catch { /* no summary yet */ }
    const addedAt = Date.parse(it.addedAt || '') || 0;
    if (r && (bt > addedAt || st > addedAt)) { it.status = r.status; it.minutes = r.minutes; it.note = r.note || ''; it.finished = new Date().toISOString(); changed = true; emit(`Queue: ${it.person}'s ${it.branch} finished in the Test Explorer run → ${r.status}${r.minutes ? ` (${r.minutes} min)` : ''}`); }
    else if (!r && bt > addedAt && Date.now() - lastFileChange(bdir).t < 15 * 60 * 1000 && it.status === 'waiting') { it.status = 'running'; it.started = it.started || new Date().toISOString(); changed = true; }
  }
  if (changed) { save(); ping(); }
}
let warnedFor = 0;
/** Prints WHY a run seems stuck (nothing printed and no new file for STUCK_MIN minutes) with the most likely cause. */
function watchdog() {
  const external = lastIngest && Date.now() - lastIngest < 90 * 60 * 1000;
  if (!cur && !external) return;
  const dir = cur ? cur.runDir : newestRunDir(); if (!dir || !fs.existsSync(dir)) return;
  const fc = lastFileChange(dir);
  const lastOut = Math.max(lastLineAt, fc.t);
  const idle = Date.now() - lastOut;
  if (idle < STUCK_MIN * 60 * 1000) { warnedFor = 0; return; }
  if (Date.now() - warnedFor < 10 * 60 * 1000) return; // repeat at most every 10 minutes
  warnedFor = Date.now();
  const mins = Math.round(idle / 60000); const keepAt = lastLineAt;
  // newest branch folder → what step it reached
  let step = 'no branch folder yet (login / starting the first branch)'; let cause = 'The site may be slow or down, or the login is waiting. Check the browser window.';
  try {
    const bs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'run-details.json')) || (e.isDirectory() && !['evidence', 'gates'].includes(e.name) && fs.existsSync(path.join(dir, e.name)) && fs.readdirSync(path.join(dir, e.name)).length))
      .map((e) => ({ n: e.name, t: lastFileChange(path.join(dir, e.name)).t })).sort((a, b) => b.t - a.t);
    if (bs.length) {
      const b = path.join(dir, bs[0].n); const has = (f) => fs.existsSync(path.join(b, f));
      const keyAge = (() => { try { return Math.round((Date.now() - fs.statSync(path.join(ROOT, '.env')).mtimeMs) / 60000); } catch { return null; } })();
      const keyNote = keyAge !== null ? ` The AWS keys in .env were saved ${keyAge} min ago${keyAge >= 55 ? ' — they last about 60 min, so they have most likely EXPIRED' : ''}.` : '';
      if (has('s3-folders.json') && !has('s3-files.json')) { step = `${bs[0].n}: S3 evidence — folders listed, now reading the files`; cause = `Stuck while reading S3 files.${keyNote} Fix: put fresh AWS keys in .env, stop the run, run only the "S3 evidence" test.`; }
      else if (has('run-details.json') && !has('s3-folders.json')) { step = `${bs[0].n}: site run finished, S3 evidence starting`; cause = `Waiting for S3 (listing the run folder).${keyNote}`; }
      else if (has('s3-files.json') && !has('s3-check.json')) { step = `${bs[0].n}: S3 evidence — checking tool folders`; cause = `Reading the tool files from S3.${keyNote}`; }
      else if (has('s3-check.json')) { step = `${bs[0].n}: S3 check done`; cause = 'This branch is complete; the run may be waiting for the Teams message, the SharePoint copy, or the next branch to start.'; }
      else { step = `${bs[0].n}: site run (waiting for the Confidence Engine run to finish)`; cause = 'A QA run can take up to 35 minutes. If the site page shows an error or never moves, the QA site may be down.'; }
    }
  } catch { /* ignore */ }
  const lastLine = [...lines].reverse().find((l) => l.trim()) || '(nothing printed yet)';
  emit(`⚠ NO PROGRESS for ${mins} min — ${step}`);
  emit(`   Last file written: ${fc.f || '(none)'} at ${fc.t ? new Date(fc.t).toLocaleTimeString() : '-'}`);
  emit(`   Last output line: ${lastLine.slice(0, 160)}`);
  emit(`   Most likely cause: ${cause}`);
  lastLineAt = keepAt; // the warning itself is not progress
}
setInterval(() => { try { watchExternal(); watchdog(); } catch { /* never break the queue */ } }, 5000);

function stopRound() {
  if (!cur) return false;
  cur.stopped = true;
  const pid = cur.child.pid;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
  else try { cur.child.kill('SIGTERM'); } catch { /* ignore */ }
  return true;
}

// ---------- api ----------
function view() {
  const people = {};
  for (const i of S.items) {
    const p = (people[i.person] = people[i.person] || { person: i.person, added: 0, waiting: 0, running: 0, passed: 0, blocked: 0, failed: 0 });
    p.added++;
    if (i.status === 'waiting') p.waiting++;
    else if (i.status === 'running') p.running++;
    else if (i.status === 'passed') p.passed++;
    else if (i.status === 'blocked') p.blocked++;
    else p.failed++;
  }
  const next = pickRound().map((i) => i.id);
  return { running: !!cur, held: S.paused, round: S.round, startedAt: cur ? cur.started : null, next, items: S.items.slice(-400), people: Object.values(people) };
}

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((ok) => { let b = ''; req.on('data', (d) => { b += d; if (b.length > 100000) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } }); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === '/ingest') {
      if (req.headers['x-ingest-token'] !== TOKEN) return json(res, 403, { error: 'no' });
      const b = await body(req);
      if (Date.now() - lastIngest > 120000) emit('=== Lines from a run started in the VS Code Test Explorer ===');
      lastIngest = Date.now();
      for (const l of (Array.isArray(b.lines) ? b.lines : []).slice(0, 400)) emit(String(l).slice(0, 2000));
      return json(res, 200, { ok: true });
    }
    const code = accessCode();
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const b = await body(req);
      if (code && String(b.code || '') === code) { res.writeHead(200, { 'Set-Cookie': `qc=${encodeURIComponent(code)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax` }); return res.end('{}'); }
      return json(res, 401, { error: 'Wrong code' });
    }
    if (code && cookieOf(req) !== code) {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/output')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(LOGIN_PAGE); }
      return json(res, 401, { error: 'Access code needed' });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, view());
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: init\ndata: ${JSON.stringify(lines.slice(-1500))}\n\n`);
      res.write(`event: state\ndata: ${JSON.stringify(view())}\n\n`);
      clients.add(res); req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/add') {
      const b = await body(req);
      const person = String(b.person || '').trim().slice(0, 40);
      if (!person) return json(res, 400, { error: 'Please type your name.' });
      // also accepts the page title copied from GitHub ("GitHub - owner/repo at BRANCH"): it is turned into the branch link
      const text = String(b.links || '').replace(/GitHub\s*[-–—]\s*([\w.-]+\/[\w.-]+)\s+at\s+([^\s,]+)/g, (m, repo, br) => ` https://github.com/${repo}/tree/${br} `);
      const links = text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      if (!links.length) return json(res, 400, { error: 'Paste at least one GitHub branch link.' });
      const added = [], skipped = [];
      for (const l of links) {
        const m = LINK.exec(l);
        if (!m) { skipped.push(`${l} (not a GitHub /tree/ branch link)`); continue; }
        const branch = decodeURIComponent(m[2]);
        if (S.items.some((i) => (i.status === 'waiting' || i.status === 'running') && i.url === l)) { skipped.push(`${branch} (already in the queue)`); continue; }
        S.items.push({ id: ++S.seq, person, url: l, repo: m[1], branch, status: 'waiting', addedAt: new Date().toISOString() });
        added.push(branch);
      }
      save(); ping(); setTimeout(startRound, 500);
      return json(res, 200, { added, skipped });
    }
    // static pages
    const map = { '/': 'index.html', '/output': 'output.html' };
    const f = map[url.pathname];
    if (f) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(PUB, f))); }
    res.writeHead(404); res.end('Not found');
  } catch (e) { try { json(res, 500, { error: String(e && e.message) }); } catch { /* ignore */ } }
}).listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  console.log(`Branch queue is running.\n  On this PC:   http://localhost:${PORT}\n  For the team: ${ips.map((a) => `http://${a}:${PORT}`).join('   ') || '(no network found)'}\n  Live output:  /output\n${accessCode() ? 'Access code: ON (people must enter it)' : 'Access code: OFF — set QUEUE_CODE=<something> in .env before you share the page outside the office'}\nThe queue is HELD. Type  start  here to begin, then  pause | stop | list | remove <id> | status | help\nKeep this window open. Press Ctrl+C to stop the queue server.`);
});
// ---------- owner commands (typed in this terminal) ----------
const say = (m) => { emit(m); };
function listItems() {
  const w = S.items.filter((i) => i.status === 'waiting' || i.status === 'running');
  say(w.length ? w.map((i) => `  #${i.id} ${i.status.padEnd(7)} ${i.person}: ${i.branch}`).join('\n') : '  (nothing waiting)');
}
function command(line) {
  const [c, arg] = line.trim().split(/\s+/);
  if (!c) return;
  if (c === 'start') { S.paused = false; save(); ping(); say(`Queue started (${S.items.filter((i) => i.status === 'waiting').length} waiting).`); startRound(); }
  else if (c === 'pause') { S.paused = true; save(); ping(); say(cur ? 'Paused: the running round finishes, then the queue holds.' : 'Paused.'); }
  else if (c === 'stop') { S.paused = true; save(); ping(); say(stopRound() ? 'Stopping the current run …' : 'Nothing is running (queue held).'); }
  else if (c === 'clear') { S.items = S.items.filter((i) => i.status === 'waiting' || i.status === 'running'); save(); ping(); say('Finished items cleared.'); }
  else if (c === 'list') listItems();
  else if (c === 'remove') { const it = S.items.find((i) => i.id === Number(arg) && i.status === 'waiting'); if (it) { S.items = S.items.filter((i) => i !== it); save(); ping(); say(`Removed #${it.id} ${it.branch}`); } else say('Give the id of a WAITING branch, e.g.  remove 7   (see  list)'); }
  else if (c === 'status') say(`${cur ? `Running round ${S.round}` : S.paused ? 'Held (type  start)' : 'Idle'} · ${S.items.filter((i) => i.status === 'waiting').length} waiting`);
  else say('Commands:  start | pause | stop | clear | list | remove <id> | status | help');
}
try { require('readline').createInterface({ input: process.stdin }).on('line', command); } catch { /* no keyboard */ }

process.on('uncaughtException', (e) => console.log('queue server error (kept running):', e.message));
