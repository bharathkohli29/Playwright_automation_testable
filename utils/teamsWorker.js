// Runs OUTSIDE the test (started detached by utils/teams.ts) so a failure message can never hold up or break the run.
// Usage: node teamsWorker.js <job.json>   job = { webhook, payload, imagePath, log }
const fs = require('fs');
const path = require('path');

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const log = (m) => { try { fs.appendFileSync(job.log, `${new Date().toISOString()} ${m}\n`); } catch (e) { /* ignore */ } };

async function shrink(imagePath) {
  if (!imagePath || !fs.existsSync(imagePath)) return '';
  const { chromium } = require('@playwright/test');
  const src = `data:image/png;base64,${fs.readFileSync(imagePath).toString('base64')}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const tab = await browser.newPage();
    for (const [w, q] of [[560, 45], [480, 38], [400, 32], [320, 28]]) {
      await tab.setViewportSize({ width: w, height: 600 });
      await tab.setContent(`<body style="margin:0;background:#fff"><img id="i" src="${src}" style="width:${w}px;display:block"></body>`);
      await tab.waitForFunction(() => document.getElementById('i') && document.getElementById('i').complete);
      const h = Math.min(Math.max(1, await tab.evaluate(() => document.getElementById('i').getBoundingClientRect().height)), 700);
      const buf = await tab.screenshot({ type: 'jpeg', quality: q, clip: { x: 0, y: 0, width: w, height: Math.floor(h) } });
      if (buf.length <= 17000 || w === 320) {
        fs.writeFileSync(imagePath.replace(/\.png$/i, '') + '-teams.jpg', buf);
        return buf.toString('base64');
      }
    }
    return '';
  } finally { await browser.close().catch(() => {}); }
}

async function post(payload) {
  const res = await fetch(job.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
  log(`post -> HTTP ${res.status}`);
  return res.ok;
}

(async () => {
  let img = '';
  try { img = await Promise.race([shrink(job.imagePath), new Promise((r) => setTimeout(() => r(''), 30000))]); } catch (e) { log(`no picture: ${e && e.message}`); }
  const text = JSON.parse(JSON.stringify(job.payload));
  const body = text.attachments[0].content.body;
  if (img) body.push({ type: 'Image', url: `data:image/jpeg;base64,${img}`, altText: 'failure screenshot', size: 'Stretch' });
  // up to 4 tries (with the picture, then once without it), waiting 4 s / 10 s / 20 s between tries, so a short network blip does not lose the message
  let ok = false;
  const waits = [0, 4000, 10000, 20000];
  for (let n = 0; n < waits.length && !ok; n++) {
    if (waits[n]) await new Promise((r) => setTimeout(r, waits[n]));
    try { ok = await post(text); } catch (e) { log(`try ${n + 1} failed: ${e && e.message}`); }
    if (!ok && img && n === 2) { body.pop(); log('trying without the picture'); }
  }
  log(ok ? `failure message sent${img ? ' with screenshot' : ''}` : 'could not send the failure message');
  process.exit(0);
})().catch((e) => { log(`worker error: ${e && e.message}`); process.exit(0); });
