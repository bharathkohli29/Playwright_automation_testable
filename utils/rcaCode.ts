import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { redact } from './rcaRedact';
import type { FactPack } from './rcaFacts';

/**
 * CODE EVIDENCE for the RCA Report: where the error code of a failure is raised in the platform's source code.
 * Safe by design (the team rule: nothing of our codebase leaves this PC):
 *   - opt-in: only when RCA_CODE_DIR points at a local git checkout; without it nothing happens
 *   - read-only: only `git grep` and reading files; nothing is written to the checkout
 *   - local only: no network; the snippet goes into the PDF on this PC, and the model is NOT given any code
 *   - small: at most 3 codes per report, 2 places per code, 8 lines per place; secrets, emails, addresses and ids in the lines are removed
 *   - audited: every lookup is appended to RCA_CODE_AUDIT (default results/rca-code-audit.jsonl): time, tool, code, file, line, size (never the code itself)
 */
/** role: what this place is (where the code is defined / used, or the runner of the tool); condition: the if / elif line right above the place (what has to be true to get there) */
export interface CodeRef { code: string; file: string; line: number; snippet: string; role?: string; condition?: string }

const CODE_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const IGNORE = /^(?:NOT_|NO_|RAN_BUT|EMPTY_|HTTP_|AWS_|TENANT_|CELL_ID|RUN_ID|TASK_ID|POD_|KUBE|PATH_|NODE_|LOG_|ERROR_CODE$)/;
const SKIP_PATH = /(?:^|\/)(?:tests?|test_[^/]*|alembic|migrations|node_modules|scripts|diagnostics|docs|certification|\.git)(?:\/|$)|\.md$|\.lock$/i;
const MAX_CODES = 3, MAX_PLACES = 2, CONTEXT_BEFORE = 3, CONTEXT_AFTER = 4;

/**
 * WHICH version of the platform code is read (the platform ships new builds, so "the folder as it is" can be old):
 *   RCA_CODE_REF    an exact commit, tag or branch (a build you want to analyse)   -> read exactly that
 *   RCA_CODE_BRANCH the branch the QA environment is built from (for example qa)   -> read origin/<branch>
 *   RCA_CODE_FETCH  on = run git fetch origin once before the first lookup (never merges, never touches your files)
 * With none of them the working tree is read as it is. The report says which version it used.
 */
let fetched = false;

/**
 * Full automation: RCA_CODE_TOKEN (a read-only token of the platform repo, kept in the git-ignored .env of each PC) logs git in by itself.
 * It is handed to git through environment variables (GIT_CONFIG_*), never on the command line, never in the repo address and never in .git/config,
 * and every message that could contain it is scrubbed before it is printed. Without a token git uses the person's own sign-in.
 */
export function gitAuthEnv(): Record<string, string> {
  const t = (process.env.RCA_CODE_TOKEN || '').trim().replace(/^["']|["']$/g, '');
  if (!t) return {};
  const basic = Buffer.from(`x-access-token:${t}`).toString('base64');
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` };
}
export function scrub(text: string): string {
  const t = (process.env.RCA_CODE_TOKEN || '').trim().replace(/^["']|["']$/g, ''); let out = String(text || '');
  if (t) { out = out.split(t).join('<token>'); out = out.split(Buffer.from(`x-access-token:${t}`).toString('base64')).join('<token>'); }
  return out;
}
/** the environment of git for the platform repo: the tokens of OTHER features of this script (GH_TOKEN of the dummy commit, GITHUB_TOKEN) are removed, so git uses RCA_CODE_TOKEN or the person's own sign-in only */
export function gitEnv(): NodeJS.ProcessEnv { const e: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...gitAuthEnv() }; for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete e[k]; return e; }
const NLC = String.fromCharCode(10);
export function resolveRef(root: string): { ref: string | null; label: string } {
  const explicit = (process.env.RCA_CODE_REF || '').trim(); const branch = (process.env.RCA_CODE_BRANCH ?? DEFAULT_BRANCH).trim();
  if (/^(1|yes|on|true)$/i.test((process.env.RCA_CODE_FETCH ?? 'on').trim()) && !fetched && (branch || explicit)) {
    fetched = true;
    const shallow = spawnSync('git', ['-C', root, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).stdout.trim() === 'true';
    const f = spawnSync('git', ['-C', root, 'fetch', '--quiet', ...(shallow ? ['--depth', '1'] : []), 'origin', ...(branch && !explicit ? [branch] : [])], { encoding: 'utf8', timeout: 120_000, env: gitEnv() });
    if (f.status !== 0) console.log(`  platform code: git fetch failed (${scrub(String(f.stderr || '')).trim().split(NLC)[0].slice(0, 120)}); using the commits already on this PC`);
  }
  const ref = explicit || (branch ? `origin/${branch}` : '');
  if (!ref) return { ref: null, label: 'working tree as it is on this PC' };
  const sha = spawnSync('git', ['-C', root, 'rev-parse', '--short', `${ref}^{commit}`], { encoding: 'utf8' });
  return sha.status === 0 ? { ref, label: `${ref} at ${sha.stdout.trim()}` } : { ref: null, label: `working tree (the ref ${ref} was not found)` };
}

/** the platform repo (permanent branch qa) and where the script keeps its own copy when the person has none */
export const PLATFORM_REMOTE = 'https://github.com/testable-platform/ai-testable-platform.git';
export const DEFAULT_BRANCH = 'qa';
const ownCopy = () => path.resolve(process.cwd(), '.rca-code', 'ai-testable-platform');
const isGit = (d: string) => { try { return fs.existsSync(path.join(d, '.git')); } catch { return false; } };
export function codeRoot(): string | null {
  if (/^(0|no|off|false)$/i.test((process.env.RCA_CODE || '').trim())) return null;
  const d = (process.env.RCA_CODE_DIR || '').trim().replace(/^["']|["']$/g, '');
  if (d) return isGit(d) ? d : null;
  return isGit(ownCopy()) ? ownCopy() : null;
}

/**
 * Makes the platform code available, once, with a visible result and no failure: uses the checkout the person set (RCA_CODE_DIR) or the script's own copy;
 * when there is none, clones the permanent branch (shallow, qa only) into <this repo>/.rca-code/ (git-ignored). Needs read access to the platform repo;
 * without it the reports are written without the code section. RCA_CODE=off turns the whole feature off.
 */
export function prepareCode(say: (m: string) => void = console.log): boolean {
  if (/^(0|no|off|false)$/i.test((process.env.RCA_CODE || '').trim())) { say('platform code: off (RCA_CODE=off)'); return false; }
  let root = codeRoot();
  if (!root && !(process.env.RCA_CODE_DIR || '').trim()) {
    const dir = ownCopy(); const remote = (process.env.RCA_CODE_REMOTE || PLATFORM_REMOTE).trim(); const branch = (process.env.RCA_CODE_BRANCH ?? DEFAULT_BRANCH).trim() || DEFAULT_BRANCH;
    say(`platform code: no local copy, cloning ${branch} of the platform (read only, kept in ${dir}) ...`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const c = spawnSync('git', ['clone', '--quiet', '--depth', '1', '--single-branch', '--branch', branch, remote, dir], { encoding: 'utf8', timeout: 600_000, env: gitEnv() });
    if (c.status !== 0) { say(`platform code: could not clone (${scrub(String(c.stderr || '')).trim().split(NLC)[0].slice(0, 140)}). The reports are written without the code section. Check RCA_CODE_TOKEN in .env (read access to the platform repo), or set RCA_CODE_DIR.`); return false; }
    root = codeRoot();
  } else if (!root) { say(`platform code: RCA_CODE_DIR is set but is not a git checkout (${process.env.RCA_CODE_DIR}). The reports are written without the code section.`); return false; }
  if (!root) return false;
  const v = resolveRef(root); say(`platform code: ${v.label} (new builds on ${(process.env.RCA_CODE_BRANCH ?? DEFAULT_BRANCH) || 'the working tree'} are fetched before the reports are written)`); return true;
}

/** the error codes the facts mention (upper-case words with underscores), most specific first */
export function codesOf(p: FactPack): string[] {
  const text = [p.observed, p.failureJson.join('\n'), p.serviceLines.map((s) => s.text).join('\n'), p.decisive?.reason || '', p.s3Note || ''].join('\n');
  const seen = new Map<string, number>();
  for (const m of text.matchAll(CODE_RE)) { const c = m[0]; if (c.length < 10 || IGNORE.test(c)) continue; seen.set(c, (seen.get(c) || 0) + 1); }
  return [...seen.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).map(([c]) => c);
}

function audit(entry: Record<string, unknown>) {
  try {
    const f = process.env.RCA_CODE_AUDIT || path.join(process.cwd(), 'results', 'rca-code-audit.jsonl');
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* the audit is best effort; the lookup itself never throws */ }
}

export function lookupCode(root: string, code: string, ref: string | null = null): CodeRef[] {
  const r = spawnSync('git', ['-C', root, 'grep', '-n', '-F', '-w', code, ...(ref ? [ref] : []), '--', '*.py', '*.ts', '*.js', '*.cs', '*.java', '*.go'], { encoding: 'utf8', timeout: 20_000, maxBuffer: 4_000_000 });
  if (r.status !== 0 || !r.stdout) return [];
  const hits = r.stdout.split(NLC).filter(Boolean).map((l) => { const body = ref && l.startsWith(`${ref}:`) ? l.slice(ref.length + 1) : l; const m = /^([^:]+):([0-9]+):/.exec(body); return m ? { file: m[1], line: Number(m[2]) } : null; }).filter((h): h is { file: string; line: number } => !!h && !SKIP_PATH.test(h.file));
  const out: CodeRef[] = []; const files = new Set<string>();
  for (const h of hits) {
    if (files.has(h.file)) continue; files.add(h.file);
    try {
      const text = ref ? String(spawnSync('git', ['-C', root, 'show', `${ref}:${h.file}`], { encoding: 'utf8', maxBuffer: 8_000_000 }).stdout || '') : fs.readFileSync(path.join(root, h.file), 'utf8'); const lines = text.split(NLC); const from = Math.max(0, h.line - 1 - CONTEXT_BEFORE); const to = Math.min(lines.length, h.line + CONTEXT_AFTER);
      const hitLine = lines[h.line - 1] || ''; let condition = '';
      for (let q = h.line - 2; q >= Math.max(0, h.line - 8); q--) { const m = /^\s*(?:if|elif|while|assert)\s+(.+?):?\s*$/.exec(lines[q] || ''); if (m) { condition = m[1].replace(/\s+/g, ' ').slice(0, 160); break; } }
      const role = /^\s*[A-Z][A-Z0-9_]*\s*(?::[^=]+)?=\s*["']/.test(hitLine) ? 'where it is defined' : 'where it is used';
      out.push({ code, file: h.file.replace(/\\/g, '/'), line: h.line, snippet: redact(lines.slice(from, to).map((x) => x.replace(/\s+$/, '')).join('\n')).text , role, condition });
    } catch { /* unreadable file: skip */ }
    if (out.length >= MAX_PLACES) break;
  }
  return out;
}

/** the places for one report; [] when the feature is off, the facts name no code, or the codebase does not mention it */
/** the file of the analyzer that runs THIS tool (backend/.../analyzers/<language>/<tool>_runner.py): its header and the lines that decide not-applicable / empty / status, short and redacted */
export function toolRunnerRefs(root: string, ref: string | null, tool: string): CodeRef[] {
  const snake = tool.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const ls = spawnSync('git', ['-C', root, 'ls-tree', '-r', '--name-only', ref || 'HEAD'], { encoding: 'utf8', maxBuffer: 64_000_000, timeout: 30_000 });
  const re = new RegExp(`/${snake}(_runner)?\\.(py|ts|cs|java)$`);
  const file = String(ls.stdout || '').split(NLC).find((f) => /(^|\/)analyzers\//.test(f) && !SKIP_PATH.test(f) && re.test(f)); if (!file) return [];
  const src = ref ? String(spawnSync('git', ['-C', root, 'show', `${ref}:${file}`], { encoding: 'utf8', maxBuffer: 8_000_000 }).stdout || '') : fs.readFileSync(path.join(root, file), 'utf8'); const lines = src.split(NLC);
  const head = lines.slice(0, 40).filter((l) => /^\s*(#|"""|'''|\/\/)/.test(l) || (l.trim().length > 30 && /^[A-Za-z]/.test(l.trim()) && !/^(import|from|const|let|def|class)\b/.test(l.trim()))).slice(0, 5);
  const at = lines.findIndex((l, i) => i > 2 && /not_applicable|NOT_APPLICABLE|returncode|empty|no such|status\s*=/.test(l));
  const win = at >= 0 ? lines.slice(Math.max(0, at - 2), Math.min(lines.length, at + 5)) : [];
  const snippet = redact([...head, ...(win.length ? ['...', ...win] : [])].map((x) => x.trimEnd()).join(NLC)).text; if (!snippet.trim()) return [];
  return [{ code: tool, file, line: at >= 0 ? at + 1 : 1, snippet, role: 'the runner of this tool', condition: '' }];
}

/** one plain sentence that says what the code shows (built from the places, never invented): used in the training answers so the model learns to cite the code */
export function codeSentence(refs: CodeRef[]): string {
  const c = refs.find((r) => r.condition && r.role !== 'the runner of this tool'); const r = refs.find((x) => x.role === 'the runner of this tool');
  const parts: string[] = [];
  if (c) parts.push(`In the platform code (${c.file}:${c.line}) ${c.code} is used when ${c.condition}.`);
  if (r) parts.push(`The runner of this tool is ${r.file}.`);
  return parts.join(' ');
}

export function codeEvidence(p: FactPack): CodeRef[] {
  const root = codeRoot(); if (!root) return [];
  const refs: CodeRef[] = [];
  for (const code of codesOf(p)) {
    if (new Set(refs.map((r) => r.code)).size >= MAX_CODES) break;
    const found = lookupCode(root, code, resolveRef(root).ref); refs.push(...found);
    audit({ tool: p.tool, code, version: resolveRef(root).label, places: found.map((f) => `${f.file}:${f.line}`), bytes: found.reduce((n, f) => n + f.snippet.length, 0) });
  }
  // a tool that did not run, failed or was empty: how its own runner treats its input is part of the answer
  if (!p.healthy) { const rr = toolRunnerRefs(root, resolveRef(root).ref, p.tool); if (rr.length) { refs.push(...rr); audit({ tool: p.tool, code: '(runner)', places: rr.map((f) => `${f.file}:${f.line}`), bytes: rr.reduce((n, f) => n + f.snippet.length, 0) }); } }
  return refs;
}

export type CodeStatus = 'found' | 'off' | 'no-code-in-facts' | 'not-in-codebase';
export function codeSection(p: FactPack): { status: CodeStatus; refs: CodeRef[]; version: string } {
  const root = codeRoot(); if (!root) return { status: 'off', refs: [], version: '' };
  const version = resolveRef(root).label;
  if (!codesOf(p).length && p.healthy) return { status: 'no-code-in-facts', refs: [], version };
  const refs = codeEvidence(p); return { status: refs.length ? 'found' : 'not-in-codebase', refs, version };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
export function codeHtml(p: FactPack): string {
  const refs = codeEvidence(p); if (!refs.length) return '';
  return `<h2>Where it comes from in the platform code</h2><p class="small">Read-only lookup in the local checkout; secrets and ids removed. It shows where the code is raised, it does not change the cause above.</p>${refs.map((r) => `<div class="ev"><b>${esc(r.code)}</b> · ${esc(r.file)}:${r.line}<pre style="margin:6px 0 0;white-space:pre-wrap;font-size:10.5px">${esc(r.snippet)}</pre></div>`).join('')}`;
}

/** where a TEXT (a button label, a tooltip, a message) is written in the platform code, including the frontend (.tsx / .jsx); a few lines before and after, so the condition next to it shows */
export function lookupText(root: string, text: string, ref: string | null = null, ctx = { before: 8, after: 6 }): CodeRef[] {
  const r = spawnSync('git', ['-C', root, 'grep', '-n', '-F', text, ...(ref ? [ref] : []), '--', '*.tsx', '*.jsx', '*.ts', '*.js', '*.py', '*.cs', '*.java'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4_000_000 });
  if (r.status !== 0 || !r.stdout) return [];
  const hits = r.stdout.split(NLC).filter(Boolean).map((l) => { const body = ref && l.startsWith(`${ref}:`) ? l.slice(ref.length + 1) : l; const m = /^([^:]+):([0-9]+):/.exec(body); return m ? { file: m[1], line: Number(m[2]) } : null; }).filter((h): h is { file: string; line: number } => !!h && !SKIP_PATH.test(h.file));
  const out: CodeRef[] = []; const files = new Set<string>();
  for (const h of hits) {
    if (files.has(h.file)) continue; files.add(h.file);
    const src = ref ? String(spawnSync('git', ['-C', root, 'show', `${ref}:${h.file}`], { encoding: 'utf8', maxBuffer: 8_000_000 }).stdout || '') : fs.readFileSync(path.join(root, h.file), 'utf8');
    const lines = src.split(NLC); const from = Math.max(0, h.line - 1 - ctx.before); const to = Math.min(lines.length, h.line + ctx.after);
    out.push({ code: text.slice(0, 60), file: h.file.split(String.fromCharCode(92)).join('/'), line: h.line, snippet: redact(lines.slice(from, to).map((x) => x.trimEnd()).join(NLC)).text });
    if (out.length >= MAX_PLACES) break;
  }
  return out;
}
