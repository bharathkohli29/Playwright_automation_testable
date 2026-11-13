import { Language, toolsFor } from './techniqueTools';

/**
 * The common bug rule for a tool whose folder is missing (every language), per metric row of techniqueTools.ts:
 *   primary triggered (every tool of a combined primary)  -> no bug, the secondary is not needed
 *   primary not triggered, a secondary triggered           -> no bug
 *   neither triggered                                      -> bug for the primary AND the secondary
 * Tools that are N/A by design or optional on this version never make a bug here. A tool that belongs to no metric row is not judged by
 * this rule (mapped=false): the caller keeps its old behaviour for it. Secondary names that are not real tools (labels such as
 * "coverage.py + ast paths") are named in the note of the primary's bug instead of getting a bug of their own.
 */
export type Level = 'Y' | 'OPT' | 'NO';
export interface RuleCtx {
  language: Language;
  tools: readonly string[];                 // the language's real tool names
  alias: Record<string, string[]>;          // other folder names of a tool
  has: (nameOrFolder: string) => boolean;   // a folder for this tool exists in the run
  level: (tool: string) => Level;           // Y = expected, OPT = optional, NO = not expected on this version
}
const nn = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface ToolInfo { kind: string; metrics: string; verdict: 'ok' | 'bug' | 'covered' | 'unmapped'; why: string; pair: string[]; pairRan: boolean }
export interface RuleResult { mapped: Set<string>; needed: Map<string, string>; info: (tool: string, present: boolean) => ToolInfo }

export function bugRule(c: RuleCtx): RuleResult {
  const real = (name: string): string | undefined => c.tools.find((t) => nn(t) === nn(name) || (c.alias[t] || []).map(nn).includes(nn(name)));
  const mapped = new Set<string>(); const needed = new Map<string, string[]>();
  const pairs = new Map<string, Set<string>>(); // primary <-> secondary of the same metric row (the parts of a combined primary are not pairs)
  const addPair = (a: string, b: string) => { if (a === b) return; let x = pairs.get(a); if (!x) { x = new Set(); pairs.set(a, x); } x.add(b); };
  const roles = new Map<string, { p: Set<string>; s: Set<string> }>(); const covered = new Map<string, string[]>();
  const role = (t: string) => { let r = roles.get(t); if (!r) { r = { p: new Set(), s: new Set() }; roles.set(t, r); } return r; };
  const cov = (t: string, note: string) => { const a = covered.get(t) || []; if (!a.includes(note)) a.push(note); covered.set(t, a); };
  const add = (t: string, note: string) => { const a = needed.get(t) || []; if (!a.includes(note)) a.push(note); needed.set(t, a); };
  for (const m of toolsFor(c.language)) {
    const items: { parts: string[]; sec: string[]; classes?: string[] }[] = [
      ...(m.rowsOnly ? [] : [{ parts: [m.tools[0]], sec: m.tools.slice(1) }]),
      ...(m.rows || []).map((r) => ({ parts: r.primary, sec: r.secondary || [], classes: r.classes })),
    ];
    for (const it of items) {
      for (const n of it.parts) { const r = real(n); if (r) { mapped.add(r); role(r).p.add(m.technique); } }
      for (const n of it.sec) { const r = real(n); if (r) { mapped.add(r); role(r).s.add(m.technique); } }
      for (const pn of it.parts) for (const sn of it.sec) { const pr = real(pn), sr = real(sn); if (pr && sr) { addPair(pr, sr); addPair(sr, pr); } }
      const active = it.parts.filter((n) => { const r = real(n); return !r || c.level(r) === 'Y'; });
      if (it.parts.length > 0 && active.length === 0) continue; // primary N/A by design or optional
      const primaryOk = active.length > 0 && active.every((n) => c.has(real(n) || n));
      const secHit = it.sec.find((n) => c.has(real(n) || n));
      if (primaryOk || secHit) {
        // not a bug: remember why, for the tools of this metric whose folder is missing
        for (const n of it.sec) { const r = real(n); if (r && !c.has(r) && primaryOk) cov(r, `secondary for ${m.technique}: primary ${active.join(' + ')} triggered`); }
        for (const n of active) { const r = real(n) || n; if (!c.has(r) && secHit) cov(r, `primary for ${m.technique}: secondary ${real(secHit) || secHit} triggered`); }
        continue;
      }
      const where = `${m.technique}${it.classes ? ' › ' + it.classes.join(', ') : ''}`;
      const note = `${where}: primary ${active.length ? active.join(' + ') : '(no primary)'} and secondary ${it.sec.join(' / ') || '(no secondary)'} were both not triggered`;
      for (const n of active) { const r = real(n) || n; if (!c.has(r)) add(r, note); }
      for (const n of it.sec) { const r = real(n); if (r && c.level(r) === 'Y' && !c.has(r)) add(r, note); }
    }
  }
  const neededText = new Map([...needed].map(([k, a]) => [k, a.join('; ')]));
  const list = (x: Set<string>) => { const a = [...x]; return a.slice(0, 3).join(', ') + (a.length > 3 ? ` +${a.length - 3} more` : ''); };
  const info = (tool: string, present: boolean): ToolInfo => {
    const r = roles.get(tool);
    const kind = r && r.p.size && r.s.size ? 'Primary + secondary' : r && r.p.size ? 'Primary' : r && r.s.size ? 'Secondary' : 'No metric';
    const metrics = r ? [r.p.size ? `primary for ${list(r.p)}` : '', r.s.size ? `secondary for ${list(r.s)}` : ''].filter(Boolean).join('; ') : '';
    const pair = [...(pairs.get(tool) || [])]; const pairRan = pair.some((x) => c.has(x));
    if (present) return { kind, metrics, verdict: 'ok', why: '', pair, pairRan };
    if (neededText.has(tool)) return { kind, metrics, verdict: 'bug', why: neededText.get(tool)!, pair, pairRan };
    if (mapped.has(tool)) return { kind, metrics, verdict: 'covered', why: (covered.get(tool) || []).slice(0, 2).join('; '), pair, pairRan };
    return { kind, metrics, verdict: 'unmapped', why: 'in no metric, so there is no primary or secondary to cover it', pair, pairRan };
  };
  return { mapped, needed: neededText, info };
}
