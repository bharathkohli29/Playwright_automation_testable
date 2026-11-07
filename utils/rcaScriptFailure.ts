import * as fs from 'fs';
import * as path from 'path';
import { codeRoot, resolveRef, lookupText } from './rcaCode';
import type { CodeRef } from './rcaCode';
import { screenshotHtml } from './rcaScreenshot';

/**
 * RCA of a failure of the SCRIPT'S OWN step (for example "[CS_X/15] locator.click: Timeout 20000ms exceeded ... <button disabled ... title=...>").
 * It reads the three sources the way the platform RCA does, and only states what they show:
 *   the run files (run-details.json, s3-check.json), the QA EKS capture (eks-live/services.log) and the platform code (the frontend text of the control).
 * The code part is a read-only, short, redacted look-up of the label / tooltip text the page showed (the condition that disables a button is usually next to it).
 * The result goes into the first page of the RCA Report and into the Teams card (summary lines); it never decides more than the evidence allows.
 */
export interface ParsedFailure { branch: string; step: string; first: string; labels: string[]; titles: string[]; aria: string[]; disabled: boolean; timeoutMs: number; locator: string }
export interface ScriptFailure {
  step: string; oneLine: string; headline: string; lines: string[]; symptom: string; uiFacts: string[]; run: string[]; s3: string[]; eks: string[]; code: CodeRef[]; condition: string;
  likely: string; proof: string; owner: string; check: string[];
}
const ANSI = /\u001b?\[\d+(?:;\d+)*m/g;
const NLC = String.fromCharCode(10);

export function parseFailure(msg: string): ParsedFailure {
  const t = String(msg || '').replace(ANSI, '');
  const m = /\[([^\]/]+)\/(\d+)\]\s*([^\n]*)/.exec(t);
  const labels = [...new Set([...t.matchAll(/(?:aria-label|title)="([^"]{12,200})"/g)].map((x) => x[1]))];
  const attr = (a: string) => [...new Set([...t.matchAll(new RegExp(`${a}="([^"]{12,200})"`, 'g'))].map((x) => x[1]))];
  return { titles: attr('title'), aria: attr('aria-label'), branch: m?.[1] || '', step: m?.[2] || '', first: (m?.[3] || t.split(NLC)[0] || '').trim().slice(0, 200), labels, disabled: /<button disabled|locator resolved to <[a-z]+ disabled/i.test(t), timeoutMs: Number(/Timeout (\d+)ms/.exec(t)?.[1] || 0), locator: /waiting for locator\('([^']{3,200})'/.exec(t)?.[1] || '' };
}

const readJson = (f: string): any => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const compact = (l: string) => l.replace(/^\[[^\]]*\]\s*(\[[^\]]*\]\s*)?/, '').replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\s*/g, '').replace(/"(?:trace_id|request_id|tenant_id|cell_id|fabric_id|instance_id|hostname|worker_id|pid)": "[^"]*",?\s*/g, '').replace(/\s+/g, ' ').trim().slice(0, 230);

export function analyseScriptFailure(branchDir: string, msg: string): ScriptFailure {
  const f = parseFailure(msg);
  const rd = readJson(path.join(branchDir, 'run-details.json')); const s3 = readJson(path.join(branchDir, 's3-check.json'));
  const run = rd ? [`Run ${String(rd.run_id || '').slice(0, 8)}: status ${rd.status}, phase ${rd.phase}`, `Tasks: ${rd.total_tasks} total, ${rd.completed_tasks} completed, ${rd.failed_tasks} failed, ${rd.skipped_tasks} skipped${rd.overall_score != null ? `, score ${rd.overall_score}` : ''}`] : ['No run-details.json: the run record was not captured.'];
  const checks: any[] = Array.isArray(s3?.checks) ? s3.checks : []; const tally: Record<string, number> = {}; for (const c of checks) tally[c.result] = (tally[c.result] || 0) + 1;
  const s3lines = checks.length ? [`S3 check of the run: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')}`] : ['No S3 check available for this run.'];
  let eks: string[] = [];
  try { const log = fs.readFileSync(path.join(branchDir, 'eks-live', 'services.log'), 'utf8').split(NLC); eks = log.filter((l) => /snapshot|export|gate[_ .-]?evidence|taxonomy/i.test(l)).slice(-4).map(compact); } catch { /* no capture */ }
  if (!eks.length) eks = [fs.existsSync(path.join(branchDir, 'eks-live')) ? 'The cluster capture has no service line about the snapshot, the export or the gate evidence.' : 'No cluster capture for this run.'];

  const uiFacts = [f.disabled ? 'The control was found but DISABLED.' : 'The control was not found or not clickable.', ...f.labels.map((l) => `Page text: "${l}"`), ...(f.timeoutMs ? [`The script waited ${Math.round(f.timeoutMs / 1000)} s.`] : [])];
  const root = codeRoot(); const ref = root ? resolveRef(root) : null; const code: CodeRef[] = [];
  if (root) for (const l of f.labels.slice(0, 2)) code.push(...lookupText(root, l, ref?.ref ?? null));
  const cond = code.map((c) => /disabled=\{([^}]{3,140})\}/.exec(c.snippet)?.[1] || '').find(Boolean) || '';
  // second step: where the first flag of that condition is worked out (this is the real "why": what has to be true before the button is enabled)
  let defined = '';
  if (root && cond) {
    const id = (cond.match(/[A-Za-z_][A-Za-z0-9_]{6,}/g) || []).find((w) => !/^(disabled|downloading)$/i.test(w) && !/ing$/.test(w)) || '';
    if (id) { const d = [`const ${id}`, `${id} =`].map((q) => lookupText(root, q, ref?.ref ?? null, { before: 1, after: 10 })).find((x) => x.length); if (d?.[0]) { code.push({ ...d[0], code: id }); defined = `${id} is worked out in ${d[0].file}:${d[0].line}.`; } }
  }
  const title = f.titles[0] || f.labels.find((l) => /available|until|after/i.test(l)) || ''; const name = f.aria[0] || f.labels.find((l) => l !== title) || f.labels[0] || 'control';
  let likely: string; let proof: string; let owner: string; let check: string[]; let oneLine: string; let symptom: string;
  if (f.disabled && title) {
    oneLine = `Step ${f.step || '?'} failed: "${name}" stayed disabled (${title.replace(/\.$/, '')}).`;
    symptom = `The button "${name}" was disabled when the script reached step ${f.step || '?'}, so the click waited ${Math.round((f.timeoutMs || 0) / 1000)} s and failed.`;
    likely = `The platform keeps this button disabled until: "${title}". So when the script looked, that condition was not met.${cond ? ` The frontend condition is ${cond} (${code[0].file}:${code[0].line}).${defined ? ` ${defined}` : ''}` : code.length ? ` The text is set in ${code[0].file}:${code[0].line}.` : ''}`;
    proof = code.length ? 'Proven in the code for why the button is disabled; Inferred for why the condition was not met (the run files do not say).' : 'Inferred from the page text only (the platform code was not available for a look-up).';
    owner = 'Undecided: Platform if the run never becomes exportable; the script if it only needs to wait longer.';
    check = [`Open the run page now and see whether the button is enabled (${rd?.status ? `run status is ${rd.status}` : 'run status unknown'}).`, 'If it is enabled now: the script reached the step before the export was ready; wait for the condition, not a fixed time.', 'If it stays disabled: look for the gate evidence / snapshot export of this run in the cluster logs and S3, and report it to the platform team.'];
  } else if (/did not complete within [0-9]+ minutes/i.test(msg)) {
    const mins = /did not complete within ([0-9]+) minutes/i.exec(msg)?.[1] || '?';
    oneLine = `The run did not finish within ${mins} minutes.`; symptom = `The script waited ${mins} minutes for the run to be reported as finished and gave up.`;
    likely = `The platform did not report the run as finished in that time. It may still be running, be stuck (for example waiting for capacity), or have finished without the page showing it. The run record, the cluster lines and the code below show which.${rd?.status ? ` The run record says status ${rd.status}, phase ${rd.phase}.` : ''}`;
    proof = 'Unknown until the run record and the logs are read; nothing here proves a cause.'; owner = 'Undecided: Platform if the run is stuck, the script if the page did not show a finished run.';
    check = ['Open the run page and see whether it has finished since.', 'Read the orchestrator lines below for repeated rejections or a quiet period.', 'If the run is stuck, report it to the platform team with the run id.'];
  } else {
    oneLine = `Step ${f.step || '?'} failed: ${f.first || 'the script step did not complete'}`;
    symptom = f.first || 'A step of the script failed.';
    likely = 'The page did not offer the control the script needed. The run files and logs show no platform cause for it.';
    proof = 'Unknown: the evidence names no cause.'; owner = 'Undecided'; check = ['Open the run page and compare it with the failure screenshot (errors/failure.png).'];
  }
  const lines = [oneLine, likely, `Proof: ${proof}`, `Owner: ${owner}`];
  return { step: f.step, oneLine, headline: `\u274C Branch ${f.branch || path.basename(branchDir)} failed${f.step ? ` at step ${f.step}` : ''}: ${f.disabled && name !== 'control' ? `"${name}" stayed disabled` : oneLine.replace(/^Step [0-9]+ failed: /, '').slice(0, 160)}`.trim(), lines, symptom, uiFacts, run, s3: s3lines, eks, code, condition: cond, likely, proof, owner, check };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const ul = (xs: string[]) => `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
export function scriptFailureHtml(sf: ScriptFailure, shots: string[] = []): string {
  const code = sf.code.length ? sf.code.map((c) => `<div class="ev"><b>${esc(c.file)}:${c.line}</b><pre style="margin:6px 0 0;white-space:pre-wrap;font-size:10.5px">${esc(c.snippet)}</pre></div>`).join('') : '<p class="small">No platform code was available for a look-up.</p>';
  return `<section class="tool"><div class="banner" style="background:#b45309"><h1>SCRIPT FAILURE: step ${esc(sf.step || '?')}</h1><div>the script's own step failed; the three sources below say what they show</div></div>
<div class="one" style="border:2px solid #f59e0b;background:#fffbeb">${esc(sf.oneLine)}</div>
<h2>What happened</h2><p>${esc(sf.symptom)}</p>${ul(sf.uiFacts)}
<h2>Likely cause</h2><p>${esc(sf.likely)}</p><p><b>Proof level:</b> ${esc(sf.proof)}</p>
<h2>Evidence from the three sources</h2>
<h3>1 · Run files and S3</h3>${ul([...sf.run, ...sf.s3])}
<h3>2 · EKS logs</h3>${ul(sf.eks)}
<h3>3 · Platform code</h3>${code}
${screenshotHtml(shots)}
<h2>Who fixes it</h2><p>${esc(sf.owner)}</p>
<h2>What to check next</h2>${ul(sf.check)}
</section>`;
}
