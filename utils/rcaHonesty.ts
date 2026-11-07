import * as fs from 'fs';
import * as path from 'path';
import './env';
import { allTools, buildFactPack } from './rcaFacts';
import type { FactPack } from './rcaFacts';
import { reportFromRules } from './rcaReport';
import { promptFor } from './rcaWriter';
import { codeEvidence, codeSentence } from './rcaCode';

/**
 * HONESTY TRAINING SET, built from the team's own runs:   npm run rca:honesty -- <out dir> [--base <dataset dir with train.jsonl, holdout.jsonl, facts.jsonl>] [--cap <n per kind>]
 * What it teaches: say only what the facts say, and say "the evidence does not show why" when it does not. For every red tool of every saved run folder (results/merge-flow_*)
 * it builds the real prompt of the writer (facts, and the platform-code evidence when it exists) and the answer the RULES give for it (the rules only state facts, never
 * "this is normal"). The kinds, so the set is not all one thing:
 *   no-evidence     no log line, no pod, no S3 detail: the right answer is that the evidence does not show why
 *   skipped-no-log  planned and skipped by the platform, the reason is not in the evidence
 *   known-cause     a rule matched: the answer repeats that cause in plain words
 *   other           everything else that is red
 * At most --cap (default 10) cases of one kind per tool and per rule, identical prompts are kept once, every 6th case is held out. Nothing here comes from a model.
 */
const NLC = String.fromCharCode(10);
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
export type Kind = 'no-evidence' | 'skipped-no-log' | 'known-cause' | 'other';
export function kindOf(p: FactPack): Kind {
  if (p.rule?.id === 'skipped-by-platform-no-log') return 'skipped-no-log';
  if (p.rule) return 'known-cause';
  if (!p.hasEvidence && !p.serviceLines.length && !p.attempts.length) return 'no-evidence';
  return 'other';
}

export interface HCase { id: string; kind: Kind; tool: string; user: string; system: string; answer: Record<string, unknown> }
/** one case from a fact pack; null for a healthy tool (the model never words those) */
export function caseOf(p: FactPack, runTag: string): HCase | null {
  const base = reportFromRules(p); if (base.tone === 'green') return null;
  const pr = promptFor(p, base); const fix = (t: string) => (pr.ver ? t.replace(pr.ver, '<V>') : t);
  const cs = codeSentence(codeEvidence(p)); // what the code shows, built from the places (empty without code evidence)
  const answer = { oneLine: fix(cut(base.oneLine, 220)), whatHappened: base.whatHappened.slice(0, 4).map((x) => fix(cut(x, 300))), why: fix(cut(`${base.why}${cs ? ` ${cs}` : ''}`, 900)), impact: fix(cut(base.impact, 400)), fix: fix(cut(base.fix, 400)) };
  return { id: `honesty-${runTag}-${p.tool}`, kind: kindOf(p), tool: p.tool, user: pr.user, system: pr.system, answer };
}

export function collect(resultsDir: string, cap = 10): HCase[] {
  const out: HCase[] = []; const seen = new Set<string>(); const perKey = new Map<string, number>();
  let runs: string[] = []; try { runs = fs.readdirSync(resultsDir).filter((d) => /^merge-flow_/.test(d)).sort(); } catch { return out; }
  for (const run of runs) {
    let branches: string[] = []; try { branches = fs.readdirSync(path.join(resultsDir, run), { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'evidence' && !e.name.startsWith('.')).map((e) => e.name); } catch { continue; }
    for (const b of branches) {
      const dir = path.join(resultsDir, run, b); if (!fs.existsSync(path.join(dir, 's3-check.json')) && !fs.existsSync(path.join(dir, 'eks-live'))) continue;
      let tools: string[] = []; try { tools = allTools(dir); } catch { continue; }
      for (const t of tools) {
        let p: FactPack; try { p = buildFactPack(dir, t); } catch { continue; }
        const c = caseOf(p, `${run.replace('merge-flow_', '')}-${b}`); if (!c || seen.has(c.user)) continue;
        const key = `${c.kind}|${t}|${p.rule?.id || ''}`; const n = perKey.get(key) || 0; if (n >= Math.max(1, Math.floor(cap / 4))) continue; // a tool of one kind appears a few times, not hundreds
        const kn = [...perKey.entries()].filter(([k]) => k.startsWith(`${c.kind}|`)).reduce((s, [, v]) => s + v, 0); if (kn >= cap * 8) continue;
        perKey.set(key, n + 1); seen.add(c.user); out.push(c);
      }
    }
  }
  return out;
}

const line = (c: HCase, sys = c.system) => ({ id: c.id, messages: [{ role: 'system', content: sys }, { role: 'user', content: c.user }, { role: 'assistant', content: JSON.stringify(c.answer) }] });
const L = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join(NLC) + NLC;
const readJsonl = (f: string) => { try { return fs.readFileSync(f, 'utf8').split(NLC).filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

if (require.main === module) {
  const a = process.argv.slice(2); const flag = (f: string) => { const i = a.indexOf(f); return i >= 0 ? a.splice(i, 2)[1] : ''; };
  const base = flag('--base'); const cap = Number(flag('--cap')) || 10; const out = a[0];
  if (!out) { console.log('Usage: npm run rca:honesty -- <out dir> [--base <dataset dir>] [--cap <n>]'); process.exit(1); }
  const cases = collect(path.resolve('results'), cap); fs.mkdirSync(out, { recursive: true });
  const hold = (i: number) => i % 6 === 5; const byKind: Record<string, number> = {}; cases.forEach((c) => { byKind[c.kind] = (byKind[c.kind] || 0) + 1; });
  fs.writeFileSync(path.join(out, 'train.jsonl'), L([...readJsonl(path.join(base || '', 'train.jsonl')), ...cases.filter((_, i) => !hold(i)).map((c) => line(c))]));
  fs.writeFileSync(path.join(out, 'holdout.jsonl'), L([...readJsonl(path.join(base || '', 'holdout.jsonl')), ...cases.filter((_, i) => hold(i)).map((c) => line(c))]));
  fs.writeFileSync(path.join(out, 'facts.jsonl'), L([...readJsonl(path.join(base || '', 'facts.jsonl')), ...cases.map((c) => ({ id: c.id, tool: c.tool, version: '', system: c.system, user: c.user }))]));
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ cases: cases.length, byKind, heldOut: cases.filter((_, i) => hold(i)).length, base: base || null }, null, 2));
  console.log(`${cases.length} honesty case(s): ${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(', ')}; ${cases.filter((_, i) => hold(i)).length} held out${base ? `; added to the base set of ${base}` : ''}`);
}
