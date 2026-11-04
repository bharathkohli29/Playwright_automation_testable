// Draws the RCA model workflow as a landscape A4 PDF with diagrams (HTML + SVG rendered in Chromium, the same way as the RCA reports).
//   node rca-train/make_workflow_pdf.js            ->  results/rca-docs/RCA_Model_Workflow.pdf (and the .html next to it)
// Every number on the pages comes from the real runs of 4 Nov 2026 (training log, held-out test, file sizes).
const fs = require('fs'); const path = require('path'); const { chromium } = require('@playwright/test');
const OUT = path.join(__dirname, '..', 'results', 'rca-docs'); fs.mkdirSync(OUT, { recursive: true });

const C = {
  teal: { f: '#E1F5EE', s: '#0F6E56', t: '#085041', u: '#0F6E56' }, purple: { f: '#EEEDFE', s: '#534AB7', t: '#3C3489', u: '#534AB7' },
  gray: { f: '#F1EFE8', s: '#5F5E5A', t: '#2C2C2A', u: '#5F5E5A' }, amber: { f: '#FAEEDA', s: '#854F0B', t: '#633806', u: '#854F0B' },
  green: { f: '#EAF3DE', s: '#3B6D11', t: '#27500A', u: '#3B6D11' }, red: { f: '#FCEBEB', s: '#A32D2D', t: '#791F1F', u: '#A32D2D' },
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** a box with a bold title and 1-2 lines of small text, vertically centred */
function box(x, y, w, h, title, subs, c, dashed) {
  const k = C[c]; const lines = [title, ...(Array.isArray(subs) ? subs : [subs]).filter(Boolean)]; const lh = 19; const top = y + h / 2 - ((lines.length - 1) * lh) / 2;
  return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="${k.f}" stroke="${k.s}" stroke-width="1.3"${dashed ? ' stroke-dasharray="6 4"' : ''}/>` +
    lines.map((t, i) => `<text x="${x + w / 2}" y="${top + i * lh}" text-anchor="middle" dominant-baseline="central" font-size="${i ? 13 : 15.5}" font-weight="${i ? 400 : 600}" fill="${i ? k.u : k.t}">${esc(t)}</text>`).join('') + '</g>';
}
const arrow = (d, id, dashed) => `<path d="${d}" fill="none" stroke="#5F5E5A" stroke-width="1.7"${dashed ? ' stroke-dasharray="6 4"' : ''}${id ? ` marker-end="url(#${id})"` : ''}/>`;
const defs = (id) => `<defs><marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="#5F5E5A" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>`;
const svg = (h, id, body) => `<svg width="100%" viewBox="0 0 1050 ${h}" xmlns="http://www.w3.org/2000/svg" role="img" font-family="Segoe UI, Arial, sans-serif">${defs(id)}${body}</svg>`;
const page = (title, sub, body) => `<section class="page"><h1>${esc(title)}</h1><p class="sub">${esc(sub)}</p>${body}</section>`;
const card = (c, title, text) => `<div class="card" style="background:${C[c].f};border-color:${C[c].s}"><b style="color:${C[c].t}">${esc(title)}</b><span style="color:${C[c].u}">${text}</span></div>`;

// ---- page 1: the picture in one slide ----
const p1 = page('How the RCA model works and how we practised it', 'Everything runs on our own PC with Ollama: no cloud, no data leaves the machine. 4 Nov 2026.',
  `<div class="cards3">${card('teal', 'In production', 'The stock model <b>qwen3:4b</b>, run by Ollama as <b>rca-writer</b>, only rewords facts into plain English. <b>No training.</b> Rules and logs decide the cause; checks reject invented details.')}` +
  `${card('purple', 'The experiment', 'A small <b>LoRA fine-tune</b> of Qwen2.5-1.5B on 39 cases gave <b>rca-writer-v0</b>. It learned the format and matches the stock models on 9 unseen cases. <b>Not used yet.</b>')}` +
  `${card('gray', 'Fully local', 'RTX 3050 laptop GPU (4 GB). Models, weights and training files live on F:. Only code and the setup recipe are in git, not the weights.')}</div>` +
  `<div class="note"><b>One sentence to remember:</b> Ollama runs models, it does not train them. Training was done with PyTorch and LoRA outside Ollama, then converted to GGUF and loaded into Ollama.</div>` +
  `<div class="legend"><span><i style="background:${C.teal.s}"></i>production path</span><span><i style="background:${C.purple.s}"></i>training experiment</span><span><i style="background:${C.gray.s}"></i>data and neutral steps</span></div>` +
  `<p class="small">Pages: 2 How the report is made · 3 How the model was practised · 4 What changed in the weights · 5 Results and honest status · 6 How teammates run it</p>`);

// ---- page 2: how the RCA report is created ----
const b2 = box(0, 20, 222, 70, 'Live capture', 'pod logs, read-only kubectl', 'gray') + box(276, 20, 222, 70, 'S3 check', 'tool results, failure.json', 'gray') + box(552, 20, 222, 70, 'Facts per tool', 'one fact pack for each tool', 'gray') + box(828, 20, 222, 70, 'Rules', 'known causes, evidence line', 'teal') +
  arrow('M224 55 H272', 'a2') + arrow('M500 55 H548', 'a2') + arrow('M776 55 H824', 'a2') +
  arrow('M939 90 V125 H530 V148', 'a2') + arrow('M530 125 H150 V148', 'a2') +
  box(0, 150, 300, 70, 'Green tools (fine)', 'written from the facts, no model', 'green') + box(380, 150, 300, 70, 'Red tools: local model', 'Qwen3 4B in Ollama words them', 'purple') + box(750, 150, 300, 70, 'Checks', ['no invented path, option, number', 'a check fails: rule text instead'], 'amber') +
  arrow('M682 185 H748', 'a2') + arrow('M150 220 V250 H410 V273', 'a2') + arrow('M900 220 V250 H412', null) +
  box(300, 275, 220, 70, 'PDF per tool', 'green or red layout', 'teal') + box(570, 275, 200, 70, 'SharePoint', 'whole folder uploaded', 'gray') + box(820, 275, 230, 70, 'Teams card', 'one per run', 'gray') + arrow('M522 310 H568', 'a2') + arrow('M772 310 H818', 'a2');
const p2 = page('How the RCA report is created', 'Rules and logs decide the cause. The model only rewords it, and only for the red tools.', svg(370, 'a2', b2) +
  `<div class="cols"><div><b>Green</b> = the tool was triggered and nothing is wrong. <b>Red</b> = not triggered, failed, empty, or it ran although the matrix excludes it.</div><div>The model sees only that one tool's facts, answers in a forced JSON shape (temperature 0.1), and its evidence line, owner and cause always come from the logs and rules.</div></div>`);

// ---- page 3: how the model was practised ----
const row1 = [['Saved runs', '12 runs: S3 + EKS logs', 'gray'], ['Distinct cases', '91 found, 48 picked', 'gray'], ['Answers written', 'from the facts, 13 kinds', 'gray'], ['Split', '39 train, 9 held out', 'gray'], ['Train (QLoRA)', ['4-bit base + LoRA', '38 steps, 7 minutes'], 'purple']];
const row2 = [['Adapter', '74 MB of new weights', 'purple'], ['Merge', 'adapter into base model', 'purple'], ['Convert', 'GGUF 8-bit, 1.64 GB', 'purple'], ['Load in Ollama', 'rca-writer-v0', 'teal'], ['Held-out test', '9 unseen cases', 'teal']];
let b3 = ''; row1.forEach((r, i) => { b3 += box(i * 215, 20, 190, 92, r[0], r[1], r[2]); if (i < 4) b3 += arrow(`M${i * 215 + 192} 66 H${i * 215 + 213}`, 'a3'); });
b3 += arrow('M955 114 V198', 'a3'); row2.forEach((r, i) => { const x = 860 - i * 215; b3 += box(x, 200, 190, 92, r[0], r[1], r[2]); if (i < 4) b3 += arrow(`M${x - 2} 246 H${x - 23}`, 'a3'); });
const stat = (a, b) => `<div class="stat"><b>${a}</b><span>${b}</span></div>`;
const p3 = page('How the model was practised (fine-tuned) locally', 'Base: Qwen2.5-1.5B-Instruct (Apache-2.0). Method: QLoRA on the RTX 3050, files on F:.', svg(315, 'a3', b3) +
  `<div class="stats">${stat('18.5 M of 1.56 B', 'weights trained (1.2%): rank 16, alpha 32')}${stat('38 steps · 7 min', '4 passes, batch 1, learning rate 2e-4')}${stat('3.46 GB', 'peak GPU memory on a 4 GB card')}${stat('1.33 → 0.045', 'training loss: almost memorised the 39 cases')}</div>` +
  `<div class="note small"><b>How the answers were made:</b> for each case the answer was written from its own facts, by class (not copied from the model drafts, which sometimes contradicted their facts). All 48 passed the same grounding check the pipeline uses. They were <b>not reviewed by people yet</b>.</div>`);

// ---- page 4: what changed in the weights ----
const bar = (y, label, w, c, inner, outer) => `<text x="0" y="${y + 20}" dominant-baseline="central" font-size="14.5" font-weight="600" fill="#2C2C2A">${esc(label)}</text><rect x="260" y="${y}" width="${w}" height="40" rx="6" fill="${C[c].f}" stroke="${C[c].s}" stroke-width="1.3"/>` +
  (inner ? `<text x="276" y="${y + 20}" dominant-baseline="central" font-size="13.5" fill="${C[c].t}">${esc(inner)}</text>` : '') + (outer ? `<text x="${260 + w + 12}" y="${y + 20}" dominant-baseline="central" font-size="13.5" fill="${C[c].t}">${esc(outer)}</text>` : '');
const b4 = bar(20, 'Base weights (frozen)', 700, 'gray', '3.09 GB: 1.54 billion numbers, never changed') + bar(90, 'Trained adapter (LoRA)', 17, 'purple', '', '74 MB: 18.5 million numbers, the only new weights') +
  bar(160, 'Merged: base + adapter', 700, 'teal', '3.09 GB: same size, the correction is added in place') + bar(230, '8-bit file for Ollama (GGUF)', 371, 'amber', '1.64 GB: half the size, tiny loss of precision');
const p4 = page('What changed in the weights', 'Weights are the numbers inside the model. Bar length = file size.', svg(285, 'a4', b4) +
  `<div class="cols"><div><b>The merge:</b><br><code>new weight = old weight + (alpha / rank) × B × A</code><br>A and B are the small trained matrices (rank 16, alpha 32) added to the attention and feed-forward layers. The original numbers were frozen during training.</div>` +
  `<div><b>Where the files are:</b><br><code>F:/rca-train/base</code> original weights<br><code>F:/rca-train/out-v0</code> the adapter<br><code>F:/rca-train/merged-v0</code> merged model<br><code>F:/rca-train/rca-writer-v0.q8_0.gguf</code> for Ollama<br><b>Not in git.</b> The production model <code>qwen3:4b</code> has unchanged weights: its Modelfile only adds settings.</div></div>`);

// ---- page 5: results and honest status ----
const p5 = page('Results and honest status', 'Tested on 9 cases the model never trained on, with the same checks the pipeline uses.',
  `<table><tr><th>Model</th><th>Accepted</th><th>Overlap with reviewed answer</th><th>Time per answer</th></tr>` +
  `<tr><td>Untrained base 1.5B</td><td>0 of 9</td><td>0.22</td><td>17 s</td></tr><tr class="hl"><td>Trained v0 1.5B (in Ollama)</td><td>9 of 9</td><td>0.64 to 0.66</td><td>3 to 4 s</td></tr>` +
  `<tr><td>qwen3 4B (in use today)</td><td>8 to 9 of 9</td><td>0.46 to 0.47</td><td>about 10 s</td></tr><tr><td>qwen2.5 3B (stock)</td><td>9 of 9</td><td>0.46 to 0.48</td><td>about 3 s</td></tr></table>` +
  `<div class="cols3"><div class="card" style="background:${C.green.f};border-color:${C.green.s}"><b style="color:${C.green.t}">Shown</b><span style="color:${C.green.u}">Training works locally. The untrained base cannot write the required format (0 of 9); the trained one can (9 of 9). Same accuracy as the stock models, faster than qwen3 4B.</span></div>` +
  `<div class="card" style="background:${C.amber.f};border-color:${C.amber.s}"><b style="color:${C.amber.t}">Not shown</b><span style="color:${C.amber.u}">That it is better. Only 9 test cases, many share a pattern with the training cases, the loss reached almost 0 (memorising), and the answers were written by Claude, not by people.</span></div>` +
  `<div class="card" style="background:${C.gray.f};border-color:${C.gray.s}"><b style="color:${C.gray.t}">Next</b><span style="color:${C.gray.u}">Two people score the blind sheet. Collect about 150 human-reviewed cases from more branches. Run one real branch to prove the report step. Then decide.</span></div></div>` +
  `<p class="small">"Accepted" means valid JSON, all five parts, names the tool, nothing invented (path, option, version, number). It does not prove the wording is correct: people must validate that.</p>`);

// ---- page 6: how teammates run it ----
const step = (n, t, s) => `<li><b>${n}. ${esc(t)}</b><span>${s}</span></li>`;
const p6 = page('How teammates run it', 'Nobody needs a GPU or any training. The setup prepares the model by itself.',
  `<ol class="steps">${step(1, 'Get the code', 'Clone the repo, switch to <code>dev</code>, run <code>npm install</code>.')}${step(2, 'Install Ollama', 'From ollama.com/download (the script installs it only with <code>RCA_SETUP_INSTALL_OLLAMA=yes</code> on Windows).')}` +
  `${step(3, 'Fill .env', 'Copy <code>.env.example</code>: Testable login, AWS keys for the S3 check, Teams webhook, branches in <code>builds.json</code>.')}${step(4, 'Sign in once', '<code>npm run sp:login</code> for SharePoint and <code>aws sso login --profile qa-eks-ro</code> for the cluster.')}` +
  `${step(5, 'Run npm test', 'A setup step starts Ollama, pulls qwen3:4b, creates rca-writer, installs the PDF browser and warms the model, with green ticks. Then the pre-flight and the run start.')}${step(6, 'Read the results', 'In <code>results/&lt;run&gt;/&lt;branch&gt;/</code> and on SharePoint: the <code>RCA Report</code> folder has one PDF per tool.')}</ol>` +
  `<div class="note small">Tested on one PC so far. The report step has not yet run in a full real branch run. Without cluster access the run works but the RCA has no pod logs.</div>`);


// page 7: the cases behind the model (counted from the files, not typed)
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
const ROOT = path.resolve(__dirname, '..'); const gold = readJson(path.join(ROOT, 'results/rca-gold/solo/gold-index.json')); const gold3 = readJson(path.join(ROOT, 'results/rca-gold/2026-11-04/gold-index.json'));
const trainRep = readJson('F:/rca-train/out-v1-UNREVIEWED/train-report.json'); const dsDir = path.join(ROOT, 'results/rca-dataset/v1');
const byCls = {}; for (const c of (gold?.cases || [])) byCls[c.cls] = (byCls[c.cls] || 0) + 1;
const clsRows = Object.entries(byCls).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('');
const perPerson = gold3?.perPerson ? Object.entries(gold3.perPerson).map(([k, v]) => `${esc(k)} ${v}`).join(' · ') : 'Sakthi 23 · Bharathkumar 23 · Visvantha 28';
const p7 = page('The cases behind the model', 'Counted from the files on this PC. Nothing here is a person-approved label yet.', `<div class="cols"><div><h3>Training data (dataset v1)</h3><table><tr><th>What</th><th>Cases</th></tr><tr><td>All exported cases (facts.jsonl)</td><td>${lines(path.join(dsDir, 'facts.jsonl'))}</td></tr><tr><td>Train split</td><td>${lines(path.join(dsDir, 'train.jsonl'))}</td></tr><tr><td>Held-out split</td><td>${lines(path.join(dsDir, 'holdout.jsonl'))}</td></tr><tr><td>Used by the last run (unreviewed)</td><td>${trainRep ? trainRep.examples : 'n/a'}</td></tr></table><div class="note small">Last run: ${trainRep ? `${trainRep.optimizer_steps} steps, ${Math.round(trainRep.seconds / 60)} min, loss ${trainRep.first_loss} to ${trainRep.last_loss}` : 'no report'}. Measurement only: the answers are the pipeline's own drafts, so the adapter is not used.</div></div><div><h3>Gold sheets for the people</h3><table><tr><th>Sheet</th><th>Cases</th></tr><tr><td>Solo sheet (Sakthi)</td><td>${(gold?.cases || []).length}</td></tr><tr><td>Three-person sheets</td><td>${perPerson}</td></tr></table><h3>Classes in the solo sheet</h3><table><tr><th>Cause class</th><th>Cases</th></tr>${clsRows}</table><div class="note small">Labelled so far: 0. After the YES/NO columns are filled, the labelled cases are scored, added to the dataset and the model is trained again.</div></div></div>`);
const css = `@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{margin:0;font:13.5px/1.5 "Segoe UI",Arial,sans-serif;color:#2C2C2A}.page{page-break-after:always;height:186mm;overflow:hidden}.page:last-child{page-break-after:auto}
h1{font-size:23px;margin:0 0 2px;color:#1F3A5F}.sub{margin:0 0 14px;color:#5F5E5A;font-size:13.5px}.cards3,.cols3{display:flex;gap:14px;margin:6px 0}.cards3 .card,.cols3 .card{flex:1}.card{border:1.3px solid;border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:6px;font-size:13.5px}.card b{font-size:15.5px}
.note{border:1.3px solid #B4B2A9;border-radius:10px;padding:10px 14px;background:#F9F8F3;margin:12px 0}.small{font-size:12.5px;color:#444441}.cols{display:flex;gap:22px;margin-top:8px}.cols>div{flex:1;font-size:13.5px}code{font:12.5px Consolas,monospace;background:#F1EFE8;padding:1px 5px;border-radius:4px}
.legend{display:flex;gap:22px;margin:6px 0 10px;font-size:12.5px}.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-1px}.stats{display:flex;gap:12px;margin:10px 0}.stat{flex:1;border:1.3px solid #B4B2A9;border-radius:10px;padding:10px 12px;background:#F9F8F3;display:flex;flex-direction:column}.stat b{font-size:17px;color:#3C3489}.stat span{font-size:12.5px;color:#444441}
table{border-collapse:collapse;width:100%;margin:6px 0 14px}th,td{border:1px solid #D3D1C7;padding:8px 12px;text-align:left;font-size:14px}th{background:#F1EFE8}tr.hl td{background:#EEEDFE;font-weight:600;color:#3C3489}.steps{list-style:none;padding:0;margin:6px 0;display:grid;grid-template-columns:1fr 1fr;gap:12px}.steps li{border:1.3px solid #B4B2A9;border-radius:10px;padding:12px 14px;background:#F9F8F3;display:flex;flex-direction:column;gap:4px}.steps b{color:#085041;font-size:15px}`;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>RCA model workflow</title><style>${css}</style></head><body>${p1}${p2}${p3}${p4}${p5}${p6}${p7}</body></html>`;
fs.writeFileSync(path.join(OUT, 'RCA_Model_Workflow.html'), html);
(async () => {
  const b = await chromium.launch(); const pg = await b.newPage(); await pg.setContent(html, { waitUntil: 'load' });
  await pg.pdf({ path: path.join(OUT, 'RCA_Model_Workflow.pdf'), format: 'A4', landscape: true, printBackground: true, margin: { top: '12mm', bottom: '14mm', left: '12mm', right: '12mm' }, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: '<div style="font-size:8px;color:#6b7280;width:100%;text-align:center">RCA model workflow · page <span class="pageNumber"></span> of <span class="totalPages"></span></div>' });
  await b.close(); console.log('written', path.join(OUT, 'RCA_Model_Workflow.pdf'));
})();
