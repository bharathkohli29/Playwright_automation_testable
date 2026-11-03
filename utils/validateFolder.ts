import * as fs from 'fs';
import * as path from 'path';
import './env';
import { s3Root } from './env';
import type { S3Reader } from './awsS3';
import { checkBranchS3 } from './s3Evidence';
import { liveDiagnosis } from './eksDiagnose';
import { writeValidationPdf, type PdfProblem } from './validationPdf';

/**
 * Validate a folder of tool results WITHOUT S3 and without running a test:
 *
 *   npm run validate -- "C:\path\to\PY_V36_UV_UV_MONO" [--repo owner/name] [--run-id <id>]
 *
 * The folder is what S3 holds for one run: one folder per tool (<tool>/<id>/0/<file>.json). The name of the folder is the branch name: its prefix
 * (PY_ JS_ TS_ CS_ JV_) and version decide the language and the tool matrix, as in a real run. The real checks run on it (the same code as the S3
 * step, through a reader that serves the local folder instead of S3). Every tool that is not PASS is listed with what its own file says and, when the
 * folder holds real evidence for it (a failure.json), the diagnosis of the known-pattern rules (eksPatterns.ts).
 * Output: results/validate_<time>/<branch name>/ with validation-report.pdf (and .md), s3-check.json and s3-evidence/.
 * Only the tool files are known here, no run id and no EKS logs, so a tool that never produced a folder can only be reported as "not triggered".
 */

/** the S3 reader interface over a local folder: keys are <base><path inside the folder> */
export class LocalReader {
  constructor(private root: string, private base: string) {}
  private local = (key: string) => path.join(this.root, ...key.slice(this.base.length).split('/').filter(Boolean));
  async check(_prefix?: string): Promise<void> { /* nothing to authenticate */ }
  async list(prefix: string): Promise<{ folders: string[]; files: string[] }> {
    const folders: string[] = []; const files: string[] = []; const dir = this.local(prefix);
    let es: fs.Dirent[] = []; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { folders, files }; }
    for (const e of es) (e.isDirectory() ? folders : files).push(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}`);
    return { folders, files };
  }
  async walk(prefix: string, maxDepth = 6, maxFolders = 200): Promise<{ exists: boolean; files: string[] }> {
    const files: string[] = []; let exists = false; let seen = 0; const queue: { p: string; d: number }[] = [{ p: prefix, d: 0 }];
    while (queue.length && seen < maxFolders) {
      const { p, d } = queue.shift()!; seen++;
      const r = await this.list(p); if (r.folders.length || r.files.length) exists = true; files.push(...r.files);
      if (d < maxDepth) r.folders.forEach((f) => queue.push({ p: f, d: d + 1 }));
    }
    return { exists, files };
  }
  async readText(key: string): Promise<string> { return fs.readFileSync(this.local(key), 'utf8'); }
  async readBytes(key: string): Promise<Uint8Array> { return fs.readFileSync(this.local(key)); }
  async readHead(key: string, bytes = 1500): Promise<string> {
    const fd = fs.openSync(this.local(key), 'r'); try { const b = Buffer.alloc(bytes); const n = fs.readSync(fd, b, 0, bytes, 0); return b.subarray(0, n).toString('utf8'); } finally { fs.closeSync(fd); }
  }
}

/** "PY_V36_UV_UV_MONO" -> "python, 3.6"; "JV_V17_..." -> "java, 17"; "TS_V20_..." -> "typescript, Node 20" (what the branch name says) */
export function languageFromName(name: string): string {
  const m = /^(PY|JS|TS|CS|JV)_V?([A-Z]*)(\d+)/i.exec(name); if (!m) return '';
  const d = m[3]; const pre = m[1].toUpperCase();
  if (pre === 'PY') return `python, ${d.length > 1 ? `${d[0]}.${d.slice(1)}` : d}`;
  if (pre === 'JV') return `java, ${d}`;
  if (pre === 'CS') return `csharp, ${m[2] ? m[2] : ''}${d}`;
  return `${pre === 'JS' ? 'javascript' : 'typescript'}, Node ${d}`;
}

export async function validateFolder(src: string, opts: { repo?: string; runId?: string } = {}): Promise<string> {
  const root = path.resolve(src);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`not a folder: ${root}`);
  const name = path.basename(root);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 13);
  const bd = path.join(__dirname, '..', 'results', `validate_${stamp}`, name); fs.mkdirSync(bd, { recursive: true });
  const ids = { run_id: opts.runId || 'local-validation', tenant_id: 'local', project_id: 'local', repository_id: 'local', branch_id: 'local', branch_name: name, commit_sha: 'local' };
  fs.writeFileSync(path.join(bd, 'run-details.json'), JSON.stringify({ ...ids, note: 'validated from a local tool folder, not a platform run' }, null, 2));
  const base = `${s3Root}${ids.tenant_id}/${ids.project_id}/${ids.repository_id}/${ids.branch_id}/${ids.branch_name}/${ids.commit_sha}/${ids.run_id}/`;
  process.env.BUG_REPORTS = 'off'; // no screenshots / PDFs / repository access: this is a validation of files
  await checkBranchS3(bd, new LocalReader(root, base) as unknown as S3Reader, opts.repo);

  let s3: any = {}; try { s3 = JSON.parse(fs.readFileSync(path.join(bd, 's3-check.json'), 'utf8')); } catch { /* none */ }
  const rows: any[] = s3.checks || []; const n = (v: string) => rows.filter((r) => r.result === v).length;
  // one entry per tool that did not pass, with what its own file says; a rule diagnosis when the folder holds real evidence (failure.json) for it
  const problems: PdfProblem[] = []; const seen = new Set<string>();
  for (const r of rows) {
    if (r.result === 'PASS') continue;
    for (const tool of String(r.tool).split(/\s*\+\s*/)) {
      if (!tool || tool === '(N/A)' || seen.has(tool)) continue; seen.add(tool);
      const note = String(r.note || '');
      const state = /^not triggered|no folder/i.test(note) ? 'NOT_TRIGGERED' : r.result === 'EMPTY' ? 'EMPTY' : 'FAILED';
      problems.push({ tool, state, note, diag: (await liveDiagnosis(tool, ids.run_id, bd, { observed: note, note })) || undefined });
    }
  }
  const md: string[] = [`# Tool validation: ${name}`, '', `Source: ${root}`, `Language from the folder name: ${languageFromName(name) || 'not recognised'}`,
    'Only the tool files were available: no run id and no EKS logs, so a tool that never produced a folder can only be reported as not triggered.', '',
    `## Result per tool row: PASS ${n('PASS')}, EMPTY ${n('EMPTY')}, FAIL ${n('FAIL')}${n('NA') ? `, N/A ${n('NA')}` : ''}`, '', '| Result | Tool | Technique | What the file says |', '|---|---|---|---|',
    ...rows.map((r) => `| ${r.result} | ${r.tool} | ${r.technique} | ${String(r.note).replace(/\|/g, '/').slice(0, 160)} |`), '',
    `## Tools that did not pass (${problems.length})`, ''];
  for (const p of problems) {
    md.push(`### ${p.tool} (${p.state})`, '', `What the file says: ${p.note}`, '');
    if (p.diag) md.push(`Diagnosis (rules): ${p.diag.verdict || ''}. ${p.diag.rootCause || ''}`, `Evidence: ${p.diag.evidence || '-'}`, `Owner: ${p.diag.owner || '-'}`, '');
  }
  fs.writeFileSync(path.join(bd, 'validation-report.md'), md.join('\n') + '\n');
  const pdf = path.join(bd, 'validation-report.pdf');
  await writeValidationPdf(pdf, { name, source: root, language: languageFromName(name), counts: { PASS: n('PASS'), EMPTY: n('EMPTY'), FAIL: n('FAIL'), NA: n('NA') }, rows, problems });
  console.log(`\n  Report (PDF): ${pdf}\n  Also: validation-report.md and s3-check.json in ${bd}`);
  return pdf;
}

if (require.main === module) {
  const a = process.argv.slice(2); const val = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const src = a.find((x, i) => !x.startsWith('--') && (i === 0 || !['--repo', '--run-id'].includes(a[i - 1])));
  if (!src) { console.log('Usage: npm run validate -- "<tool results folder>" [--repo owner/name] [--run-id <id>]'); process.exit(1); }
  validateFolder(src, { repo: val('--repo'), runId: val('--run-id') }).then(() => process.exit(0)).catch((e) => { console.log(`  ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
