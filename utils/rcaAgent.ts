import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import './env';
import { codeRoot, resolveRef, lookupText, toolRunnerRefs, lookupCode } from './rcaCode';
import { redact } from './rcaRedact';
import { ungrounded, unsupportedClaims, isLocalHost, remoteAllowed, factsText } from './rcaWriter';
import { reportFromRules } from './rcaReport';
import type { FactPack } from './rcaFacts';
import { setTrail } from './rcaTrail';
import type { Step, Conclusion, Trail } from './rcaTrail';

/**
 * CODE ANALYSIS AS Thought -> Action -> Observation (ReAct), on the LOCAL model:
 *   the model answers with ONE JSON object per turn  {"thought": "...", "action": "search|read|runner|finish", "input": "..."}
 *   the script runs the action, read only, in the local copy of the platform code, and returns the Observation; the model then decides the next step.
 * Actions:  search(<text or code>)   where the text is written (file:line and the line)
 *           read(<file>:<line>)      about 20 lines around it
 *           runner(<tool>)           the analyzer file of the tool
 *           finish(<json>)           {"cause","proof":"Proven|Inferred|Unknown","evidence":"file:line","owner","next"}
 * Safety (the team rule: nothing of our codebase leaves this PC): Ollama must be on this PC; nothing is written to the checkout; a path with .. or an absolute path
 * is refused; every Observation is short and redacted; at most RCA_AGENT_STEPS steps (default 5); every step is appended to RCA_CODE_AUDIT (size only, never the code).
 * The conclusion is kept only when it is grounded: its evidence line must appear in an Observation, its words must be in the facts or the Observations,
 * and it may not claim "normal / usually / harmless". Otherwise the trail is shown without a conclusion.
 * Settings: RCA_AGENT=off turns it off in the reports (default on), RCA_AGENT_MODEL (default qwen3:4b), RCA_AGENT_MAX (tools per run, default 4), RCA_AGENT_STEPS.
 */
const NLC = String.fromCharCode(10);
const clean = (s?: string) => (s || '').trim().replace(/^["']|["']$/g, '');
const HOST = () => clean(process.env.OLLAMA_HOST) || 'http://127.0.0.1:11434';
export const agentModel = () => clean(process.env.RCA_AGENT_MODEL) || 'qwen3:4b';
export const agentEnabled = () => !/^(0|no|off|false)$/i.test(clean(process.env.RCA_AGENT));
const MAX_STEPS = () => Math.max(2, Math.min(8, Number(process.env.RCA_AGENT_STEPS) || 5));
const OBS_MAX = 1400;

const safePath = (f: string): string | null => { const n = f.replace(/\\/g, '/').replace(/^\.\//, ''); return !n || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..') ? null : n; };
const short = (s: string, n = OBS_MAX) => (s.length > n ? `${s.slice(0, n)} …` : s);

/** one read-only action in the local copy of the platform code; returns the Observation text */
export function act(root: string, ref: string | null, action: string, input: string): string {
  try {
    if (action === 'search') {
      const q = input.trim(); if (q.length < 4) return 'search needs at least 4 characters';
      const g = spawnSync('git', ['-C', root, 'grep', '-n', '-F', q, ...(ref ? [ref] : []), '--', '*.py', '*.ts', '*.tsx', '*.js', '*.cs', '*.java'], { encoding: 'utf8', timeout: 25_000, maxBuffer: 6_000_000 });
      const lines = String(g.stdout || '').split(NLC).filter(Boolean).map((l) => (ref && l.startsWith(`${ref}:`) ? l.slice(ref.length + 1) : l)).filter((l) => !/(^|\/)(tests?|test_[^/]*|alembic|migrations|node_modules|scripts|diagnostics|docs)(\/|:)/i.test(l)).slice(0, 6);
      if (!lines.length && /^[a-z0-9]+(-[a-z0-9]+)+$/.test(q)) return act(root, ref, 'search', q.toUpperCase().split('-').join('_')); // a rule name like cell-cpu-capacity: try the code form CELL_CPU_CAPACITY
      return lines.length ? redact(lines.map((l) => l.slice(0, 200)).join(NLC)).text : 'no match in the platform code';
    }
    if (action === 'read') {
      const m = /^(.+?):(\d+)\s*$/.exec(input.trim()); if (!m) return 'read needs  file:line';
      const f = safePath(m[1]); if (!f) return 'path refused'; const line = Number(m[2]);
      const src = ref ? String(spawnSync('git', ['-C', root, 'show', `${ref}:${f}`], { encoding: 'utf8', maxBuffer: 8_000_000 }).stdout || '') : (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), 'utf8') : '');
      if (!src) return `no such file in the platform code: ${f}`;
      const lines = src.split(NLC); const from = Math.max(0, line - 8); const to = Math.min(lines.length, line + 12);
      return redact(lines.slice(from, to).map((l, i) => `${from + i + 1}: ${l.trimEnd()}`).join(NLC)).text;
    }
    if (action === 'runner') { const r = toolRunnerRefs(root, ref, input.trim()); return r.length ? `${r[0].file}:${r[0].line}${NLC}${r[0].snippet}` : `no analyzer file found for ${input.trim()}`; }
    return `unknown action "${action}": use search, read, runner or finish`;
  } catch (e) { return `the look-up failed (${e instanceof Error ? e.message : e})`; }
}

const SYSTEM = [
  'You find out why one tool of an automated code-analysis run failed, did not run or came out empty, by reading the platform code with read-only tools.',
  'Every reply is ONE JSON object and nothing else: {"thought":"what you want to know and why","action":"search|read|runner|finish","input":"..."}.',
  'search: input is a text or an error code to find in the code (it returns file:line and the line). read: input is file:line from a search result (returns about 20 lines). runner: input is the tool name (returns the file of its analyzer).',
  'You see the Observation after each action. Look for: where the failure code is raised, the condition that guards it, and how the tool runner treats its input.',
  'When you know enough, or the observations do not help, reply with action finish and input a JSON object: {"mechanism":"how the code produces the symptom, in one sentence","cause":"WHY that condition was true: the upstream data or state that fed it (an API call, a database query, a worker). Never repeat the symptom.","proof":"Proven | Inferred | Unknown (for the cause)","evidence":"file:line that you saw in an Observation","owner":"Platform or Repository or Unknown","next":"the specific log or query that would confirm the cause","fix":"HOW TO SOLVE IT for good: the concrete change and who makes it (name the file or setting from the Observations when they show it)","workaround":"what can be done right now to get unblocked","verify":"how to see that it is solved","candidates":[{"cause":"another possible cause","confirm":"what would confirm it"}]}.',
  'The report must say how to solve the problem. Base the fix on the cause you found; when the cause is not established, give the fix for the most likely candidate and say which one it is. A fix names only files, settings and values that the facts or the Observations showed.',
  'Follow the data upstream until you reach where it enters: the frontend gets it from an API call, the API gets it from a database or a worker. If the observations never reach that point, write cause as "Not established", proof Unknown, and give up to 3 candidates with the log or query that would confirm each.',
  'After a read, look where the variable of the condition is worked out: search for its name (for example  const listed ) and read that place. Do not read the same place twice.',
  'Use ONLY what the facts and the Observations show. Never invent a file, a line, an option or a number. Do not say that something is normal, usual or harmless. If the observations do not show the cause, the proof is Unknown.',
].join(NLC);

async function chat(model: string, messages: Array<{ role: string; content: string }>, host = HOST()): Promise<string> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`${host.replace(/\/+$/, '')}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout((Number(process.env.RCA_AGENT_SEC) || 120) * 1000),
      body: JSON.stringify({ model, messages, stream: false, format: 'json', think: false, keep_alive: '5m', options: { temperature: 0, num_predict: 700 } }) });
    if (r.ok) return String(((await r.json()) as any)?.message?.content || '');
    lastStatus = r.status; if (r.status < 500) break; // a 5xx: the model runner restarted (GPU memory): wait and ask again
    await new Promise((res) => setTimeout(res, 4000 * (attempt + 1)));
  }
  throw new Error(`Ollama answered HTTP ${lastStatus}`);
}

/** a 4 GB GPU holds one model at a time: the other models that are loaded (the report writer) are unloaded before the analysis starts, so the analysis model gets the memory */
export async function freeGpuFor(model: string, host = HOST()): Promise<number> {
  let n = 0;
  try {
    const ps: any = await (await fetch(`${host.replace(/\/+$/, '')}/api/ps`, { signal: AbortSignal.timeout(5000) })).json();
    for (const m of ps?.models || []) { const name = String(m.name || ''); if (name && name !== model && name.split(':')[0] !== model.split(':')[0]) { await fetch(`${host.replace(/\/+$/, '')}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name, keep_alive: 0 }), signal: AbortSignal.timeout(15000) }).catch(() => {}); n++; } }
    if (n) await new Promise((res) => setTimeout(res, 2500));
  } catch { /* the server is not reachable: the loop reports it */ }
  return n;
}
const parse = (raw: string): { thought: string; action: string; input: string } | null => {
  try { const j = JSON.parse(raw.replace(/^[^{]*/, '').replace(/[^}]*$/, '')); const input = typeof j.input === 'string' ? j.input : JSON.stringify(j.input ?? ''); return { thought: String(j.thought || '').slice(0, 300), action: String(j.action || '').toLowerCase().trim(), input }; } catch { return null; }
};

function audit(tool: string, step: number, action: string, input: string, bytes: number) {
  try { const f = process.env.RCA_CODE_AUDIT || path.join(process.cwd(), 'results', 'rca-code-audit.jsonl'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), agent: true, tool, step, action, input: input.slice(0, 120), bytes }) + NLC); } catch { /* best effort */ }
}

/** the conclusion is kept only when it is grounded in the facts and the Observations */
const WORD = (t: string) => new Set((t.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) || []));
/** how much of text a is made of the words of text b (0..1): a "cause" that only repeats the symptom is not a cause */
export function overlap(a: string, b: string): number { const A = WORD(a); const B = WORD(b); if (!A.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / A.size; }

export function groundConclusion(raw: string, facts: string, observations: string): { c: Conclusion | null; note: string } {
  let j: any; try { j = JSON.parse(raw); } catch { return { c: null, note: 'the final answer was not valid JSON' }; }
  let cause = String(j.cause || '').trim(); if (!cause) return { c: null, note: 'the final answer has no cause' };
  const allowed = `${facts}${NLC}${observations}`; const issue = /ISSUE \(as reported\): (.+)/.exec(facts)?.[1] || '';
  const checkText = (t: string): string => { const bad = ungrounded(t, allowed); if (bad.length) return `names ${bad.slice(0, 3).join(', ')}, which no step showed`; const cl = unsupportedClaims(t, allowed); return cl.length ? `claims "${cl[0]}", which no step showed` : ''; };
  const why = checkText(cause); if (why) return { c: null, note: `the cause ${why}` };
  let mechanism = String(j.mechanism || '').trim(); if (mechanism && checkText(mechanism)) mechanism = '';
  let evidence = String(j.evidence || '').trim(); let proof = ['Proven', 'Inferred', 'Unknown'].find((x) => new RegExp(`^${x}`, 'i').test(String(j.proof || ''))) || 'Unknown';
  const loc = /([\w./-]+\.[a-z]{1,4}):(\d+)/.exec(evidence);
  if (!loc || !observations.includes(loc[1].split('/').pop() as string)) { evidence = ''; if (proof === 'Proven') proof = 'Inferred'; } // an evidence line no step showed cannot make a claim Proven
  // a "cause" that only repeats the problem says nothing: it becomes "not established", and what the code showed stays as the mechanism
  if (issue && overlap(cause, issue) >= 0.6) { if (!mechanism) mechanism = cause; cause = 'Not established: the code shows how the blocker is produced, but the steps did not reach the upstream data or state that made its condition true.'; proof = 'Unknown'; }
  if (/^not established/i.test(cause)) proof = 'Unknown';
  const clean = (t: unknown, n: number): string | undefined => { const x = String(t || '').trim(); return x && !checkText(x) ? x.slice(0, n) : undefined; }; // a fix that names something no step showed is dropped
  const candidates = (Array.isArray(j.candidates) ? j.candidates : []).slice(0, 3).map((x: any) => ({ cause: String(x?.cause || '').trim().slice(0, 220), confirm: String(x?.confirm || '').trim().slice(0, 220) })).filter((x: any) => x.cause && !checkText(x.cause)).map((x: any) => ({ cause: x.cause, confirm: x.confirm && !checkText(x.confirm) ? x.confirm : 'the logs of the service that serves it' }));
  return { c: { cause: cause.slice(0, 500), proof, evidence: evidence.slice(0, 160), owner: String(j.owner || '').slice(0, 80), next: (() => { const n = String(j.next || '').trim(); return n && !checkText(n) ? n.slice(0, 220) : ''; })(), mechanism: mechanism.slice(0, 400) || undefined, candidates: candidates.length ? candidates : undefined, fix: clean(j.fix, 420), workaround: clean(j.workaround, 320), verify: clean(j.verify, 260) }, note: '' };
}

/** the names in the code that was just read that are worth following next: functions that are called, and variables that are set from a call (what a person would search for next) */
export function leadsOf(observation: string, already: Set<string> = new Set()): string[] {
  const SKIP = new Set(['console', 'return', 'function', 'import', 'export', 'const', 'filter', 'map', 'find', 'some', 'every', 'includes', 'slice', 'join', 'push', 'length', 'Boolean', 'Array', 'String', 'Number', 'Object', 'Promise', 'useState', 'useEffect', 'useMemo', 'useCallback', 'setSelected', 'className', 'React']);
  const names: string[] = [];
  for (const m of observation.matchAll(/(?:const|let)\s+([A-Za-z_][A-Za-z0-9_]{3,})\s*=\s*(?:await\s+)?([A-Za-z_][A-Za-z0-9_.]{3,})\(/g)) { names.push(m[2].split('.').pop() as string); names.push(m[1]); }
  for (const m of observation.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{7,})\(/g)) names.push(m[1]);
  const METHODS = new Set(['has', 'get', 'set', 'add', 'delete', 'keys', 'values', 'entries', 'reduce', 'sort', 'flat', 'flatMap', 'concat', 'then', 'catch', 'finally', 'parse', 'stringify', 'trim', 'split', 'replace', 'test', 'pop', 'shift', 'toString', 'toLowerCase', 'toUpperCase', 'startsWith', 'endsWith']);
  return [...new Set(names)].filter((n) => n.length >= 4 && !SKIP.has(n) && !METHODS.has(n) && !already.has(n) && /^[a-z]/.test(n)).slice(0, 4);
}

/** where a function or variable is defined (function name / export function name / const name =): the first place outside tests, read as about 14 lines */
export function followLead(root: string, ref: string | null, name: string, fromFile = ''): string {
  for (const q of [`function ${name}`, `const ${name} =`, `const ${name}:`]) {
    const hits = act(root, ref, 'search', q).split(NLC).filter((l) => /^[^:\s]+:[0-9]+:/.test(l)); const dirOf = (f: string) => f.split('/').slice(0, -1).join('/');
    const hit = hits.find((l) => fromFile && l.startsWith(`${fromFile}:`)) || hits.find((l) => fromFile && l.startsWith(`${dirOf(fromFile)}/`)) || hits[0]; if (!hit) continue; // a definition in the same file, then the same folder, then anywhere
    const m = /^([^:\s]+):([0-9]+):/.exec(hit)!; const body = act(root, ref, 'read', `${m[1]}:${Number(m[2]) + 6}`);
    return `${m[1]}:${m[2]}${NLC}${body.split(NLC).slice(0, 16).join(NLC)}`;
  }
  return '';
}

/** the loop itself, for any question: a label (tool name or issue name), the facts text, and the settings */
export async function agentCore(label: string, facts: string, opts: { host?: string; model?: string; system?: string; maxSteps?: number } = {}): Promise<Trail | null> {
  const t0 = Date.now(); const model = opts.model || agentModel();
  const root = codeRoot(); if (!root) return null;
  if (!isLocalHost(opts.host || HOST()) && !remoteAllowed()) return { tool: label, model, steps: [], conclusion: null, note: 'blocked: the Ollama address is not on this PC (the team rule is local only)', ms: 0 };
  const ref = resolveRef(root).ref; const steps: Step[] = []; let observations = ''; await freeGpuFor(model, opts.host || HOST());
  const codes = [...new Set(facts.match(/[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/g) || [])].filter((c) => c.length >= 10 && !/^(NOT_|NO_|RAN_BUT|HTTP_|AWS_)/.test(c)).slice(0, 4);
  const messages = [{ role: 'system', content: opts.system || SYSTEM }, { role: 'user', content: `${facts}${NLC}${NLC}Start. The error codes in the facts (search for them exactly as written): ${codes.join(', ') || '(none named)'}.` }];
  let conclusion: Conclusion | null = null; let note = ''; let nudged = false; const seen = new Set<string>(); const leadSeen = new Set<string>(); let retried = 0;
  try {
    for (let i = 0; i < (opts.maxSteps || MAX_STEPS()); i++) {
      const raw = await chat(model, messages, opts.host || HOST()); const s = parse(raw);
      if (!s) { if (retried < 2) { retried++; messages.push({ role: 'user', content: 'Your last reply was not valid JSON. Reply with exactly ONE JSON object and nothing else: {"thought":"...","action":"search|read|runner|finish","input":"..."}.' }); continue; } note = 'the model did not answer in the required JSON'; break; }
      messages.push({ role: 'assistant', content: JSON.stringify(s) });
      // the first finish is sent back once when the model has not read any place yet: the condition that guards the failure is only visible in a read
      if (s.action === 'finish' && !nudged && !steps.some((x) => x.action === 'read') && i < (opts.maxSteps || MAX_STEPS()) - 1) { nudged = true; steps.push({ thought: s.thought, action: 'finish', input: '(sent back)', observation: 'not accepted yet: read the place (read file:line) to see the condition that guards the failure' }); messages.push({ role: 'user', content: 'Not yet. You have not read any place in the code. Use read with a file:line from a search result, so you can see the condition that leads to the failure, then finish.' }); continue; }
      if (s.action === 'finish') { const g = groundConclusion(s.input, facts, observations); conclusion = g.c; note = g.note; steps.push({ thought: s.thought, action: 'finish', input: short(s.input, 200), observation: g.c ? 'conclusion kept (grounded)' : `conclusion not kept: ${g.note}` }); break; }
      const did = `${s.action}|${s.input.trim()}`; const repeat = seen.has(did); seen.add(did);
      const obs = repeat ? 'You already did exactly this. Look at another place (where a variable of the condition is worked out, or who calls it) or finish.' : short(act(root, ref, s.action, s.input)); observations += `${NLC}${obs}`; audit(label, i + 1, s.action, s.input, obs.length);
      const leads = s.action === 'read' && !repeat ? leadsOf(obs, leadSeen) : []; leads.forEach((l) => leadSeen.add(l));
      const followed = leads.length ? followLead(root, ref, leads[0], (/^(.+?):[0-9]+\s*$/.exec(s.input.trim()) || [])[1] || '') : '';
      const obsShown = leads.length ? `${obs}${NLC}Leads (names in this code to follow next; search  function <name>  or  const <name> ): ${leads.join(', ')}${followed ? `${NLC}Followed lead "${leads[0]}" by itself: ${short(followed, 900)}` : ''}` : obs;
      if (followed) observations += `${NLC}${followed}`;
      steps.push({ thought: s.thought, action: s.action, input: s.input.slice(0, 120), observation: obsShown }); messages.push({ role: 'user', content: `Observation:${NLC}${obsShown}${NLC}${NLC}Next step (one JSON object).` });
      if (i === (opts.maxSteps || MAX_STEPS()) - 2) messages.push({ role: 'user', content: 'You have one step left: reply with action finish now.' });
    }
    if (!conclusion && !note) note = 'no final answer within the step limit';
  } catch (e) { note = `the model could not be reached (${e instanceof Error ? e.message : e})`; }
  return { tool: label, model, steps, conclusion, note, ms: Date.now() - t0 };
}

export async function runAgent(p: FactPack, opts: { host?: string; model?: string } = {}): Promise<Trail | null> {
  return agentCore(p.tool, factsText(p, reportFromRules(p)), opts);
}

/** for writeReports: runs the analysis for the red tools that have a reason to look at the code, at most RCA_AGENT_MAX of them, and registers each trail for the report */
export async function agentForRun(p: FactPack): Promise<Trail | null> {
  const t = await runAgent(p).catch(() => null); if (t) setTrail(t); return t;
}

if (require.main === module) {
  (async () => {
    const [dir, tool] = process.argv.slice(2); if (!dir || !tool) { console.log('Usage: npm run rca:agent -- "<branch folder>" <tool>'); process.exit(1); }
    const { buildFactPack } = await import('./rcaFacts'); const p = buildFactPack(path.resolve(dir), tool); const t = await runAgent(p);
    if (!t) { console.log('no local platform code (npm run code:login)'); process.exit(1); }
    t.steps.forEach((s, i) => { console.log(`\nStep ${i + 1}${NLC}  Thought:     ${s.thought}${NLC}  Action:      ${s.action}(${s.input})${NLC}  Observation: ${s.observation.split(NLC).slice(0, 6).join(NLC + '               ')}`); });
    console.log(t.conclusion ? `\nCONCLUSION (${t.conclusion.proof}): ${t.conclusion.cause}${t.conclusion.evidence ? `  [${t.conclusion.evidence}]` : ''}` : `\nNo conclusion kept: ${t.note}`); console.log(`(${t.model}, ${Math.round(t.ms / 1000)} s)`);
  })();
}
