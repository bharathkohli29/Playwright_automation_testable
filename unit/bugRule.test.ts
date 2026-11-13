import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bugRule } from '../utils/bugRule';
import { toolsFor, type Language } from '../utils/techniqueTools';

const LANGS: Language[] = ['javascript', 'typescript', 'csharp', 'python', 'java'];
const nn = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
// every tool named anywhere in the language's metric table is "a real tool" for this test
const toolsOf = (l: Language) => [...new Set(toolsFor(l).flatMap((m) => [...m.tools, ...(m.rows || []).flatMap((r) => [...r.primary, ...(r.secondary || [])])]))];
const ctx = (l: Language, present: string[]) => ({ language: l, tools: toolsOf(l), alias: {}, has: (n: string) => present.some((p) => nn(p) === nn(n)), level: () => 'Y' as const });

/** a metric row with ONE primary tool and a secondary tool of its own (a technique-level entry, or one classification row), and the text its bug note would start with */
function pick(l: Language): { where: string; primary: string; secondary: string } {
  for (const m of toolsFor(l)) {
    const items = [...(m.rowsOnly ? [] : [{ parts: [m.tools[0]], sec: m.tools.slice(1), classes: undefined as string[] | undefined }]), ...(m.rows || []).map((r) => ({ parts: r.primary, sec: r.secondary || [], classes: r.classes }))];
    for (const it of items) {
      if (it.parts.length !== 1 || !it.sec.length || it.sec.some((s) => nn(s) === nn(it.parts[0]))) continue;
      // the pair must be this row's own: no other row of the language may name the same tools in another role, or the answer could come from there
      const where = `${m.technique}${it.classes ? ' › ' + it.classes.join(', ') : ''}`;
      return { where, primary: it.parts[0], secondary: it.sec[0] };
    }
  }
  throw new Error(`${l}: no metric row with a primary and a secondary tool`);
}
const bugFor = (r: ReturnType<typeof bugRule>, where: string) => [...r.needed.values()].some((v) => v.includes(`${where}:`));

for (const l of LANGS) {
  test(`${l}: primary triggered → no bug, even when the secondary is missing`, () => {
    const p = pick(l); const r = bugRule(ctx(l, [p.primary]));
    assert.ok(!bugFor(r, p.where), `${p.where} must not raise a bug`);
  });
  test(`${l}: primary missing but the secondary triggered → no bug for that metric`, () => {
    const p = pick(l); const r = bugRule(ctx(l, [p.secondary]));
    assert.ok(!bugFor(r, p.where), `${p.where} must not raise a bug`);
  });
  test(`${l}: neither triggered → bug for the primary`, () => {
    const p = pick(l); const r = bugRule(ctx(l, []));
    assert.ok(r.needed.has(p.primary), `${p.primary} must get a bug`);
    assert.match(r.needed.get(p.primary)!, /both not triggered/);
  });
}
test('excluded or optional tools never get a bug', () => {
  const l: Language = 'python'; const p = pick(l);
  const r = bugRule({ ...ctx(l, []), level: (t) => (nn(t) === nn(p.primary) ? ('NO' as const) : ('Y' as const)) });
  assert.ok(!r.needed.has(p.primary));
});

test('JavaScript and TypeScript follow the platform: co-providers without a primary, and no tool for a leaf the platform has none for', () => {
  // JS SAST "Input Validation Testing": the platform declares no primary; eslint-security and semgrep are co-providers, either one is enough
  const js = bugRule(ctx('javascript', ['semgrep']));
  assert.ok(![...js.needed.values()].some((v) => v.includes('Static Vulnerabilities (SAST) › Input Validation Testing:')));
  // JS Branch Coverage: only "Edge Case Detection" has a JavaScript tool (js-boundary-decisions); no other branch leaf may ask for one
  const branch = toolsFor('javascript').find((m) => m.technique === 'Branch Coverage')!;
  assert.deepEqual((branch.rows || []).flatMap((r) => r.classes), ['Edge Case Detection']);
  // TS Path Coverage is read from ts-path-coverage; the old stand-ins (monocart, mewt, opentelemetry …) are gone
  const tsTools = toolsOf('typescript'); for (const old of ['mewt', 'monocart-coverage-reports', 'opentelemetry', 'tracegraph', 'red-dragon', 'bearer-cli', 'sigstore-cli']) assert.ok(!tsTools.includes(old), `${old} is no longer mapped for TypeScript`);
  const jsTools = toolsOf('javascript'); for (const old of ['debtmap', 'cccc', 'dolos', 'opengrep', 'trivy', 'gutcheck', 'codeql', 'knip']) assert.ok(!jsTools.includes(old), `${old} is no longer mapped for JavaScript`);
});
