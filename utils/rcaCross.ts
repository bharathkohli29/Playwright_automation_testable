import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import './env'; // loads .env
import { redact, Known } from './rcaRedact';
import { CLASSES, GoldCase, GoldFinal } from './rcaGold';
import { isLocalHost, remoteAllowed } from './rcaWriter';

/**
 * CROSS-CHECK: do other AIs read the same logs the same way as the people did?  Uses the gold set (see rcaGold.ts) once people labelled it.
 *   npm run rca:cross -- "<gold dir>" --ollama "name=model" [--ollama "name2=model2" ...]
 *       every model gets the SAME redacted facts and must pick the cause class from the list, copy ONE line that proves it, and name the owner.
 *       Printed per model: cause class correct, evidence line really in the facts, owner correct, seconds. The pipeline's own rules are a row too.
 *       Every prompt and answer is appended to <gold dir>/cross-audit.jsonl (the audit trail).
 *   npm run rca:cross -- "<gold dir>" --export-redacted <file.jsonl> --approved-by "<name of the team lead>"
 *       writes the redacted prompts for an EXTERNAL AI. Refused without --approved-by. Never send gold-index.json, gold-*.xlsx or a redaction map.
 * Only an Ollama on THIS PC is used (the team rule); another host needs RCA_ALLOW_REMOTE_HOST=yes.
 */
const OWNERS = ['platform', 'repository', 'nobody', 'unknown'] as const;
export const SYSTEM = [
  'You check the logs of one tool of an automated code-analysis run and decide the root-cause class.',
  'Use ONLY the facts. Pick cause_class from the list. Copy exactly ONE line from the facts that proves your choice into evidence_line (empty if no line proves anything).',
  'owner: platform when the platform itself is at fault, repository when the customer repository is at fault, nobody when nothing is wrong, unknown when the facts do not show it.',
  'If the facts do not show the cause, choose a "...-unknown" or "not-triggered-inferred" class. Never invent a cause. Answer with JSON only.',
].join('\n');
const SCHEMA = { type: 'object', required: ['cause_class', 'evidence_line', 'owner'], properties: { cause_class: { type: 'string', enum: CLASSES.map((c) => c[0]) }, evidence_line: { type: 'string' }, owner: { type: 'string', enum: [...OWNERS] } } };

export function buildPrompt(c: GoldCase): { system: string; user: string; facts: string } {
  const known: Known[] = [{ label: 'branch', value: c.branch }]; const facts = redact(c.facts, known).text;
  const user = `CLASSES:\n${CLASSES.map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n\nFACTS:\n${facts}\n\nAnswer with JSON: cause_class, evidence_line, owner.`;
  return { system: SYSTEM, user, facts };
}
export const ownerKind = (s: string): string => (/platform/i.test(s) ? 'platform' : /repositor|customer/i.test(s) ? 'repository' : /none|nobody|nothing/i.test(s) ? 'nobody' : 'unknown');

export interface CrossRow { source: string; n: number; cls: number; evidence: number; owner: number; seconds: number; failed: number }
async function ask(host: string, model: string, p: { system: string; user: string }): Promise<{ json: any; raw: string; sec: number }> {
  if (!isLocalHost(host) && !remoteAllowed()) throw new Error(`blocked: ${host} is not on this PC (local only; RCA_ALLOW_REMOTE_HOST=yes overrides)`);
  const t0 = Date.now(); const res = await fetch(`${host.replace(/\/+$/, '')}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({ model, stream: false, think: false, format: SCHEMA, options: { temperature: 0, num_ctx: 4096, num_predict: 400 }, messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }] }) });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status} for ${model}`); const raw = String(((await res.json()) as any)?.message?.content || ''); let json: any = null; try { json = JSON.parse(raw); } catch { /* counted as failed */ }
  return { json, raw, sec: (Date.now() - t0) / 1000 };
}

export async function crossCheck(dir: string, sources: { name: string; model: string }[], host = (process.env.OLLAMA_HOST || 'http://localhost:11434')): Promise<CrossRow[]> {
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'gold-index.json'), 'utf8')) as { cases: GoldCase[] }; const final = JSON.parse(fs.readFileSync(path.join(dir, 'gold-final.json'), 'utf8')) as Record<string, GoldFinal>;
  const cases = index.cases.filter((c) => final[c.id]); const audit = path.join(dir, 'cross-audit.jsonl'); const rows: CrossRow[] = [];
  rows.push({ source: 'pipeline rules (baseline)', n: cases.length, cls: cases.filter((c) => c.cls === final[c.id].cls).length, evidence: 0, owner: cases.filter((c) => ownerKind(c.owner) === ownerKind(final[c.id].owner)).length, seconds: 0, failed: 0 });
  for (const s of sources) {
    const r: CrossRow = { source: s.name, n: cases.length, cls: 0, evidence: 0, owner: 0, seconds: 0, failed: 0 }; let evN = 0;
    for (const c of cases) {
      const p = buildPrompt(c); let a: Awaited<ReturnType<typeof ask>> | null = null; let err = '';
      try { a = await ask(host, s.model, p); } catch (e) { err = e instanceof Error ? e.message : String(e); }
      fs.appendFileSync(audit, JSON.stringify({ at: new Date().toISOString(), source: s.name, model: s.model, id: c.id, prompt: p.user, answer: a?.raw ?? '', error: err }) + '\n');
      if (!a?.json) { r.failed++; continue; } r.seconds += a.sec; const g = final[c.id];
      if (a.json.cause_class === g.cls) r.cls++; if (g.evidenceOk !== 'NONE') { evN++; const line = String(a.json.evidence_line || '').replace(/^-\s*/, '').trim(); if (line && p.facts.includes(line)) r.evidence++; }
      if (a.json.owner === ownerKind(g.owner)) r.owner++;
    }
    r.evidence = evN ? r.evidence / evN : 0; rows.push(r);
  }
  return rows;
}

export function exportRedacted(dir: string, file: string, approvedBy: string): number {
  if (!approvedBy.trim()) throw new Error('refused: an export for an external AI needs --approved-by "<name of the team lead>"');
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'gold-index.json'), 'utf8')) as { cases: GoldCase[] };
  fs.writeFileSync(file, index.cases.map((c) => { const p = buildPrompt(c); return JSON.stringify({ case: `case-${index.cases.indexOf(c) + 1}`, system: p.system, user: p.user }); }).join('\n') + '\n');
  fs.writeFileSync(`${file}.approval.txt`, `Exported ${index.cases.length} redacted case(s) on ${new Date().toISOString()}, approved by ${approvedBy.trim()}. Contents: facts with ids, names, paths and tokens removed; no source code; the case numbers do not map to real ids.\n`);
  return index.cases.length;
}

export interface Opinion { pipeline: string; models: Record<string, string>; disagree: string[] }
/**
 * SECOND OPINION before anyone has labelled: does each model read the logs like the pipeline does? A case where a model differs is one to look at FIRST.
 * (This measures agreement with the pipeline, not accuracy: accuracy needs the people's labels.) Writes <dir>/cross-opinions.json.
 */
export async function agreement(dir: string, sources: { name: string; model: string }[], host = (process.env.OLLAMA_HOST || 'http://localhost:11434')): Promise<{ rows: { source: string; n: number; same: number; failed: number }[]; opinions: Record<string, Opinion> }> {
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'gold-index.json'), 'utf8')) as { cases: GoldCase[] }; const audit = path.join(dir, 'cross-audit.jsonl');
  const opinions: Record<string, Opinion> = {}; for (const c of index.cases) opinions[c.id] = { pipeline: c.cls, models: {}, disagree: [] }; const rows: { source: string; n: number; same: number; failed: number }[] = [];
  for (const s of sources) {
    const r = { source: s.name, n: index.cases.length, same: 0, failed: 0 };
    for (const c of index.cases) {
      const p = buildPrompt(c); let a: Awaited<ReturnType<typeof ask>> | null = null; let err = ''; try { a = await ask(host, s.model, p); } catch (e) { err = e instanceof Error ? e.message : String(e); }
      fs.appendFileSync(audit, JSON.stringify({ at: new Date().toISOString(), source: s.name, model: s.model, id: c.id, prompt: p.user, answer: a?.raw ?? '', error: err }) + '\n');
      if (!a?.json) { r.failed++; continue; } const cls = String(a.json.cause_class || ''); opinions[c.id].models[s.name] = cls; if (cls === c.cls) r.same++; else opinions[c.id].disagree.push(s.name);
    }
    rows.push(r);
  }
  fs.writeFileSync(path.join(dir, 'cross-opinions.json'), JSON.stringify(opinions, null, 1)); return { rows, opinions };
}

/** writes the second opinion into a new last column of every gold sheet; cases where a model differs are marked amber and start with LOOK FIRST */
export async function annotate(dir: string): Promise<number> {
  const op = JSON.parse(fs.readFileSync(path.join(dir, 'cross-opinions.json'), 'utf8')) as Record<string, Opinion>; let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => /^gold-.*\.xlsx$/.test(x))) {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path.join(dir, f)); const ws = wb.getWorksheet('Gold'); if (!ws) continue;
    let col = ws.getRow(1).cellCount + 1; ws.getRow(1).eachCell((c, i) => { if (c.text === 'second opinion (local models)') col = i; }); // running it again rewrites the same column
    const h = ws.getCell(1, col); h.value = 'second opinion (local models)'; h.font = { bold: true, color: { argb: 'FFFFFFFF' } }; h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } }; ws.getColumn(col).width = 70;
    ws.eachRow((row, i) => { if (i === 1) return; const o = op[row.getCell(1).text]; if (!o) return; const said = Object.entries(o.models).map(([m, c]) => `${m}: ${c}`).join('; ');
      const total = Object.keys(o.models).length; const strong = o.disagree.length > 0 && o.disagree.length >= Math.max(2, Math.ceil((2 * total) / 3)); // most models differ: the flag that matters
      const cell = row.getCell(col); cell.value = o.disagree.length ? `LOOK FIRST (${o.disagree.length} of ${total} models differ${strong ? ': most of them' : ''}). ${said}` : `models agree with the pipeline. ${said}`; cell.alignment = { wrapText: true, vertical: 'top' };
      if (o.disagree.length) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: strong ? 'FFF4B183' : 'FFFAEEDA' } }; n++; });
    await wb.xlsx.writeFile(path.join(dir, f));
  }
  return n;
}

if (require.main === module) {
  (async () => {
    const [dir, ...rest] = process.argv.slice(2); const all = (f: string) => { const out: string[] = []; for (let i = rest.indexOf(f); i >= 0; i = rest.indexOf(f)) out.push(String(rest.splice(i, 2)[1])); return out; };
    const oll = all('--ollama').map((s) => { const i = s.indexOf('='); return { name: s.slice(0, i), model: s.slice(i + 1) }; }); const exp = all('--export-redacted')[0]; const by = all('--approved-by')[0] || '';
    if (!dir || !fs.existsSync(path.join(dir, 'gold-index.json'))) { console.log('Usage:\n  npm run rca:cross -- "<gold dir>" --ollama "name=model" [...]\n  npm run rca:cross -- "<gold dir>" --export-redacted <file.jsonl> --approved-by "<name>"'); process.exit(1); }
    if (exp) { try { console.log(`${exportRedacted(dir, path.resolve(exp), by)} redacted case(s) written to ${path.resolve(exp)} (approval note next to it)`); } catch (e) { console.log(e instanceof Error ? e.message : e); process.exit(1); } return; }
    if (rest.includes('--annotate')) { console.log(`${await annotate(dir)} row(s) annotated`); return; }
    if (rest.includes('--vs-pipeline')) {
      if (!oll.length) { console.log('give at least one --ollama "name=model"'); process.exit(1); }
      const r = await agreement(dir, oll); console.log('source'.padEnd(30) + 'cases  same as pipeline  failed'); for (const x of r.rows) console.log(x.source.padEnd(30) + `${String(x.n).padStart(5)}  ${`${Math.round((100 * x.same) / x.n)}%`.padStart(16)}  ${x.failed}`);
      const flagged = Object.values(r.opinions).filter((o) => o.disagree.length).length; console.log(`${flagged} of ${Object.keys(r.opinions).length} case(s) have a model that reads them differently: LOOK FIRST. ${await annotate(dir)} sheet row(s) annotated.`); return;
    }
    if (!oll.length) { console.log('give at least one --ollama "name=model"'); process.exit(1); }
    const rows = await crossCheck(dir, oll); const pc = (a: number, n: number) => `${n ? Math.round((100 * a) / n) : 0}%`.padStart(5);
    console.log('source'.padEnd(30) + 'cases  cause   evidence  owner   sec/case  failed');
    for (const r of rows) console.log(r.source.padEnd(30) + `${String(r.n).padStart(5)}  ${pc(r.cls, r.n)}  ${(r.source.startsWith('pipeline') ? '    -' : `${Math.round(r.evidence * 100)}%`.padStart(5))}    ${pc(r.owner, r.n)}  ${(r.n - r.failed ? (r.seconds / (r.n - r.failed)).toFixed(1) : '-').toString().padStart(8)}  ${r.failed}`);
    console.log(`audit trail: ${path.join(dir, 'cross-audit.jsonl')}`);
  })();
}
