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
  else out.push('POD ATTEMPTS: none seen');
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

export async function writeReport(p: FactPack, opts: WriterOptions = {}): Promise<WriterResult> {
  const base = reportFromRules(p);
  if (!p.hasEvidence && !p.classification) return { report: base, used: 'rules', note: 'no evidence: nothing for the model to word' };
  const model = opts.model || MODEL(); const t0 = Date.now();
  try {
    const facts = factsText(p, base);
    // A small model keeps cutting "3.12" to "3.1": it never sees the version. The facts say <V> and the answer is filled in here with the real one.
    const ver = p.version ? new RegExp(`(?<![\\w.])${esc(p.version)}(?![\\w])`, 'g') : null;
    const shown = ver ? `${facts.replace(ver, '<V>')}\n(Write <V> exactly where the version belongs; never write a number for it.)` : `${facts}\n(No language version is known for this run: do not write any version number.)`;
    const raw = await ask((opts.host || HOST()).replace(/\/+$/, ''), model, `${shown}\n\nWrite the report for ${p.tool} now.`, (opts.timeoutSec ?? (Number(process.env.RCA_MODEL_SEC) || 120)) * 1000);
    let j: any; try { j = JSON.parse(ver ? raw.split('<V>').join(p.version) : raw); } catch { throw new Error('the answer was not valid JSON'); }
    const what = (Array.isArray(j.whatHappened) ? j.whatHappened : []).map((x: unknown) => str(x, 300)).filter(Boolean).slice(0, 4);
    const r = { oneLine: str(j.oneLine, 220), why: str(j.why, 700), impact: str(j.impact, 400), fix: str(j.fix, 400) };
    if (!r.oneLine || !r.why || !r.impact || !r.fix || what.length < 1) throw new Error('a field is missing or empty');
    if (/<[^>\s]{0,3}V>/i.test(`${r.oneLine} ${what.join(' ')} ${r.why} ${r.impact} ${r.fix}`)) throw new Error('a version placeholder was left in the answer');
    if (!`${r.oneLine} ${what.join(' ')} ${r.why}`.toLowerCase().includes(p.tool.toLowerCase().split(/[-_]/)[0])) throw new Error('the answer does not name the tool');
    const allowed = `${facts}\n${base.why}\n${base.fix}\n${base.impact}\n${base.oneLine}\n${base.whatHappened.join('\n')}`;
    const bad = ungrounded(`${r.oneLine} ${what.join(' ')} ${r.why} ${r.impact} ${r.fix}`, allowed);
    if (bad.length) throw new Error(`the answer contains ${bad.length} thing(s) not in the facts: ${bad.slice(0, 4).join(', ')}`);
    const report: RcaReport = { ...base, ...r, whatHappened: what, source: 'model', confidence: `${base.confidence} Wording by the local model ${model}; the evidence line, owner and facts come from the logs and rules.` };
    return { report, used: 'model', model, ms: Date.now() - t0 };
  } catch (e) { return { report: base, used: 'rules', model, ms: Date.now() - t0, note: `rule-written report used: ${e instanceof Error ? e.message : e}` }; }
}
