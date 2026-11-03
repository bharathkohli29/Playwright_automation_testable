import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as readline from 'readline/promises';
import './env';
import { liveEvidence, rcaInput, askRcaModel, type LiveEvidence } from './eksDiagnose';

/**
 * Teach the QA EKS model from real runs.  Chatting with a model does not change it; its answers have to become TRAINING EXAMPLES and the model
 * has to be retrained (Colab notebook in qa-eks-mentor/training, then register_model.py). This tool makes the examples:
 *
 *   npm run teach -- seed   <branch folder ...> | --all     writes the cases the rules settle with certainty (readiness block, planning exclusion,
 *                                                           handler / failure.json failure, no evidence at all, tool with output)
 *   npm run teach -- review <branch folder ...> | --all     the cases the rules cannot settle: shows the model's answer, you accept it, type the
 *                                                           right one, or skip (answers are checked against the prompt's rules before they are saved)
 *   npm run teach -- stats                                  what the dataset holds, against the mix RCA_PROMPT.md asks for
 *
 * The input block is built by the same function as in production (rcaInput), the system prompt and the allowed verdicts are read from
 * qa-eks-mentor/RCA_PROMPT.md. About one case in six goes to training/holdout.jsonl (chosen by a hash of the input, so a case is never in both);
 * register_model.py tests a new model on the holdout and never trains on it.
 */
const MENTOR = path.join(__dirname, '..', 'qa-eks-mentor');
const TRAIN = path.join(MENTOR, 'training');
const DATASET = path.join(TRAIN, 'dataset.jsonl');
const HOLDOUT = path.join(TRAIN, 'holdout.jsonl');
const BANNED = ['probably', 'maybe', 'might', 'could be', 'likely', 'possibly', 'perhaps', 'transient', 'customer repo'];
const ID_LIKE = /[A-Za-z0-9_.]+(?:-[A-Za-z0-9_.]+){2,}/g; // pod names, run ids, service names ...
const rj = (p: string): any => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const LANGS = ['python', 'javascript', 'typescript', 'csharp', 'java'];

export interface Prompt { system: string; verdicts: string[] }
/** the system prompt (section 1 of RCA_PROMPT.md) and the verdicts its template allows: the single source of truth */
export function loadPrompt(): Prompt {
  const md = fs.readFileSync(path.join(MENTOR, 'RCA_PROMPT.md'), 'utf8').replace(/\r/g, '');
  const h = md.indexOf('## 1. System prompt'); const a = md.indexOf('```\n', h) + 4; const b = md.indexOf('\n```', a);
  const system = md.slice(a, b);
  const line = system.split('\n').find((l) => l.startsWith('Verdict: <')) || '';
  const verdicts = line.replace('Verdict: <', '').replace(/>\s*$/, '').split('|').map((s) => s.trim()).filter(Boolean);
  return { system, verdicts };
}

export interface Case { tool: string; state: string; input: string; ev: LiveEvidence; runId: string; folder: string }

const emptyEv = (tool: string): LiveEvidence => ({ tool, lines: [], sources: [], signature: '', podReason: '' });

/** every tool of a branch folder that has something to explain (or an output, for the "No RCA needed" examples), in the production input format */
export function casesOf(branchDir: string): Case[] {
  const rd = rj(path.join(branchDir, 'run-details.json')); const s3 = rj(path.join(branchDir, 's3-check.json'));
  const runId = String(rd?.run_id || s3?.run_id || ''); const out: Case[] = []; if (!s3 || !runId) return out;
  for (const k of LANGS) {
    const b = s3[k]; if (!b?.version) continue;
    for (const t of (b.tools || []) as { tool: string; state: string; note: string }[]) {
      if (!['NOT_TRIGGERED', 'EMPTY', 'FAILED', 'OUTPUT'].includes(t.state)) continue;
      const ev = (t.state === 'OUTPUT' ? null : liveEvidence(branchDir, t.tool)) || emptyEv(t.tool);
      const s3text = t.state === 'NOT_TRIGGERED' ? 'no folder' : String(t.note || '').slice(0, 300);
      out.push({ tool: t.tool, state: t.state, ev, runId, folder: branchDir, input: rcaInput(t.tool, runId, branchDir, ev, { state: t.state, s3: s3text }) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- answers the rules settle
interface Svc { time: string; level: string; service: string; message: string; f: Record<string, string> }
function parseSvc(line: string): Svc | null {
  const m = /^(\d\d:\d\d:\d\d) (\w+) ([^:]+): (\S+) \((.*)\)$/.exec(line); if (!m) return null;
  const f: Record<string, string> = {}; for (const x of m[5].matchAll(/(\w+)=(\S+)/g)) f[x[1]] = x[2];
  return { time: m[1], level: m[2], service: m[3], message: m[4], f };
}
const evLine = (s: Svc) => `${s.time} ${s.level} ${s.service}: ${s.message} (${['tool_name', 'reason', 'skip_reason', 'readiness_status', 'queue'].filter((k) => s.f[k]).map((k) => `${k}=${s.f[k]}`).join(' ')})`;
const rca = (c: Case, verdict: string, root: string, evidence: string[], owner: string, action: string, acceptance: string) =>
  [`RCA: ${c.tool} - ${c.state}`, `Verdict: ${verdict}`, `Root cause: ${root}`, 'Evidence:', ...(evidence.length ? evidence.map((e) => `- ${e}`) : ['- none']), `Owner: ${owner}`, `Action: ${action}`, `Acceptance: ${acceptance}`].join('\n');

/** the answer the prompt's rules and verdict table (RCA_PROMPT.md section 3) give for this case, or null when a person has to decide */
export function ruleAnswer(c: Case, verdicts: string[]): string | null {
  const tool = c.tool;
  if (c.state === 'OUTPUT') return 'No RCA needed: the tool produced output.';
  const svcs = c.ev.lines.map((l) => ({ l, s: parseSvc(l) })); const named = svcs.filter((x) => x.s && x.s.f.tool_name === tool).map((x) => x.s!);
  const failureJson = c.ev.lines.find((l) => l.startsWith('failure.json: '));
  const other = c.ev.lines.filter((l) => !parseSvc(l) && !l.startsWith('failure.json: ')); // pod or console lines: a person has to read them
  const readiness = named.find((s) => /readiness_blocked_execution/.test(s.message));
  if (c.state === 'NOT_TRIGGERED' && readiness && verdicts.includes('Blocked at startup')) {
    const rs = readiness.f.readiness_status; const sr = readiness.f.skip_reason;
    return rca(c, 'Blocked at startup', `The worker's readiness check blocked ${tool}${rs ? ` (${rs}${sr ? `, ${sr}` : ''})` : ''}, so the task was never executed.`, [evLine(readiness)], readiness.service,
      `Fix the startup check that blocks ${tool}${readiness.f.queue ? ` on queue ${readiness.f.queue}` : ''} and re-run.`, `On re-run, worker.tool_readiness_blocked_execution is not logged for ${tool} and its S3 output exists.`);
  }
  const planning = named.find((s) => /^planning\./.test(s.message));
  if (c.state === 'NOT_TRIGGERED' && planning && verdicts.includes('Excluded in planning'))
    return rca(c, 'Excluded in planning', `${planning.service} excluded ${tool} during planning (${planning.message}${planning.f.reason ? `, ${planning.f.reason}` : ''}).`, [evLine(planning)], planning.service,
      `Resolve the planning exclusion that the evidence names for ${tool}.`, `On re-run, ${planning.message} is not logged for ${tool} and a task is scheduled.`);
  const admission = named.find((s) => /admission_rejected/.test(s.message));
  if (c.state === 'NOT_TRIGGERED' && admission && verdicts.includes('Rejected at admission')) // only once the prompt itself lists this verdict
    return rca(c, 'Rejected at admission', `${admission.service} rejected the task of ${tool} at admission (${admission.f.reason || admission.message}), so it was never started.`, [evLine(admission)], admission.service,
      `Check the capacity named in the evidence (${admission.f.reason || admission.message}) and re-run when it is free.`, `On re-run, ${admission.message} is not logged for ${tool} and its S3 output exists.`);
  const handler = named.find((s) => /^handler\.failed/.test(s.message));
  if ((c.state === 'FAILED' || c.state === 'EMPTY') && handler && verdicts.includes('Tool failed'))
    return rca(c, 'Tool failed', `${handler.service} reported a handler failure for ${tool}${handler.f.reason ? ` with reason ${handler.f.reason}` : ''}, so it produced no result.`, [evLine(handler)], handler.service,
      `Fix the failure reported for ${tool} and re-run.`, `On re-run, handler.failed is not logged for ${tool} and its S3 output is not empty.`);
  if ((c.state === 'FAILED' || c.state === 'EMPTY') && failureJson && verdicts.includes('Tool failed')) {
    const p = failureJson.replace('failure.json: ', '').split(' · ');
    return rca(c, 'Tool failed', `${tool} reported a failure: failure.json gives ${p[0]}${p[1] ? ` with status ${p[1]}` : ''}.`, [failureJson], 'Unknown',
      `Fix the failure in failure.json for ${tool} and re-run.`, `On re-run, ${tool} writes a non-empty S3 output and no failure.json.`);
  }
  if (!named.length && !failureJson && !other.length && verdicts.includes('Insufficient evidence')) {
    const root = c.state === 'NOT_TRIGGERED' ? `No log line names ${tool}, so the logs do not show why it was not triggered.`
      : c.state === 'EMPTY' ? `${tool} ran and returned empty output, and no log line names ${tool}, so the logs do not show why.` : `${tool} is reported as failed, but no log line shows why.`;
    const action = c.state === 'NOT_TRIGGERED' ? `Collect the orchestrator and worker log lines that name ${tool} for this run.` : c.state === 'EMPTY' ? `Collect the ${tool} task log of this run and the list of files it was given.` : `Collect the ${tool} task log and its failure.json for this run.`;
    const acc = c.state === 'NOT_TRIGGERED' ? `On re-run, a log line names ${tool} and shows why it was or was not scheduled.` : c.state === 'EMPTY' ? `${tool} writes a non-empty result for this repository, or the logs state why there is nothing to report.` : `On re-run, ${tool} succeeds or its log states the exact failure.`;
    return rca(c, 'Insufficient evidence', root, [], 'Unknown', action, acc);
  }
  return null;
}

/** the checks of RCA_PROMPT.md section 6 (and register_model.py): template, allowed verdict, 120 words, no speculation, every identifier is in the input */
export function checkAnswer(answer: string, input: string, verdicts: string[]): string[] {
  const bad: string[] = [];
  if (/^no rca needed: the tool produced output\.$/i.test(answer.trim())) return /STATE: OUTPUT/.test(input) ? [] : ['"No RCA needed" is only for STATE: OUTPUT'];
  const lower = answer.toLowerCase();
  for (const h of ['rca:', 'verdict:', 'root cause:', 'evidence:', 'owner:', 'action:', 'acceptance:']) if (!lower.includes(h)) bad.push(`missing "${h}" line`);
  const v = /^Verdict:\s*(.+)$/im.exec(answer)?.[1]?.trim(); if (v && !verdicts.includes(v)) bad.push(`verdict "${v}" is not one of: ${verdicts.join(' | ')}`);
  const words = answer.split(/\s+/).filter(Boolean).length; if (words > 120) bad.push(`${words} words (maximum 120)`);
  for (const w of BANNED) if (new RegExp(`\\b${w}\\b`, 'i').test(answer)) bad.push(`speculation word "${w}"`);
  for (const t of new Set(answer.match(ID_LIKE) || [])) if (!input.includes(t)) bad.push(`"${t}" is not in the input`);
  return bad;
}

// ---------------------------------------------------------------- dataset files
const userOf = (r: any): string => String(r?.messages?.find((m: any) => m.role === 'user')?.content || r?.input || '');
const readRows = (f: string): any[] => { try { return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch { return []; } };
const isHoldout = (input: string) => crypto.createHash('sha1').update(input).digest().readUInt32BE(0) % 6 === 0;
const verdictOf = (a: string) => /^No RCA needed/i.test(a) ? 'No RCA needed' : (/^Verdict:\s*(.+)$/im.exec(a)?.[1] || 'unknown').trim();

/** adds the case to dataset.jsonl or holdout.jsonl (never both, never twice); returns where it went */
export function saveCase(c: Case, answer: string, p: Prompt, dry = false): 'train' | 'holdout' | 'duplicate' {
  const inTrain = readRows(DATASET).some((r) => userOf(r) === c.input); const inHold = readRows(HOLDOUT).some((r) => userOf(r) === c.input);
  if (inTrain || inHold) return 'duplicate';
  if (isHoldout(c.input)) {
    const v = verdictOf(answer); const owner = /^Owner:\s*(.+)$/im.exec(answer)?.[1]?.trim() || '';
    const must = v === 'No RCA needed' ? ['No RCA needed: the tool produced output.'] : [v, c.tool, ...(owner && owner !== 'Unknown' ? [owner] : [owner === 'Unknown' ? 'Unknown' : ''])].filter(Boolean);
    if (!dry) fs.appendFileSync(HOLDOUT, JSON.stringify({ name: `${c.tool} (${v})`, input: c.input, must, answer }) + '\n');
    return 'holdout';
  }
  if (!dry) fs.appendFileSync(DATASET, JSON.stringify({ messages: [{ role: 'system', content: p.system }, { role: 'user', content: c.input }, { role: 'assistant', content: answer }] }) + '\n');
  return 'train';
}

const foldersOf = (args: string[]): string[] => {
  if (args.includes('--all')) {
    const res = path.join(__dirname, '..', 'results'); const out: string[] = [];
    for (const r of fs.existsSync(res) ? fs.readdirSync(res) : []) { const rd = path.join(res, r); if (!fs.statSync(rd).isDirectory()) continue; for (const b of fs.readdirSync(rd)) { const d = path.join(rd, b); if (fs.existsSync(path.join(d, 's3-check.json'))) out.push(d); } }
    return out;
  }
  return args.filter((a) => !a.startsWith('--')).map((a) => path.resolve(a));
};

const SHARE_INSUFFICIENT = 0.35; // RCA_PROMPT.md asks for at least 30% no-evidence cases; far more would teach the model to give up
const SHARE_OUTPUT = 0.10; // and about 10% "No RCA needed"
const hashOf = (s: string) => crypto.createHash('sha1').update(s).digest('hex');

function seed(folders: string[], dry: boolean, balance = true): void {
  const p = loadPrompt(); const tally: Record<string, number> = {}; let needReview = 0; let invalid = 0; let dup = 0; const queue: string[] = [];
  const known = new Set([...readRows(DATASET), ...readRows(HOLDOUT)].map(userOf));
  type Cand = { c: Case; a: string; v: string; hold: boolean };
  const cands: Cand[] = [];
  for (const f of folders) for (const c of casesOf(f)) {
    const a = ruleAnswer(c, p.verdicts);
    if (!a) { needReview++; queue.push(`${path.basename(f)} / ${c.tool} (${c.state})`); continue; }
    const bad = checkAnswer(a, c.input, p.verdicts); if (bad.length) { invalid++; console.log(`  skipped ${c.tool}: the rule answer fails the checks (${bad[0]})`); continue; }
    if (known.has(c.input)) { dup++; continue; }
    cands.push({ c, a, v: verdictOf(a), hold: isHoldout(c.input) });
  }
  // balance: real failures and exclusions all go in; "Insufficient evidence" and "No RCA needed" are capped to their share and kept to one example per
  // tool, state and verdict (the same tool in ten runs adds nothing), picked by hash so the choice is stable
  let left = 0; let chosen = cands;
  if (balance) {
    const weak = (v: string) => v === 'Insufficient evidence' || v === 'No RCA needed';
    const seen = new Set<string>(); const pick: Cand[] = [];
    const train = cands.filter((x) => !x.hold); const hold = cands.filter((x) => x.hold);
    const have = readRows(DATASET).map((r) => verdictOf(String(r.messages?.find((m: any) => m.role === 'assistant')?.content || '')));
    const strong = train.filter((x) => !weak(x.v)); const P = strong.length + have.filter((v) => !weak(v)).length;
    const total = Math.max(P / (1 - SHARE_INSUFFICIENT - SHARE_OUTPUT), have.length);
    let roomI = Math.max(0, Math.floor(total * SHARE_INSUFFICIENT) - have.filter((v) => v === 'Insufficient evidence').length);
    let roomO = Math.max(0, Math.floor(total * SHARE_OUTPUT) - have.filter((v) => v === 'No RCA needed').length);
    // real failures and exclusions go in, but ten rejections with the same line and a different tool name teach one thing: at most 3 per pattern
    const perPattern = new Map<string, number>();
    const patternOf = (x: Cand) => x.v + '|' + (/^- (.+)$/m.exec(x.a)?.[1] || '').replace(/^\S+ /, '').replace(/tool_name=\S+/, '').slice(0, 70).replace(/\S*\d\S*/g, '#');
    for (const x of strong.sort((a, b) => hashOf(a.c.input).localeCompare(hashOf(b.c.input)))) { const k = patternOf(x); const n = perPattern.get(k) || 0; if (n < 3) { perPattern.set(k, n + 1); pick.push(x); } }
    for (const x of train.filter((y) => weak(y.v)).sort((a, b) => hashOf(a.c.input).localeCompare(hashOf(b.c.input)))) {
      const k = `${x.v}|${x.c.tool}|${x.c.state}`; if (seen.has(k)) continue;
      if (x.v === 'Insufficient evidence' ? roomI-- > 0 : roomO-- > 0) { seen.add(k); pick.push(x); }
    }
    for (const x of hold.sort((a, b) => hashOf(a.c.input).localeCompare(hashOf(b.c.input)))) { const k = `h|${x.v}|${x.c.tool}|${x.c.state}`; if (!seen.has(k)) { seen.add(k); pick.push(x); } }
    left = cands.length - pick.length; chosen = pick;
  }
  for (const x of chosen) { const where = saveCase(x.c, x.a, p, dry); if (where === 'duplicate') { dup++; continue; } const k = `${where === 'holdout' ? 'holdout' : 'train  '} ${x.v}`; tally[k] = (tally[k] || 0) + 1; }
  console.log(`\n  ${dry ? 'DRY RUN, nothing written. ' : ''}Seeded from ${folders.length} branch folder(s):`);
  for (const [k, n] of Object.entries(tally).sort()) console.log(`    ${String(n).padStart(4)}  ${k}`);
  console.log(`    ${String(left).padStart(4)}  left out to keep the mix (too many "Insufficient evidence" / "No RCA needed", or repeats of the same tool; --no-balance writes them all)`);
  console.log(`    ${String(dup).padStart(4)}  already in the dataset`);
  console.log(`    ${String(invalid).padStart(4)}  rule answers that failed the checks (not written)`);
  console.log(`    ${String(needReview).padStart(4)}  cases the rules cannot settle: teach them with  npm run teach -- review ...`);
  for (const q of queue.slice(0, 12)) console.log(`          - ${q}`);
  if (queue.length > 12) console.log(`          ... ${queue.length - 12} more`);
}

/** lines typed (or piped) while the model is still answering are kept, and the end of the input ends the session instead of throwing */
function lineReader() {
  const rl = readline.createInterface({ input: process.stdin }); const q: string[] = []; let wait: ((s: string | null) => void) | null = null; let closed = false;
  rl.on('line', (l) => { if (wait) { const w = wait; wait = null; w(l); } else q.push(l); });
  rl.on('close', () => { closed = true; if (wait) { const w = wait; wait = null; w(null); } });
  return {
    question: (prompt: string) => new Promise<string | null>((res) => { process.stdout.write(prompt); if (q.length) res(q.shift()!); else if (closed) res(null); else wait = res; }),
    close: () => rl.close(),
  };
}

async function review(folders: string[]): Promise<void> {
  const p = loadPrompt(); const rl = lineReader(); let saved = 0; let n = 0;
  const todo: Case[] = []; for (const f of folders) for (const c of casesOf(f)) if (!ruleAnswer(c, p.verdicts)) todo.push(c);
  console.log(`\n  ${todo.length} case(s) the rules cannot settle. For each: [a]ccept the model's answer, [e]dit (type the right answer, end with a line containing only a dot), [s]kip, [q]uit\n`);
  try {
    for (const c of todo) {
      n++; console.log(`---- ${n}/${todo.length} ${path.basename(c.folder)} / ${c.tool}\n${c.input}\n`);
      let ans = (await askRcaModel(c.input, 180_000)) || ''; console.log('---- the model says:\n' + (ans || '(no answer: is Ollama running? npm run model:setup)') + '\n');
      for (;;) {
        const bad = ans ? checkAnswer(ans, c.input, p.verdicts) : ['no answer'];
        const raw = await rl.question(`  ${bad.length ? `checks fail (${bad.join('; ')}). ` : 'checks pass. '}[a]ccept / [e]dit / [s]kip / [q]uit > `);
        const k = (raw ?? 'q').trim().toLowerCase(); // end of the input = quit
        if (k === 'q') { console.log(''); return; }
        if (k === 's') break;
        if (k === 'a') { if (bad.length) { console.log('  cannot accept: fix it with [e]dit first'); continue; } console.log(`  saved to ${saveCase(c, ans, p)}`); saved++; break; }
        if (k === 'e') { console.log('  type the answer, then a line with only a dot:'); const lines: string[] = []; for (;;) { const l = await rl.question(''); if (l === null || l.trim() === '.') break; lines.push(l); } ans = lines.join('\n').trim(); console.log(ans ? '' : '  (empty)'); }
      }
    }
  } finally { rl.close(); console.log(`\n  ${saved} case(s) saved.`); }
}

function stats(): void {
  const t = readRows(DATASET); const h = readRows(HOLDOUT); const count: Record<string, number> = {}; let noEv = 0;
  for (const r of t) { const a = String(r.messages?.find((m: any) => m.role === 'assistant')?.content || ''); const v = verdictOf(a); count[v] = (count[v] || 0) + 1; if (/LOG EVIDENCE: none/.test(userOf(r))) noEv++; }
  console.log(`\n  training examples: ${t.length}   holdout (test only): ${h.length}`);
  for (const [k, n] of Object.entries(count).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${k}`);
  const pct = t.length ? Math.round((noEv * 100) / t.length) : 0;
  console.log(`  with no log evidence: ${noEv} (${pct}%, RCA_PROMPT.md asks for at least 30%)`);
  console.log(`  rule of thumb: a few dozen varied examples are a start; ${t.length < 30 ? 'you are below that: seed more runs or teach more cases' : 'retrain on Colab when the mix looks right'}\n`);
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2); const folders = foldersOf(rest);
  const usage = () => { console.log('Usage: npm run teach -- seed|review <branch folder ...> | --all   (add --dry to seed to see the counts only)\n       npm run teach -- stats'); process.exit(1); };
  if (cmd === 'stats') stats();
  else if ((cmd === 'seed' || cmd === 'review') && folders.length) (cmd === 'seed' ? Promise.resolve(seed(folders, rest.includes('--dry'), !rest.includes('--no-balance'))) : review(folders)).then(() => process.exit(0));
  else usage();
}
