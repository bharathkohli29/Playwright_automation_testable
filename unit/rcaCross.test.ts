import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import { exportGold } from '../utils/rcaGold';
import { crossCheck, exportRedacted, buildPrompt, ownerKind } from '../utils/rcaCross';
import { makeBranch } from './fixtures';

/** a fake Ollama that answers by tool: radon right, pip-audit right (with a line copied from the facts), cosmic-ray WRONG */
async function fakeModel() {
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)).on('end', () => {
    const user: string = (JSON.parse(b).messages || []).find((m: any) => m.role === 'user')?.content || ''; const tool = (/^TOOL: (\S+)/m.exec(user) || [])[1];
    const a = tool === 'radon' ? { cause_class: 'ok', evidence_line: '', owner: 'nobody' } : tool === 'pip-audit' ? { cause_class: 'pip-audit-env-setup-failed', evidence_line: 'Failed to upgrade `pip`', owner: 'platform' } : { cause_class: 'failed-cause-unknown', evidence_line: 'a line that is not in the facts', owner: 'unknown' };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: { content: JSON.stringify(a) } })); }); });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok())); return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close() };
}
async function setup() {
  const d = makeBranch('PY_SECRET_BRANCH'); const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-')); await exportGold([d], out, ['A'], { max: 10 });
  const idx = JSON.parse(fs.readFileSync(path.join(out, 'gold-index.json'), 'utf8')); const final: Record<string, any> = {};
  for (const c of idx.cases) final[c.id] = { cls: c.tool === 'radon' ? 'ok' : c.tool === 'pip-audit' ? 'pip-audit-env-setup-failed' : 'unsupported-cli-option', owner: c.owner, evidenceOk: 'YES' };
  fs.writeFileSync(path.join(out, 'gold-final.json'), JSON.stringify(final)); return out;
}

test('the same redacted facts go to every model; accuracy is scored against the people, and every prompt and answer is logged', async () => {
  const out = await setup(); const m = await fakeModel();
  try {
    const rows = await crossCheck(out, [{ name: 'fake', model: 'x' }], m.url); const base = rows[0]; const fake = rows[1];
    assert.equal(base.source, 'pipeline rules (baseline)'); assert.equal(base.cls, 3); // the rules agree with the people on all 3 cases
    assert.equal(fake.n, 3); assert.equal(fake.cls, 2); assert.equal(fake.failed, 0); assert.ok(Math.abs(fake.evidence - 1 / 3) < 1e-9); // only pip-audit's line is really in the facts (cosmic-ray quotes a made-up line, radon quotes none)
    const audit = fs.readFileSync(path.join(out, 'cross-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); assert.equal(audit.length, 3);
    for (const a of audit) { assert.ok(!a.prompt.includes('PY_SECRET_BRANCH')); assert.match(a.prompt, /FACTS:/); } assert.ok(audit.some((a) => a.prompt.includes('<BRANCH-1>')) || audit.every((a) => !a.prompt.includes('PY_SECRET')));
  } finally { m.close(); }
});

test('a host that is not on this PC is blocked: nothing is sent and every case counts as failed', async () => {
  const out = await setup(); const rows = await crossCheck(out, [{ name: 'remote', model: 'x' }], 'http://10.255.255.1:11434');
  assert.equal(rows[1].failed, 3); assert.equal(rows[1].cls, 0); const audit = fs.readFileSync(path.join(out, 'cross-audit.jsonl'), 'utf8'); assert.match(audit, /blocked/);
});

test('the export for an external AI is refused without an approver; with one it is redacted and leaves an approval note', async () => {
  const out = await setup(); const f = path.join(out, 'external.jsonl');
  assert.throws(() => exportRedacted(out, f, ''), /refused/); assert.ok(!fs.existsSync(f));
  assert.equal(exportRedacted(out, f, 'Team lead'), 3); const text = fs.readFileSync(f, 'utf8'); assert.ok(!text.includes('PY_SECRET_BRANCH')); assert.ok(!text.includes('abcdef12')); assert.match(text, /"case":"case-1"/);
  assert.match(fs.readFileSync(`${f}.approval.txt`, 'utf8'), /approved by Team lead/);
});

test('the prompt lists the classes and the facts, and the owner of the people is mapped to a coarse owner', () => {
  const d = makeBranch(); const idx = { id: 'x', branch: 'PY_SECRET_BRANCH', tool: 'radon', language: 'python', layout: 'GREEN', cls: 'ok', evidence: '', owner: 'None', facts: 'TOOL: radon (python 3.12)\nSTATE: TRIGGERED', assigned: [] };
  const p = buildPrompt(idx as any); assert.match(p.user, /- ok: Triggered, result fine/); assert.match(p.user, /FACTS:\nTOOL: radon/); void d;
  assert.deepEqual(['Platform (runner)', 'None (expected behaviour)', 'the customer repository', 'Not decided'].map(ownerKind), ['platform', 'nobody', 'repository', 'unknown']);
});

test('second opinion before any labels: models are compared with the pipeline, and the sheet marks the cases to look at first', async () => {
  const out = await setup(); const m = await fakeModel();
  try {
    const { agreement, annotate } = await import('../utils/rcaCross'); const r = await agreement(out, [{ name: 'fake', model: 'x' }], m.url);
    assert.equal(r.rows[0].same, 2); assert.equal(r.rows[0].failed, 0); const flagged = Object.entries(r.opinions).filter(([, o]) => o.disagree.length); assert.equal(flagged.length, 1); assert.match(flagged[0][0], /cosmic-ray/);
    assert.equal(await annotate(out), 3);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path.join(out, 'gold-A.xlsx')); const ws = wb.getWorksheet('Gold')!; const col = ws.getRow(1).cellCount; assert.equal(ws.getCell(1, col).text, 'second opinion (local models)');
    const texts: Record<string, string> = {}; ws.eachRow((row, i) => { if (i > 1) texts[row.getCell(1).text] = row.getCell(col).text; });
    assert.ok(Object.entries(texts).find(([id]) => id.endsWith('cosmic-ray'))![1].startsWith('LOOK FIRST')); assert.ok(Object.entries(texts).find(([id]) => id.endsWith('radon'))![1].startsWith('models agree'));
  } finally { m.close(); }
});
