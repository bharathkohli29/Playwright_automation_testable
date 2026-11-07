/**
 * The Thought -> Action -> Observation trail of the code analysis of one tool (see rcaAgent.ts), kept apart so the report builder can show it without
 * knowing how it was made. No imports on purpose.
 */
export interface Step { thought: string; action: string; input: string; observation: string }
export interface Conclusion { cause: string; proof: string; evidence: string; owner: string; next: string }
export interface Trail { tool: string; model: string; steps: Step[]; conclusion: Conclusion | null; note: string; ms: number }

const registry = new Map<string, Trail>();
export const setTrail = (t: Trail) => { registry.set(t.tool, t); };
export const getTrail = (tool: string): Trail | undefined => registry.get(tool);
export const clearTrails = () => registry.clear();

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** the section of the report: every step as Thought / Action / Observation, then the conclusion with its proof level */
export function trailHtml(tool: string): string {
  const t = registry.get(tool); if (!t || (!t.steps.length && !t.conclusion)) return '';
  const rows = t.steps.map((s, i) => `<tr><td>${i + 1}</td><td><b>Thought</b><br>${esc(s.thought)}</td><td><b>Action</b><br><span class="mono">${esc(s.action)}(${esc(s.input)})</span></td><td><b>Observation</b><br><span class="mono">${esc(s.observation.slice(0, 420))}${s.observation.length > 420 ? ' …' : ''}</span></td></tr>`).join('');
  const c = t.conclusion
    ? `<p><b>Conclusion:</b> ${esc(t.conclusion.cause)}</p><p><b>Proof level:</b> ${esc(t.conclusion.proof)}${t.conclusion.evidence ? ` · <span class="mono">${esc(t.conclusion.evidence)}</span>` : ''}</p>${t.conclusion.owner ? `<p><b>Owner:</b> ${esc(t.conclusion.owner)}</p>` : ''}${t.conclusion.next ? `<p><b>What would confirm it:</b> ${esc(t.conclusion.next)}</p>` : ''}`
    : `<p class="small">No conclusion was kept: ${esc(t.note || 'the answer was not grounded in what the steps showed')}.</p>`;
  return `<h2>Code analysis: Thought → Action → Observation</h2><p class="small">The local model decided what to look for in the platform code; each step is a read-only look-up (${esc(t.model)}, ${Math.round(t.ms / 1000)} s).</p><table class="sm"><tr><th>#</th><th>Thought</th><th>Action</th><th>Observation</th></tr>${rows}</table>${c}`;
}

/** RCA_<Name_of_the_issue>: the first words of the problem, letters, digits and underscores only (an error code stays whole), joined with underscores */
export function issueName(text: string): string {
  const words = String(text || '').split(String.fromCharCode(10))[0].replace(/[^A-Za-z0-9_ ]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 9);
  let name = words.join('_'); if (name.length > 70) name = name.slice(0, 70).replace(/_[^_]*$/, '');
  return name ? name[0].toUpperCase() + name.slice(1) : 'Issue';
}
