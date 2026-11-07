import { codeSection } from './rcaCode';
import { FactPack } from './rcaFacts';
import { RcaReport, reportFromRules } from './rcaReport';
import { dur, ist } from './rcaProfile';

/**
 * The RCA WRITER: a local Ollama model that rewords ONE tool's rule-written report in plain English.
 *  - It gets only that tool's fact pack (never another tool's lines) and answers in a fixed JSON shape.
 *  - The evidence line, the owner, the tool and the confidence line are never taken from the model: they come from the facts.
 *  - Every path, option, id and number in the answer must already be in the facts. One that is not = the answer is thrown away.
 *  - Model off, offline, slow, bad JSON or a failed check = the rule-written report is used, and the note says why. Never throws.
 * Switch:  RCA_MODEL=off turns it off (default on)   Model: RCA_MODEL_NAME (default rca-writer, made by  ollama create rca-writer -f rca-model/Modelfile)
 * Host: OLLAMA_HOST (default http://localhost:11434)   Time limit per tool: RCA_MODEL_SEC (default 120)
 */
export const rcaModelEnabled = () => !/^(off|no|0|false)$/i.test((process.env.RCA_MODEL || '').trim()); // on unless RCA_MODEL=off; no Ollama = the rule-written report
const HOST = () => (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '').replace(/^(?!https?:\/\/)/, 'http://');
const MODEL = () => (process.env.RCA_MODEL_NAME || 'rca-writer').trim();
/** the team rule: facts and logs are only sent to an Ollama on THIS PC. Another host needs RCA_ALLOW_REMOTE_HOST=yes (a decision of the team lead). */
export const isLocalHost = (h: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(h);
export const remoteAllowed = () => /^(1|yes|on|true)$/i.test((process.env.RCA_ALLOW_REMOTE_HOST || '').trim());

/** is the local model usable? (Ollama answers and the model exists); used by the pre-flight check */
export async function rcaModelStatus(host = HOST(), name = MODEL()): Promise<{ enabled: boolean; reachable: boolean; present: boolean; name: string }> {
  const enabled = rcaModelEnabled(); if (!enabled) return { enabled, reachable: false, present: false, name };
  try {
    const res = await fetch(`${host.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(4000) }); if (!res.ok) return { enabled, reachable: false, present: false, name };
    const j: any = await res.json(); const names: string[] = (j?.models || []).map((m: any) => String(m.name || ''));
    return { enabled, reachable: true, present: names.some((n) => n === name || n === `${name}:latest` || n.split(':')[0] === name.split(':')[0] && !name.includes(':')), name };
  } catch { return { enabled, reachable: false, present: false, name }; }
}

export interface WriterOptions { model?: string; host?: string; timeoutSec?: number }
export interface WriterResult { report: RcaReport; used: 'model' | 'rules'; model?: string; ms?: number; note?: string }

const SYSTEM = [
  'You write a root-cause report for ONE tool of an automated code-analysis run. The reader is a QA engineer who is not a Kubernetes expert.',
  'Use ONLY the facts you are given. Never invent file names, paths, ids, numbers, commands, options or causes.',
  'If the facts do not show the cause, say so plainly: "the log does not show why". Do not add reasons, requirements or versions that are not written in the facts. Copy versions exactly (Python 3.12 stays 3.12).',
  'If a KNOWN CAUSE is given, it was found by a rule and is correct: explain exactly that cause in simpler words and do not change its meaning.',
  'Write short, plain sentences without contractions (write "did not", never the short form). Explain a technical term in a few words the first time you use it. No markdown, no lists inside a field.',
  'Answer with JSON only, with these fields: oneLine (at most 25 words), whatHappened (array of 2 to 4 short sentences), why (2 to 3 sentences), impact (1 to 2 sentences), fix (1 to 2 concrete sentences).',
].join('\n');

const SCHEMA = {
  type: 'object', required: ['oneLine', 'whatHappened', 'why', 'impact', 'fix'],
  properties: { oneLine: { type: 'string' }, whatHappened: { type: 'array', items: { type: 'string' } }, why: { type: 'string' }, impact: { type: 'string' }, fix: { type: 'string' } },
};

/** the facts as the model sees them (and the only text its answer may take identifiers from) */
export function factsText(p: FactPack, base: RcaReport): string {
  const out: string[] = [`TOOL: ${p.tool}${p.language ? ` (${p.language} ${p.version})` : ''}`];
  if (p.classification) out.push(`S3 RESULT: ${p.classification} ${p.observed}: ${p.s3Note}`);
  if (p.attempts.length) out.push('POD ATTEMPTS:', ...p.attempts.map((a, i) => `${i + 1}. ${a.phase}, exit code ${a.exitCode ?? '?'}, command "${a.command}"`));
  else out.push(p.captured ? 'POD ATTEMPTS: none seen' : 'POD ATTEMPTS: none (there is no live capture of this run)');
  const f = p.profile; if (f.firstStart || f.seconds.queueWait != null) out.push(`TIMING: started ${f.firstStart ? ist(f.firstStart) : 'unknown'}, finished ${f.lastEnd ? ist(f.lastEnd) : 'unknown'}, ran for ${dur(f.seconds.task ?? f.seconds.pods)}, waited in the queue ${dur(f.seconds.queueWait)}`);
  if (p.decisive?.lines.length) out.push('LOG LINES OF THE FAILED POD:', ...p.decisive.lines.map((l) => `- ${l}`));
  const sv = p.serviceLines.filter((s) => s.sameTask || !p.decisive); if (sv.length) out.push('SERVICE LINES OF THIS TASK:', ...sv.map((s) => `- ${s.text}`));
  if (p.failureJson.length) out.push('FAILURE.JSON:', ...p.failureJson.map((l) => `- ${l}`));
  if (p.rule) out.push(`KNOWN CAUSE (by a rule, correct): ${p.rule.rootCause}`, `KNOWN FIX: ${p.rule.fix}`);
  else out.push('KNOWN CAUSE: none (no rule matches).', `RULE-BASED READING (word it, and say where it is inferred or unknown): ${base.why}`, `FIX TO SUGGEST: ${base.fix}`);
  out.push(`IMPACT BASE: ${base.impact}`, `STATE OF THE TOOL: ${base.state}`);
  return out.join('\n');
}

/** identifiers a made-up answer would contain: paths, options, long ids, numbers of two or more digits */
const IDS = /(?:\/[\w.<>-]+){2,}|(?<![\w-])--?[a-z][\w-]{2,}|\b[0-9a-f]{8,}\b|\b\d+(?:\.\d+)+\b|\b\d{2,}\b/gi; // an option starts a word ("long-running" is no option); versions like 3.12
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function ungrounded(answer: string, allowed: string): string[] {
  const hay = allowed.toLowerCase(); const bad = new Set<string>();
  for (const m of answer.match(IDS) || []) {
    let t = m.replace(/[.,;:)]+$/, '').toLowerCase();
    if (t.startsWith('/')) { t = `/${t.split('/')[1]}`; if (!hay.includes(t)) bad.add(m); continue; } // a path is judged by its first folder: the facts cut long paths, the model may shorten them but not invent a new place
    if (t.length > 1 && !new RegExp(`(?<![\\w.])${esc(t)}(?![\\w])`).test(hay)) bad.add(m); // whole token: "3.1" is not "3.12"
  }
  return [...bad];
}

async function ask(host: string, model: string, user: string, ms: number): Promise<string> {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(`${host}/api/chat`, { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, think: false, format: SCHEMA, options: { temperature: 0.1, num_ctx: 4096, num_predict: 900 }, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] }) });
    if (!res.ok) throw new Error(`Ollama answered HTTP ${res.status}${res.status === 404 ? ` (is the model "${model}" created? ollama create rca-writer -f rca-model/Modelfile)` : ''}`);
    const j: any = await res.json(); const c = String(j?.message?.content || '').trim(); if (!c) throw new Error('empty answer'); return c;
  } catch (e) { throw new Error(e instanceof Error && e.name === 'AbortError' ? `no answer within ${Math.round(ms / 1000)} s` : e instanceof Error ? e.message : String(e)); }
  finally { clearTimeout(t); }
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '').slice(0, max);

/**
 * The exact prompt the model gets for one tool (also what the training data is made of: facts in, report out).
 * A small model keeps cutting "3.12" to "3.1", so it never sees the version: the facts say <V> and the answer is filled in with the real one.
 */
export function promptFor(p: FactPack, base: RcaReport): { system: string; facts: string; user: string; ver: RegExp | null } {
  // the third source: where the code of the platform raises the error code of this failure (read-only look-up, short, redacted; empty when the feature is off)
  const code = codeSection(p);
  const facts = factsText(p, base) + (code.refs.length ? `${String.fromCharCode(10)}CODE EVIDENCE (read-only look-up in the platform code, short and redacted):${String.fromCharCode(10)}${code.refs.map((c) => `- ${c.file}:${c.line}${c.role ? ` (${c.role})` : ''}${c.condition ? ` [only reached when: ${c.condition}]` : ''}${String.fromCharCode(10)}${c.snippet}`).join(String.fromCharCode(10))}` : '');
  const ver = p.version ? new RegExp("(?<![\\w.])" + esc(p.version) + "(?![\\w])", 'g') : null;
  const shown = ver ? `${facts.replace(ver, '<V>')}
(Write <V> exactly where the version belongs; never write a number for it.)` : `${facts}
(No language version is known for this run: do not write any version number.)`;
  return { system: SYSTEM, facts, user: `${shown}

Write the report for ${p.tool} now.`, ver };
}

/** words that state how common or harmless something is ("this is normal", "usually", "safe to ignore"): a root-cause report may only say what the facts say, so each of them must be in the facts */
const CLAIM_WORDS = /\b(normal|normally|usually|typically|probably|commonly|generally|often|harmless|safe to ignore|nothing to worry|not a problem)\b/gi;
export function unsupportedClaims(answer: string, facts: string): string[] {
  const found = [...new Set((answer.match(CLAIM_WORDS) || []).map((x) => x.toLowerCase()))];
  const f = facts.toLowerCase().split(/[^a-z]+/).join(' ');
  return found.filter((w) => !` ${f} `.includes(` ${w} `));
}

export async function writeReport(p: FactPack, opts: WriterOptions = {}): Promise<WriterResult> {
  const base = reportFromRules(p);
  if (!p.hasEvidence && !p.classification) return { report: base, used: 'rules', note: 'no evidence: nothing for the model to word' };
  const target = opts.host || HOST();
  if (!isLocalHost(target) && !remoteAllowed()) return { report: base, used: 'rules', note: `blocked: the Ollama address (${target}) is not on this PC; the team rule is local only (RCA_ALLOW_REMOTE_HOST=yes overrides)` };
  // the trained model (RCA_MODEL_NAME) answers first; when its answer is rejected by the checks below (or it is not installed), the stock model (RCA_MODEL_FALLBACK, default rca-writer) is asked;
  // when that is rejected too, the report is the rule-written one. So a trained model can only make the wording better, never the facts worse.
  const fb = (process.env.RCA_MODEL_FALLBACK ?? 'rca-writer').trim(); const models = [...new Set([opts.model || MODEL(), ...(fb ? [fb] : [])])]; const t00 = Date.now(); const errs: string[] = [];
  for (const model of models) {
  const t0 = Date.now();
  try {
    const { facts, user, ver } = promptFor(p, base);
    const raw = await ask((opts.host || HOST()).replace(/\/+$/, ''), model, user, (opts.timeoutSec ?? (Number(process.env.RCA_MODEL_SEC) || 120)) * 1000);
    let j: any; try { j = JSON.parse(ver ? raw.split('<V>').join(p.version) : raw); } catch { throw new Error('the answer was not valid JSON'); }
    const what = (Array.isArray(j.whatHappened) ? j.whatHappened : []).map((x: unknown) => str(x, 300)).filter(Boolean).slice(0, 4);
    const r = { oneLine: str(j.oneLine, 220), why: str(j.why, 700), impact: str(j.impact, 400), fix: str(j.fix, 400) };
    if (!r.oneLine || !r.why || !r.impact || !r.fix || what.length < 1) throw new Error('a field is missing or empty');
    if (/<[^>\s]{0,3}V>/i.test(`${r.oneLine} ${what.join(' ')} ${r.why} ${r.impact} ${r.fix}`)) throw new Error('a version placeholder was left in the answer');
    if (!`${r.oneLine} ${what.join(' ')} ${r.why}`.toLowerCase().includes(p.tool.toLowerCase().split(/[-_]/)[0])) throw new Error('the answer does not name the tool');
    const allowed = `${facts}\n${base.why}\n${base.fix}\n${base.impact}\n${base.oneLine}\n${base.whatHappened.join('\n')}`;
    const bad = ungrounded(`${r.oneLine} ${what.join(' ')} ${r.why} ${r.impact} ${r.fix}`, allowed);
    if (bad.length) throw new Error(`the answer contains ${bad.length} thing(s) not in the facts: ${bad.slice(0, 4).join(', ')}`);
    const claims = unsupportedClaims(`${r.oneLine} ${what.join(' ')} ${r.why} ${r.impact} ${r.fix}`, allowed);
    if (claims.length) throw new Error(`the answer makes a claim the facts do not make (${claims.slice(0, 3).join(', ')})`);
    const report: RcaReport = { ...base, ...r, whatHappened: what, source: 'model', confidence: `${base.confidence} Wording by the local model ${model}; the evidence line, owner and facts come from the logs and rules.` };
    return { report, used: 'model', model, ms: Date.now() - t0 };
  } catch (e) { errs.push(`${models.length > 1 ? `${model}: ` : ''}${e instanceof Error ? e.message : e}`); }
  }
  return { report: base, used: 'rules', model: models[0], ms: Date.now() - t00, note: `rule-written report used: ${errs.join('; ')}` };
}
