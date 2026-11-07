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
  'When you know enough, or the observations do not help, reply with action finish and input a JSON object: {"cause":"one or two plain sentences","proof":"Proven | Inferred | Unknown","evidence":"file:line that you saw in an Observation","owner":"Platform or Repository or Unknown","next":"what would confirm it"}.',
  'Use ONLY what the facts and the Observations show. Never invent a file, a line, an option or a number. Do not say that something is normal, usual or harmless. If the observations do not show the cause, the proof is Unknown.',
].join(NLC);

async function chat(model: string, messages: Array<{ role: string; content: string }>, host = HOST()): Promise<string> {
  const r = await fetch(`${host.replace(/\/+$/, '')}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout((Number(process.env.RCA_AGENT_SEC) || 120) * 1000),
    body: JSON.stringify({ model, messages, stream: false, format: 'json', think: false, options: { temperature: 0, num_predict: 500 } }) });
  if (!r.ok) throw new Error(`Ollama answered HTTP ${r.status}`);
  return String(((await r.json()) as any)?.message?.content || '');
}
const parse = (raw: string): { thought: string; action: string; input: string } | null => {
  try { const j = JSON.parse(raw.replace(/^[^{]*/, '').replace(/[^}]*$/, '')); const input = typeof j.input === 'string' ? j.input : JSON.stringify(j.input ?? ''); return { thought: String(j.thought || '').slice(0, 300), action: String(j.action || '').toLowerCase().trim(), input }; } catch { return null; }
};

function audit(tool: string, step: number, action: string, input: string, bytes: number) {
  try { const f = process.env.RCA_CODE_AUDIT || path.join(process.cwd(), 'results', 'rca-code-audit.jsonl'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), agent: true, tool, step, action, input: input.slice(0, 120), bytes }) + NLC); } catch { /* best effort */ }
}

/** the conclusion is kept only when it is grounded in the facts and the Observations */
export function groundConclusion(raw: string, facts: string, observations: string): { c: Conclusion | null; note: string } {
  let j: any; try { j = JSON.parse(raw); } catch { return { c: null, note: 'the final answer was not valid JSON' }; }
  const cause = String(j.cause || '').trim(); if (!cause) return { c: null, note: 'the final answer has no cause' };
  const allowed = `${facts}${NLC}${observations}`;
  const bad = ungrounded(cause, allowed); if (bad.length) return { c: null, note: `the cause names ${bad.slice(0, 3).join(', ')}, which no step showed` };
  const cl = unsupportedClaims(cause, allowed); if (cl.length) return { c: null, note: `the cause claims "${cl[0]}", which no step showed` };
  let evidence = String(j.evidence || '').trim(); let proof = ['Proven', 'Inferred', 'Unknown'].find((x) => new RegExp(`^${x}`, 'i').test(String(j.proof || ''))) || 'Unknown';
  const loc = /([\w./-]+\.[a-z]{1,4}):(\d+)/.exec(evidence);
  if (!loc || !observations.includes(loc[1].split('/').pop() as string)) { evidence = ''; if (proof === 'Proven') proof = 'Inferred'; } // an evidence line no step showed cannot make a claim Proven
  return { c: { cause: cause.slice(0, 500), proof, evidence: evidence.slice(0, 160), owner: String(j.owner || '').slice(0, 80), next: String(j.next || '').slice(0, 220) }, note: '' };
}

/** the loop itself, for any question: a label (tool name or issue name), the facts text, and the settings */
export async function agentCore(label: string, facts: string, opts: { host?: string; model?: string; system?: string } = {}): Promise<Trail | null> {
  const t0 = Date.now(); const model = opts.model || agentModel();
  const root = codeRoot(); if (!root) return null;
  if (!isLocalHost(opts.host || HOST()) && !remoteAllowed()) return { tool: label, model, steps: [], conclusion: null, note: 'blocked: the Ollama address is not on this PC (the team rule is local only)', ms: 0 };
  const ref = resolveRef(root).ref; const steps: Step[] = []; let observations = '';
  const codes = [...new Set(facts.match(/[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/g) || [])].filter((c) => c.length >= 10 && !/^(NOT_|NO_|RAN_BUT|HTTP_|AWS_)/.test(c)).slice(0, 4);
  const messages = [{ role: 'system', content: opts.system || SYSTEM }, { role: 'user', content: `${facts}${NLC}${NLC}Start. The error codes in the facts (search for them exactly as written): ${codes.join(', ') || '(none named)'}.` }];
  let conclusion: Conclusion | null = null; let note = ''; let nudged = false;
  try {
    for (let i = 0; i < MAX_STEPS(); i++) {
      const raw = await chat(model, messages, opts.host || HOST()); const s = parse(raw);
      if (!s) { note = 'the model did not answer in the required JSON'; break; }
      messages.push({ role: 'assistant', content: JSON.stringify(s) });
      // the first finish is sent back once when the model has not read any place yet: the condition that guards the failure is only visible in a read
      if (s.action === 'finish' && !nudged && !steps.some((x) => x.action === 'read') && i < MAX_STEPS() - 1) { nudged = true; steps.push({ thought: s.thought, action: 'finish', input: '(sent back)', observation: 'not accepted yet: read the place (read file:line) to see the condition that guards the failure' }); messages.push({ role: 'user', content: 'Not yet. You have not read any place in the code. Use read with a file:line from a search result, so you can see the condition that leads to the failure, then finish.' }); continue; }
      if (s.action === 'finish') { const g = groundConclusion(s.input, facts, observations); conclusion = g.c; note = g.note; steps.push({ thought: s.thought, action: 'finish', input: short(s.input, 200), observation: g.c ? 'conclusion kept (grounded)' : `conclusion not kept: ${g.note}` }); break; }
      const obs = short(act(root, ref, s.action, s.input)); observations += `${NLC}${obs}`; audit(label, i + 1, s.action, s.input, obs.length);
      steps.push({ thought: s.thought, action: s.action, input: s.input.slice(0, 120), observation: obs }); messages.push({ role: 'user', content: `Observation:${NLC}${obs}${NLC}${NLC}Next step (one JSON object).` });
      if (i === MAX_STEPS() - 2) messages.push({ role: 'user', content: 'You have one step left: reply with action finish now.' });
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
