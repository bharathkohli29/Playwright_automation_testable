// Optional: copies the flow's log lines to the queue's live output page while a run is started from the VS Code Test Explorer.
// Loaded from playwright.config.ts. It does nothing unless the queue server is running on this PC, never throws, and never waits.
try {
  const fs = require('fs');
  const path = require('path');
  const http = require('http');
  const isWorker = process.env.TEST_WORKER_INDEX !== undefined;      // only the test worker (not the runner) so lines are not doubled
  if (isWorker && !process.env.QUEUE_ROUND && !process.env.QUEUE_NO_MIRROR) {
    let info = null;
    try { info = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'ingest.json'), 'utf8')); } catch { /* queue not running */ }
    if (info && info.port && info.token) {
      let buf = [];
      let timer = null;
      const flush = () => {
        timer = null;
        if (!buf.length) return;
        const body = JSON.stringify({ lines: buf.splice(0, 400) });
        try {
          const req = http.request({ host: '127.0.0.1', port: info.port, path: '/ingest', method: 'POST', timeout: 1500, agent: false,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-ingest-token': info.token } }, (res) => res.resume());
          req.on('error', () => {}); req.on('timeout', () => req.destroy());
          req.end(body);
        } catch { /* ignore */ }
      };
      const tee = (chunk) => {
        try {
          const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
          for (const l of text.split(/\r?\n/)) if (l.trim()) buf.push(l);
          if (!timer) { timer = setTimeout(flush, 700); if (timer.unref) timer.unref(); }
        } catch { /* ignore */ }
      };
      for (const stream of [process.stdout, process.stderr]) {
        const orig = stream.write.bind(stream);
        stream.write = (chunk, ...rest) => { tee(chunk); return orig(chunk, ...rest); };
      }
      process.on('exit', () => { try { flush(); } catch { /* ignore */ } });
    }
  }
} catch { /* never break the run */ }

// Heartbeat of the test worker (every 10 s): lets the queue tell "worker process stopped" from "browser call never returns".
try {
  if (process.env.TEST_WORKER_INDEX !== undefined) {
    const fs = require('fs'); const path = require('path');
    try { require('./keepAwake').keepAwake('this test run is active'); } catch { /* ignore */ }
    const file = path.join(__dirname, 'data', 'heartbeat.json');
    let last = Date.now(); let lastLine = ''; let lastLineAt = Date.now();
    for (const stream of [process.stdout]) {
      const orig = stream.write.bind(stream);
      stream.write = (chunk, ...rest) => { try { const t = String(chunk).trim().split(/\r?\n/).pop(); if (t) { lastLine = t.slice(0, 200); lastLineAt = Date.now(); } } catch { /* ignore */ } return orig(chunk, ...rest); };
    }
    const beat = () => {
      const now = Date.now(); const lag = Math.max(0, now - last - 10000); last = now;
      if (lag > 30000) { try { const T = require('./freezeTracker'); T.track({ kind: 'PC_SUSPENDED', gapSec: Math.round(lag / 1000), lastLine, note: 'the test worker did not run for this long and then continued: the PC (or this process) was suspended' }); T.powerEvents(lag / 60000, 'worker gap'); } catch { /* ignore */ } }
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ t: now, pid: process.pid, rssMB: Math.round(process.memoryUsage().rss / 1048576), lagMs: lag, lastLine, lastLineAt, exited: false })); } catch { /* ignore */ }
    };
    const iv = setInterval(beat, 10000); if (iv.unref) iv.unref(); beat();
    process.on('exit', () => { try { fs.writeFileSync(file, JSON.stringify({ t: Date.now(), pid: process.pid, exited: true, lastLine, lastLineAt })); } catch { /* ignore */ } });
  }
} catch { /* never break the run */ }
