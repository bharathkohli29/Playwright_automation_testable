import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bugRule } from '../utils/bugRule';
import { toolsFor, type Language } from '../utils/techniqueTools';

const LANGS: Language[] = ['javascript', 'typescript', 'csharp', 'python', 'java'];
const nn = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
// every tool named anywhere in the language's metric table is "a real tool" for this test
const toolsOf = (l: Language) => [...new Set(toolsFor(l).flatMap((m) => [...m.tools, ...(m.rows || []).flatMap((r) => [...r.primary, ...(r.secondary || [])])]))];
const ctx = (l: Language, present: string[]) => ({ language: l, tools: toolsOf(l), alias: {}, has: (n: string) => present.some((p) => nn(p) === nn(n)), level: () => 'Y' as const });

for (const l of LANGS) {
  test(`${l}: primary triggered → no bug, even when the secondary is missing`, () => {
    const m = toolsFor(l).find((x) => !x.rowsOnly && x.tools.length > 1)!;
    const only = bugRule({ ...ctx(l, [m.tools[0]]), has: (n) => nn(n) === nn(m.tools[0]) });
    assert.ok(![...only.needed.values()].some((v) => v.startsWith(`${m.technique}:`)), `${m.technique} must not raise a bug`);
  });
  test(`${l}: primary missing but the secondary triggered → no bug for that metric`, () => {
    const m = toolsFor(l).find((x) => !x.rowsOnly && x.tools.length > 1)!;
    const r = bugRule(ctx(l, [m.tools[1]]));
    assert.ok(![...r.needed.values()].some((v) => v.startsWith(`${m.technique}:`)), `${m.technique} must not raise a bug`);
  });
  test(`${l}: neither triggered → bug for the primary`, () => {
    const m = toolsFor(l).find((x) => !x.rowsOnly && x.tools.length > 1)!;
    const r = bugRule(ctx(l, []));
    assert.ok(r.needed.has(m.tools[0]), `${m.tools[0]} must get a bug`);
    assert.match(r.needed.get(m.tools[0])!, /both not triggered/);
  });
}
test('excluded or optional tools never get a bug', () => {
  const l: Language = 'python'; const m = toolsFor(l).find((x) => !x.rowsOnly && x.tools.length > 1)!;
  const r = bugRule({ ...ctx(l, []), level: (t) => (t === m.tools[0] ? ('NO' as const) : ('Y' as const)) });
  assert.ok(!r.needed.has(m.tools[0]));
});
