import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import './env';
import { chromium } from 'playwright';
import { eksKubectl, eksContext, eksNamespace } from './eksAnalyze';
import { codeRoot, resolveRef, lookupCode, lookupText } from './rcaCode';
import type { CodeRef } from './rcaCode';
import { agentCore, agentModel } from './rcaAgent';
import { setTrail, trailHtml, clearTrails, issueName } from './rcaTrail';
import type { Trail } from './rcaTrail';
import { docOf } from './rcaReport';
import { announceIfBlocked } from './eksIpNotice';
import { screenshotHtml, folderShots } from './rcaScreenshot';
import { badge, brief, callout, chainHtml, summaryCards, steps } from './rcaVisual';
import type { Kind } from './rcaVisual';
import type { ScriptFailure } from './rcaScriptFailure';
import { matchIssueRule, applyRule } from './issueRules';

/**
 * RCA OF ANY PLATFORM PROBLEM, named after the problem:   npm run rca:issue -- "<the problem in your words>" [--folder <branch folder>] [--run <run id>] [--since 3h] [--out <dir>] [--share]
 *   report file: RCA_<Name_of_the_issue>.pdf   (the name is made from the first words of the problem)
 * What it does, all read only and all on this PC:
 *   1. EKS      pods of the QA cell (ready, restarts, why not), recent Warning events, and the log lines of the platform services that match the problem (run id, error codes, keywords)
 *   2. CODE     where the error codes and the quoted texts of the problem are written in the platform code (the local copy), and the Thought -> Action -> Observation analysis of the local model
 *   3. REPORT   what was reported, what the cluster shows, what the code shows, the conclusion with its proof level (Proven / Inferred / Unknown), who fixes it, what would confirm it
 * With --folder the report goes into that branch folder's "RCA Report" (and the folder's earlier cluster capture is used when the cluster cannot be reached); otherwise into
 * results/issues/<date>/<Name_of_the_issue>/. --share also copies that folder to SharePoint. Never writes to the cluster or to the code. Never throws.
 */
const NLC = String.fromCharCode(10);
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'when', 'then', 'have', 'has', 'not', 'are', 'was', 'were', 'but', 'run', 'tool', 'platform', 'there', 'after', 'again', 'still', 'only', 'what', 'why', 'does', 'did']);

export { issueName };
export const issueFile = (text: string) => `RCA_${issueName(text)}.pdf`;

export interface Evidence { pods: string[]; events: string[]; logs: string[]; note: string; reached: boolean }
const k = (args: string[], sec = 60) => spawnSync(eksKubectl(), ['--context', eksContext(), '--request-timeout=30s', ...args], { encoding: 'utf8', timeout: sec * 1000, maxBuffer: 24_000_000 });
const norm = (l: string) => l.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>').replace(/\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)?/g, '').replace(/\b[0-9a-f]{12,}\b/g, '<h>').replace(/\s+/g, ' ').trim();

export function keywordsOf(issue: string, extra: string[] = []): string[] {
  const codes = (issue.match(/[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/g) || []); const uuids = issue.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || [];
  const words = (issue.toLowerCase().match(/[a-z][a-z0-9_.-]{5,}/g) || []).filter((w) => !STOP.has(w));
  return [...new Set([...extra, ...uuids, ...codes, ...words])].slice(0, 12);
}

/** read-only look at the QA cluster: pods, Warning events and the matching log lines of the platform services */
export function gatherEks(issue: string, opts: { runId?: string; since?: string } = {}): Evidence {
  const ev: Evidence = { pods: [], events: [], logs: [], note: '', reached: false };
  const ns = eksNamespace(); const pods = k(['get', 'pods', '-A', '-o', 'json'], 90);
  if (pods.status !== 0) { ev.note = `the cluster could not be reached (${String(pods.stderr || '').trim().split(NLC)[0].slice(0, 140) || 'no answer'})`; return ev; }
  ev.reached = true;
  let items: any[] = []; try { items = JSON.parse(pods.stdout).items || []; } catch { /* below */ }
  const cell = items.filter((p) => /wb-fabric|whitebox/i.test(p.metadata?.namespace || '') || p.metadata?.namespace === ns);
  const phases: Record<string, number> = {}; for (const p of cell) phases[p.status?.phase || '?'] = (phases[p.status?.phase || '?'] || 0) + 1;
  ev.pods.push(`${cell.length} pod(s) in the QA cell namespaces: ${Object.entries(phases).map(([a, b]) => `${a} ${b}`).join(', ') || 'none'}`);
  for (const p of cell) {
    const cs: any[] = p.status?.containerStatuses || []; const restarts = cs.reduce((n, c) => n + (c.restartCount || 0), 0); const waiting = cs.map((c) => c.state?.waiting?.reason).filter(Boolean).join(',');
    const bad = (p.status?.phase !== 'Running' && p.status?.phase !== 'Succeeded') || waiting || restarts >= 3 || cs.some((c) => c.ready === false && p.status?.phase === 'Running');
    if (bad) ev.pods.push(`${p.metadata.namespace}/${p.metadata.name}: ${p.status?.phase}${waiting ? ` (${waiting})` : ''}${restarts ? `, ${restarts} restart(s)` : ''}`);
  }
  const evs = k(['get', 'events', '-A', '--field-selector', 'type=Warning', '-o', 'json'], 90);
  try { const w: any[] = (JSON.parse(evs.stdout).items || []).filter((e: any) => /wb-fabric|whitebox/i.test(e.metadata?.namespace || '')); w.sort((a, b) => String(b.lastTimestamp || b.eventTime || '').localeCompare(String(a.lastTimestamp || a.eventTime || '')));
    for (const e of w.slice(0, 8)) ev.events.push(`${String(e.lastTimestamp || e.eventTime || '').slice(11, 19)} ${e.involvedObject?.name}: ${e.reason} (${String(e.message || '').slice(0, 140)})`); } catch { /* none */ }
  const kws = keywordsOf(issue, opts.runId ? [opts.runId] : []).map((x) => x.toLowerCase());
  const svc = cell.filter((p) => /orchestrator|admission|reconciler|worker|api|control/i.test(p.metadata?.name || '') && p.status?.phase === 'Running').slice(0, 5);
  const counts = new Map<string, { n: number; sample: string }>();
  for (const p of svc) {
    const lg = k(['logs', p.metadata.name, '-n', p.metadata.namespace, '--all-containers=true', `--since=${opts.since || '3h'}`, '--tail=3000'], 90); if (lg.status !== 0) continue;
    for (const line of String(lg.stdout || '').split(NLC)) {
      const low = line.toLowerCase(); const hit = kws.some((x) => low.includes(x)); const lvl = /"level": "(WARNING|ERROR|CRITICAL)"/.test(line) || /\b(WARNING|ERROR|CRITICAL)\b/.test(line.slice(0, 160));
      if (!(hit || (lvl && kws.length === 0))) continue;
      const key = norm(line).slice(0, 220); const c = counts.get(key); if (c) c.n++; else counts.set(key, { n: 1, sample: line });
    }
  }
  for (const [, v] of [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 14)) { const msg = /"message": "([^"]{0,200})/.exec(v.sample)?.[1] || v.sample.slice(0, 200); const t = /(\d{2}:\d{2}:\d{2})/.exec(v.sample)?.[1] || ''; ev.logs.push(`${v.n}x ${t} ${msg}`.trim()); }
  if (!ev.logs.length) ev.note = 'no log line of the platform services matches this problem in the chosen time window';
  return ev;
}

/** what an earlier capture of a run folder says about the problem (used when the cluster cannot be reached now) */
export function folderEvidence(dir: string, issue: string, runId = ''): string[] {
  const out: string[] = []; const rd = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'run-details.json'), 'utf8')); } catch { return null; } })();
  if (rd) out.push(`run ${String(rd.run_id).slice(0, 8)}: status ${rd.status}, phase ${rd.phase}, tasks ${rd.total_tasks} total / ${rd.completed_tasks} done / ${rd.failed_tasks} failed / ${rd.skipped_tasks} skipped`);
  try { const kws = keywordsOf(issue, runId ? [runId] : []).map((x) => x.toLowerCase()); const log = fs.readFileSync(path.join(dir, 'eks-live', 'services.log'), 'utf8').split(NLC);
    const hit = log.filter((l) => kws.some((x) => l.toLowerCase().includes(x))).slice(-8).map((l) => (/"message": "([^"]{0,180})/.exec(l)?.[1] || l.slice(0, 180)));
    if (hit.length) out.push(...hit.map((h) => `captured earlier: ${h}`)); } catch { /* no capture */ }
  return out;
}

const SYSTEM_ISSUE = [
  'You find the root cause of a problem somebody saw on the QA platform, using what the cluster shows and by reading the platform code with read-only tools.',
  'Every reply is ONE JSON object and nothing else: {"thought":"what you want to know and why","action":"search|read|runner|finish","input":"..."}.',
  'search: input is a text or an error code to find in the code (returns file:line and the line). read: input is file:line from a search result (about 20 lines). runner: input is a tool name (the file of its analyzer).',
  'Look for: the error code or message that appears in the cluster lines, where it is raised, the condition that guards it, and what keeps that condition true (a queue, a capacity count, a missing record).',
  'When you know enough, or the observations do not help, reply with action finish and input a JSON object: {"mechanism":"how the code produces the symptom, in one sentence","cause":"WHY that condition was true: the upstream data or state that fed it (an API call, a database query, a worker). Never repeat the symptom.","proof":"Proven | Inferred | Unknown (for the cause)","evidence":"file:line that you saw in an Observation","owner":"Platform or Repository or Unknown","next":"the specific log or query that would confirm the cause","fix":"HOW TO SOLVE IT for good: the concrete change and who makes it (name the file or setting from the Observations when they show it)","workaround":"what can be done right now to get unblocked","verify":"how to see that it is solved","candidates":[{"cause":"another possible cause","confirm":"what would confirm it"}]}.',
  'The report must say how to solve the problem. Base the fix on the cause you found; when the cause is not established, give the fix for the most likely candidate and say which one it is. A fix names only files, settings and values that the facts or the Observations showed.',
  'Follow the data upstream until you reach where it enters: the frontend gets it from an API call, the API gets it from a database or a worker. If the observations never reach that point, write cause as "Not established", proof Unknown, and give up to 3 candidates with the log or query that would confirm each.',
  'If the facts say the cluster was NOT READ, that is only a limit of this report: it is never the cause of the problem. Then work from the problem text and the platform code and give the proof level Inferred or Unknown.',
  'After a read, look where the variable of the condition is worked out: search for its name (for example  const listed ) and read that place. Do not read the same place twice.',
  'Use ONLY what the facts and the Observations show. Never invent a file, a line, an option or a number. Do not say that something is normal, usual or harmless. If they do not show the cause, the proof is Unknown.',
].join(NLC);

export interface IssueResult { file: string; dir: string; name: string; trail: Trail | null; evidence: Evidence }
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const ul = (xs: string[], none: string) => (xs.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p class="small">${esc(none)}</p>`);

export function issueHtml(issue: string, ev: Evidence, extra: string[], code: CodeRef[], trail: Trail | null, version: string, shots: string[] = []): string {
  const name = issueName(issue).split('_').join(' '); const c = trail?.conclusion;
  const proof = c?.proof || 'Unknown'; const pk: Kind = proof === 'Proven' ? 'ok' : proof === 'Inferred' ? 'warn' : 'muted';
  const notEst = !c || /^not established/i.test(c.cause);
  const what = brief(issue.replace(/\s+/g, ' '), 210);
  const why = !c ? 'The cause could not be established from the evidence below.' : notEst ? `Not confirmed yet. ${c.mechanism ? brief(c.mechanism, 150) : ''} ${c.candidates?.length ? `${c.candidates.length} possible causes are listed below, each with how to check it.` : ''}`.trim() : brief(c.cause, 230);
  const fixText = c?.fix ? brief(c.fix, 240) : 'No fix can be stated from the evidence yet.';
  const chain = c?.chain?.length ? c.chain : [`Problem: ${brief(issue, 80)}`, c?.mechanism ? `In the code: ${brief(c.mechanism, 100)}` : '', notEst ? 'Root cause not established yet' : `Root cause: ${brief(c!.cause, 100)}`];
  const codeBlock = code.length ? code.map((r) => `<div class="ev"><b>${esc(r.role || r.code)}</b> · ${esc(r.file)}:${r.line}${r.condition ? ` · only reached when: ${esc(r.condition)}` : ''}<pre style="margin:6px 0 0;white-space:pre-wrap;font-size:10.5px">${esc(r.snippet)}</pre></div>`).join('') + `<p class="small">Read-only look-up, platform code: ${esc(version)}. Secrets removed.</p>` : '<p class="small">No place of the platform code matched the codes or texts of this problem (or no local copy of the code is set).</p>';
  const causes = c?.candidates?.length ? `<table class="sm"><tr><th style="width:4%">#</th><th>Possible cause</th><th style="width:38%">How to check it</th><th style="width:10%">Status</th></tr>${c.candidates.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.cause)}</td><td>${esc(x.confirm)}</td><td><span class="pill">to check</span></td></tr>`).join('')}</table>` : '';
  const fixSteps = c?.fix ? `<ol>${steps(c.fix).map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : '';
  const body = `<section class="tool"><div class="banner" style="background:#1f3a5f"><h1>ROOT CAUSE ANALYSIS: ${esc(name)}</h1><div>${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC · QA platform · cluster, platform code and local model</div></div>
<div class="badges">${badge(`Proof: ${proof}`, pk)}${badge(`Owner: ${brief(c?.owner || 'undecided', 60)}`, 'info')}${badge(ev.reached ? 'Cluster read' : 'Cluster NOT read', ev.reached ? 'ok' : 'bad')}${badge(code.length ? 'Platform code read' : 'No platform code', code.length ? 'ok' : 'muted')}${c?.rule ? badge('Known pattern', 'info') : ''}</div>
${summaryCards([{ label: 'What happened', icon: '1', kind: 'bad', text: what }, { label: 'Why it happened', icon: '2', kind: notEst ? 'warn' : 'info', text: why }, { label: 'How to fix it', icon: '3', kind: 'ok', text: fixText }])}
${ev.reached ? '' : callout('Heads up: the cluster could not be read', `This PC could not reach the QA cluster${ev.note ? ` (${esc(ev.note.slice(0, 140))})` : ''}, so the cause below is checked against the platform code only. The cluster logs would confirm which cause is the real one.`, 'warn')}
<div class="sec">1 · How the problem comes about</div>${chainHtml(chain, notEst ? 'warn' : 'ok')}${c?.mechanism ? `<p><b>In the code (proven):</b> ${esc(c.mechanism)}</p>` : ''}
<div class="sec light">The problem, as reported</div><p>${esc(issue)}</p>${screenshotHtml(shots)}
${causes ? `<div class="sec">2 · Possible causes, and how to check each</div>${causes}` : ''}
<div class="sec">${causes ? '3' : '2'} · How to solve it</div>
${c?.fix ? callout('Permanent fix', fixSteps, 'ok') : ''}${c?.workaround ? callout('Do this now (workaround)', esc(c.workaround), 'warn') : ''}${c?.verify ? callout('How to check that it is solved', esc(c.verify), 'info') : ''}${c ? '' : '<p class="small">No fix can be stated until the cause is established.</p>'}
<p><b>Who fixes it:</b> ${esc(c?.owner || 'Undecided: the evidence does not show it.')}</p>
<p><b>What would confirm it:</b> ${esc(c?.next || 'Capture the problem live (the cluster logs of the moment it happens) and run this report again.')}</p>
${c?.rule ? `<p class="small"><b>Known pattern:</b> ${esc(c.rule)}. Written from the platform code; the lead confirms it by keeping or changing it.</p>` : ''}
<div class="appx">Evidence and analysis (details)</div>
<div class="strip"><div><b>EKS cluster</b><span>${ev.reached ? '&#10004;' : '&#10008;'}</span></div><div><b>Platform code</b><span>${code.length ? '&#10004;' : '&#10008;'}</span></div><div><b>Proof level</b><span>${esc(proof)}</span></div></div>
<h3>The run and the earlier capture</h3>${ul(extra, 'No run folder was given.')}
<h3>EKS cluster (read only, now)</h3>${ev.reached ? `${ul(ev.pods, 'no pod information')}<p><b>Recent Warning events</b></p>${ul(ev.events, 'no Warning event in the QA cell')}<p><b>Log lines of the platform services that match the problem</b> (count, time, message)</p>${ul(ev.logs, ev.note || 'no matching line')}` : `<p class="small">${esc(ev.note)}</p>`}
<h3>Platform code</h3>${codeBlock}
${trail ? trailHtml(trail.tool, true) : ''}
<div class="foot">Generated from the cluster and the platform code by the local model. Nothing was changed in the cluster or the code. A draft for people to check.</div></section>`;
  return docOf(body);
}

/** the plain-language explanation for the Teams card: what happened, why, how sure we are, who acts, what to do next, and where the report is */
export function explainLines(sf: ScriptFailure, trail: Trail | null, pdfName: string): string[] {
  const c = trail?.conclusion;
  return [
    `What happened: ${sf.symptom}`,
    ...(c?.mechanism ? [`Why the page blocks: ${c.mechanism}`] : []),
    `Why that was the case: ${c ? c.cause : sf.likely}`,
    ...(c?.candidates?.length ? [`Possible causes to check: ${c.candidates.map((x) => `${x.cause} (confirm: ${x.confirm})`).join('; ')}`] : []),
    `How sure we are: ${c ? c.proof : sf.proof}`,
    `Who should act: ${c?.owner || sf.owner}`,
    ...(c?.fix ? [`How to solve it: ${c.fix}`] : []),
    ...(c?.workaround ? [`Right now: ${c.workaround}`] : []),
    `What to check first: ${c?.next || sf.check[0] || 'see the full report'}`,
    `Full report: ${pdfName} (in the evidence folder linked below)`,
  ];
}

export async function rcaIssue(issue: string, opts: { folder?: string; runId?: string; since?: string; out?: string; share?: boolean; shots?: string[] } = {}): Promise<IssueResult> {
  const name = issueName(issue); const day = new Date().toISOString().slice(0, 10);
  const dir = opts.folder ? path.join(path.resolve(opts.folder), 'RCA Report') : path.resolve(opts.out || path.join('results', 'issues', day, name)); fs.mkdirSync(dir, { recursive: true });
  const ev = gatherEks(issue, { runId: opts.runId, since: opts.since });
  if (!ev.reached) await announceIfBlocked(console.log).catch(() => false); // when it is this PC's IP, say which IP to approve
  const extra = opts.folder ? folderEvidence(path.resolve(opts.folder), issue, opts.runId) : [];
  const root = codeRoot(); const ref = root ? resolveRef(root) : null; let code: CodeRef[] = [];
  const facts = [`ISSUE (as reported): ${issue}`, ...(extra.length ? ['RUN AND EARLIER CAPTURE:', ...extra.map((x) => `- ${x}`)] : []),
    ev.reached ? `CLUSTER (read only, now): ${ev.pods.join(' | ')}` : 'CLUSTER: NOT READ. This report could not reach the cluster from this PC. That is a limit of this report and says NOTHING about the problem: never give it as a cause.', ...(ev.events.length ? ['RECENT WARNING EVENTS:', ...ev.events.map((x) => `- ${x}`)] : []), ...(ev.logs.length ? ['LOG LINES THAT MATCH THE PROBLEM (count, time, message):', ...ev.logs.map((x) => `- ${x}`)] : [])].join(NLC);
  const codes = [...new Set(facts.match(/[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/g) || [])].filter((c) => c.length >= 10 && !/^(NOT_|NO_|RAN_BUT|HTTP_|AWS_)/.test(c)).slice(0, 3);
  if (root) { for (const cd of codes) code.push(...lookupCode(root, cd, ref?.ref ?? null)); for (const q of (issue.match(/"([^"]{8,120})"/g) || []).slice(0, 2)) code.push(...lookupText(root, q.slice(1, -1), ref?.ref ?? null)); }
  clearTrails(); let trail: Trail | null = null;
  try { trail = await agentCore(name, facts, { system: SYSTEM_ISSUE, model: agentModel(), maxSteps: Number(process.env.RCA_ISSUE_STEPS) || 8 }); if (trail) setTrail(trail); } catch { trail = null; }
  const shots = [...(opts.shots || []).map((x) => path.resolve(x)), ...(opts.folder ? folderShots(path.resolve(opts.folder)) : [])];
  // a known problem (understood from the platform code before): its mechanism, causes, fix and workaround are added where the model could not establish them
  const rule = matchIssueRule(issue);
  if (rule) { const merged = applyRule(trail?.conclusion ?? null, rule); trail = trail ? { ...trail, conclusion: merged } : { tool: name, model: 'rules', steps: [], conclusion: merged, note: '', ms: 0 }; setTrail(trail); }
  const html = issueHtml(issue, ev, extra, code.slice(0, 6), trail, ref?.label || 'no local copy', shots);
  const file = path.join(dir, issueFile(issue)); const b = await chromium.launch();
  try { const pg = await b.newPage(); await pg.setContent(html, { waitUntil: 'load' }); await pg.pdf({ path: file, format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '14mm', left: '12mm', right: '12mm' }, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: `<div style="font-size:8px;color:#6b7280;width:100%;text-align:center">RCA · ${esc(name)} · page <span class="pageNumber"></span> of <span class="totalPages"></span></div>` }); } finally { await b.close().catch(() => {}); }
  fs.writeFileSync(path.join(dir, `${issueFile(issue).replace(/\.pdf$/, '')}.evidence.json`), JSON.stringify({ issue, at: new Date().toISOString(), cluster: ev, run: extra, code: code.map((c) => `${c.file}:${c.line}`), trail }, null, 2));
  if (opts.share) { try { const { shareBranch } = await import('./postprocess'); const r = await shareBranch(opts.folder ? path.resolve(opts.folder) : dir); console.log(`  SharePoint: ${r.message}`); } catch (e) { console.log(`  SharePoint: not copied (${e instanceof Error ? e.message : e})`); } }
  return { file, dir, name, trail, evidence: ev };
}

if (require.main === module) {
  (async () => {
    const a = process.argv.slice(2); const flag = (f: string) => { const i = a.indexOf(f); return i >= 0 ? a.splice(i, 2)[1] : ''; }; const share = a.includes('--share'); if (share) a.splice(a.indexOf('--share'), 1); const shots: string[] = []; for (let i = a.indexOf('--screenshot'); i >= 0; i = a.indexOf('--screenshot')) shots.push(a.splice(i, 2)[1]);
    const folder = flag('--folder'); const runId = flag('--run'); const since = flag('--since') || '3h'; const out = flag('--out'); const issue = a.join(' ').trim();
    if (!issue) { console.log('Usage: npm run rca:issue -- "<the problem in your words>" [--folder <branch folder>] [--run <run id>] [--since 3h] [--out <dir>] [--screenshot <file>] [--share]'); process.exit(1); }
    console.log(`  RCA of the issue: ${issueName(issue)}`);
    const r = await rcaIssue(issue, { folder, runId, since, out, share, shots });
    console.log(`\n  ${r.evidence.reached ? 'cluster read' : 'cluster NOT reached'} · ${r.trail ? `${r.trail.steps.length} analysis step(s), ${r.trail.conclusion ? `conclusion ${r.trail.conclusion.proof}` : 'no conclusion kept'}` : 'no code analysis'}\n  report: ${r.file}`);
    process.exit(0);
  })();
}
