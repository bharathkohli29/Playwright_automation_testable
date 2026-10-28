// FREEZE TRACKER — writes the evidence for "why did the run stop" into  queue-server/data/freeze-tracker.jsonl  (one line per event).
// Three kinds of evidence, each pointing at a different root cause:
//   PC_SUSPENDED          the queue server (or the worker) itself did not run for a while      → the PC slept / was suspended (power events from the Windows log are attached)
//   WORKER_ALIVE_STALLED  worker process still exists but stopped beating                      → blocked or suspended process (not killed)
//   WORKER_DIED_NO_EXIT   worker process is gone and never wrote its exit marker               → killed from outside (crash, out-of-memory, VS Code, antivirus, user)
const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, 'data');
const FILE = path.join(DATA, 'freeze-tracker.jsonl');

function track(o) {
  try { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(FILE, JSON.stringify({ at: new Date().toISOString(), by: process.env.TEST_WORKER_INDEX !== undefined ? 'worker' : 'queue-server', ...o }) + '\n'); } catch { /* never break the run */ }
}

/** Windows power / crash events of the last <minutes> minutes (sleep, wake, modern standby, unexpected shutdown, app crash) → written to the tracker. */
function powerEvents(minutes, why) {
  try {
    if (process.platform !== 'win32') return;
    const ps = [
      `$s=(Get-Date).AddMinutes(-${Math.max(5, Math.ceil(minutes) + 5)})`,
      "$e=Get-WinEvent -FilterHashtable @{LogName='System';Id=1,41,42,107,506,507,566,6008;StartTime=$s} -ErrorAction SilentlyContinue | Select-Object -First 25 | ForEach-Object { '{0:HH:mm:ss} id{1} {2}: {3}' -f $_.TimeCreated,$_.Id,$_.ProviderName,(($_.Message -split \"`n\")[0]) }",
      "$a=Get-WinEvent -FilterHashtable @{LogName='Application';Id=1000,1001,1002;StartTime=$s} -ErrorAction SilentlyContinue | Select-Object -First 10 | ForEach-Object { '{0:HH:mm:ss} id{1} {2}: {3}' -f $_.TimeCreated,$_.Id,$_.ProviderName,(($_.Message -split \"`n\")[0]) }",
      "'POWER:'; $e; 'APP-CRASH:'; $a",
    ].join('; ');
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { windowsHide: true, timeout: 30000 }, (err, out) => {
      track({ kind: 'WINDOWS_EVENTS', why, events: String(out || err || '').split(/\r?\n/).filter(Boolean).slice(0, 40) });
    });
  } catch { /* ignore */ }
}


// ---- what makes VS Code's Playwright extension restart its test server (and kill a Test Explorer run)? ----
// The extension rebuilds when a file matching  *playwright*.config.*  or  *.env*  is created / changed / deleted, when workspace folders change,
// or when the "playwright.env" setting changes. We log every such file event (with its time) and, when a worker dies, the extension's own log lines.
function watchExtensionTriggers(root) {
  try {
    if (!root) return;
    const re = /(playwright[^\\/]*\.config\.(ts|js|mts|mjs)$)|(\.env[^\\/]*$)/i;
    const w = require('fs').watch(root, { recursive: true }, (ev, name) => {
      try { const n = String(name || ''); if (/node_modules|[\\/]results[\\/]|test-results/i.test(n)) return; if (re.test(n)) track({ kind: 'EXTENSION_TRIGGER_FILE_EVENT', event: ev, file: n, note: 'VS Code Playwright extension rebuilds (and stops the test server) on this file' }); } catch { /* ignore */ }
    });
    w.on('error', () => {}); if (w.unref) w.unref();
  } catch { /* ignore */ }
}
/** last "rebuild / test server stopped" lines of the Playwright extension (all VS Code windows, newest session) */
function extensionLog() {
  try {
    const base = path.join(process.env.APPDATA || '', 'Code', 'logs'); const out = [];
    const sess = fs.readdirSync(base).sort().slice(-1)[0]; if (!sess) return [];
    for (const w of fs.readdirSync(path.join(base, sess)).filter((d) => /^window/.test(d))) {
      const f = path.join(base, sess, w, 'exthost', 'ms-playwright.playwright', 'Playwright.log');
      if (fs.existsSync(f)) out.push(...fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => /rebuild|Test server stopped/i.test(l)).slice(-6).map((l) => `${w}: ${l}`));
    }
    return out;
  } catch { return []; }
}

/** the queue server calls this every 5 s */
let lastTick = Date.now(); let flagged = '';
function serverTick(readHeartbeat) {
  const now = Date.now(); const gap = now - lastTick; lastTick = now;
  if (gap > 30000) { track({ kind: 'PC_SUSPENDED', gapSec: Math.round(gap / 1000), note: 'the queue server did not run for this long: the whole PC (or this process) was asleep or suspended' }); powerEvents(gap / 60000, 'queue server gap'); }
  try {
    const h = readHeartbeat(); if (!h || h.exited) { flagged = ''; return; }
    const age = now - h.t;
    if (age > 90000 && flagged !== String(h.t)) {
      flagged = String(h.t);
      let alive = false; try { process.kill(h.pid, 0); alive = true; } catch (e) { alive = !!e && e.code === 'EPERM'; }
      track({ kind: alive ? 'WORKER_ALIVE_STALLED' : 'WORKER_DIED_NO_EXIT', pid: h.pid, silentSec: Math.round(age / 1000), serverGapSec: Math.round(gap / 1000), rssMB: h.rssMB, lastLine: h.lastLine, lastLineAgoSec: Math.round((now - (h.lastLineAt || h.t)) / 1000),
        note: alive ? 'worker process exists but stopped answering while the PC was awake (blocked or suspended)' : 'worker process is gone without a normal exit: killed from outside (crash, out-of-memory, VS Code, antivirus or a manual stop)' });
      track({ kind: 'PLAYWRIGHT_EXTENSION_LOG', lines: extensionLog() });
      powerEvents(age / 60000, 'worker stalled');
    }
  } catch { /* ignore */ }
}
module.exports = { track, powerEvents, serverTick, watchExtensionTriggers, FILE };
