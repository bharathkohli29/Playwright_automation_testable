/**
 * The Thought -> Action -> Observation trail of the code analysis of one tool (see rcaAgent.ts), kept apart so the report builder can show it without
 * knowing how it was made. No imports on purpose.
 */
export interface Step { thought: string; action: string; input: string; observation: string }
export interface Candidate { cause: string; confirm: string }
/** mechanism = how the code produces the symptom; cause = WHY the condition was true (the upstream state or data); candidates = what else could be true and what would confirm it */
export interface Conclusion { cause: string; proof: string; evidence: string; owner: string; next: string; mechanism?: string; candidates?: Candidate[]; fix?: string; workaround?: string; verify?: string; rule?: string; chain?: string[] }
export interface Trail { tool: string; model: string; steps: Step[]; conclusion: Conclusion | null; note: string; ms: number }

const registry = new Map<string, Trail>();
export const setTrail = (t: Trail) => { registry.set(t.tool, t); };
export const getTrail = (tool: string): Trail | undefined => registry.get(tool);
export const clearTrails = () => registry.clear();

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** the section of the report: every step as Thought / Action / Observation, then the conclusion with its proof level */
export function trailHtml(tool: string, stepsOnly = false): string {
  const t = registry.get(tool); if (!t || (!t.steps.length && !t.conclusion)) return '';
  const rows = t.steps.map((s, i) => `<tr><td>${i + 1}</td><td><b>Thought</b><br>${esc(s.thought)}</td><td><b>Action</b><br><span class="mono">${esc(s.action)}(${esc(s.input)})</span></td><td><b>Observation</b><br><span class="mono">${esc(s.observation.slice(0, 420))}${s.observation.length > 420 ? ' …' : ''}</span></td></tr>`).join('');
  const k = t.conclusion;
  const cand = k?.candidates?.length ? `<p><b>What else could be true, and what would confirm it</b></p><table class="sm"><tr><th>Possible cause</th><th>What would confirm it</th></tr>${k.candidates.map((x) => `<tr><td>${esc(x.cause)}</td><td>${esc(x.confirm)}</td></tr>`).join('')}</table>` : '';
  const c = k
    ? `${k.rule ? `<p class="small"><b>Known pattern:</b> ${esc(k.rule)}. Written from the platform code; the lead confirms it by keeping or changing it.</p>` : ''}${k.mechanism ? `<p><b>How the blocker is produced (the code):</b> ${esc(k.mechanism)}</p>` : ''}<p><b>Why that was the case (root cause):</b> ${esc(k.cause)}</p><p><b>Proof level of the root cause:</b> ${esc(k.proof)}${k.evidence ? ` · <span class="mono">${esc(k.evidence)}</span>` : ''}</p>${k.owner ? `<p><b>Owner:</b> ${esc(k.owner)}</p>` : ''}${k.next ? `<p><b>What would confirm it:</b> ${esc(k.next)}</p>` : ''}${cand}${k.fix || k.workaround || k.verify ? `<h2>How to solve it</h2>${k.fix ? `<p><b>Fix:</b> ${esc(k.fix)}</p>` : ''}${k.workaround ? `<p><b>Right now (workaround):</b> ${esc(k.workaround)}</p>` : ''}${k.verify ? `<p><b>How to check that it is solved:</b> ${esc(k.verify)}</p>` : ''}` : ''}`
    : `<p class="small">No conclusion was kept: ${esc(t.note || 'the answer was not grounded in what the steps showed')}.</p>`;
  return `<h2>Code analysis: Thought → Action → Observation</h2><p class="small">The local model decided what to look for in the platform code; each step is a read-only look-up (${esc(t.model)}, ${Math.round(t.ms / 1000)} s).</p><table class="sm"><tr><th>#</th><th>Thought</th><th>Action</th><th>Observation</th></tr>${rows}</table>${stepsOnly ? '' : c}`;
}

/** RCA_<Name_of_the_issue>: the first words of the problem, letters, digits and underscores only (an error code stays whole), joined with underscores */
export function issueName(text: string): string {
  const words = String(text || '').split(String.fromCharCode(10))[0].replace(/[^A-Za-z0-9_ ]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 9);
  let name = words.join('_'); if (name.length > 70) name = name.slice(0, 70).replace(/_[^_]*$/, '');
  return name ? name[0].toUpperCase() + name.slice(1) : 'Issue';
}
