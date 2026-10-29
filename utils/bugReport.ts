import * as fs from 'fs';
import * as path from 'path';
import { chromium } from '@playwright/test';
import type { PyDefect } from './pyValidate';
import { getEksAiDiagnosis, type EksAiDiagnosis } from './eksMentor';

/**
 * Bug reports for the PLATFORM defects found by the Python tool validation (pyValidate.ts → s3-check.json "python.defects").
 * Follows PROMPT_Python_Tool_Bug_Classification_and_Filing.md (which status is a platform bug) and
 * PROMPT_Automated_Tool_Defect_Report_and_PDF_Generation.md (what the report looks like).
 *
 * For every defective tool it writes into  <branch folder>/bugs/ :
 *   Defect_Report_<tool>_PY<ver>_<run>.pdf   2-page executive PDF (page 1: summary + metadata + screenshot, page 2: repo proof + root cause + fix + retest)
 *   <tool>_gate_screenshot_2x.png            the tool's row of the taxonomy report (2x)
 *   JIRA_<tool>_<run>.jira.md                the 7-section Jira description
 *   bugs.json                                list of all bug drafts of the branch (used later by the Jira step)
 * These are DRAFTS: nothing is sent to Jira. Repo proof is read from GitHub when GITHUB_TOKEN is in .env (BUG_REPORTS=off turns all this off).
 * Never throws into the flow.
 */
const TRIGGER_DIR = 'Tool Triggering (Synthetic Data)';
const PYL = { name: 'Python', lb: (v: string) => `Python ${v}`, short: 'PY', dir: 'python', ext: '.py', slug: 'python', runtime: 'Python' };
const JSL = { name: 'JavaScript', lb: (v: string) => `Node ${v}`, short: 'Node', dir: 'javascript', ext: '.js', slug: 'javascript', runtime: 'JavaScript (Node.js)' };
const TSL = { name: 'TypeScript', lb: (v: string) => `Node ${v}`, short: 'Node', dir: 'typescript', ext: '.ts', slug: 'typescript', runtime: 'TypeScript (Node.js)' };
const JVL = { name: 'Java', lb: (v: string) => `Java ${v}`, short: 'Java', dir: 'java', ext: '.java', slug: 'java', runtime: 'Java (JVM)' };
const CSL = { name: 'C#', lb: (v: string) => v, short: 'NET', dir: 'csharp', ext: '.cs', slug: 'csharp', runtime: 'C# (.NET)' };
let LANG: typeof PYL = PYL; // set per branch in writeBugReports
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');

interface Proof { found: boolean; path: string; url: string; snippet: string[]; note: string }

async function gh(url: string, token: string): Promise<any> {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15_000);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/vnd.github+json', 'User-Agent': 'testable-merge-flow' } });
    if (!r.ok) throw new Error(r.status === 404 && !token ? 'GitHub 404 — a private repository needs GITHUB_TOKEN in .env' : r.status === 403 && !token ? 'GitHub 403 — rate limit without a token; set GITHUB_TOKEN in .env' : `GitHub ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/** the tool's trigger.yaml on the tested branch (clean 5-line snippet + links). Without a token or owner/repo: links only. */
async function repoProof(repo: string, branch: string, tool: string, token: string, dirs: { list?: string[] }): Promise<Proof> {
  const treeUrl = repo.includes('/') ? `https://github.com/${repo}/tree/${encodeURIComponent(branch)}/${encodeURI(TRIGGER_DIR)}/${encodeURIComponent(tool)}` : '';
  const none = (note: string, p = `${TRIGGER_DIR}/${tool}/trigger.yaml`): Proof => ({ found: false, path: p, url: treeUrl, snippet: [], note });
  if (!repo.includes('/')) return none('repository owner unknown (the build only has the repo name) — open the branch in GitHub and check this path');
  try {
    if (!dirs.list) { const l = await gh(`https://api.github.com/repos/${repo}/contents/${encodeURI(TRIGGER_DIR)}?ref=${encodeURIComponent(branch)}`, token); dirs.list = (Array.isArray(l) ? l : []).map((x: any) => x.name); }
    const nn = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const folder = dirs.list.find((n) => nn(n) === nn(tool));
    if (!folder) return none(`no folder "${tool}" under "${TRIGGER_DIR}" on this branch`);
    const p = `${TRIGGER_DIR}/${folder}/trigger.yaml`;
    const f = await gh(`https://api.github.com/repos/${repo}/contents/${encodeURI(p)}?ref=${encodeURIComponent(branch)}`, token);
    const text = Buffer.from(String(f.content || ''), 'base64').toString('utf8');
    const snippet = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).slice(0, 5);
    return { found: true, path: p, url: `https://github.com/${repo}/blob/${encodeURIComponent(branch)}/${encodeURI(p)}`, snippet, note: 'trigger.yaml is committed on the tested branch' };
  } catch (e) { return none(`could not read the branch from GitHub (${e instanceof Error ? e.message : e})`); }
}

const KIND: Record<PyDefect['tag'], { title: (v: string, t: string, d: PyDefect) => string; component: string; layer: string; files: string[]; owner: string; why: (v: string, t: string, d: PyDefect) => string; fix: (v: string, t: string) => string; expected: string; actual: (d: PyDefect) => string; artifact: string }> = {
  '[Planning Defect]': {
    title: (v, t, d) => d.ranOutsideMatrix ? `Tool ran on ${LANG.lb(v)} although it must be excluded for this version` : `Tool not planned although expected for ${LANG.lb(v)}`,
    component: 'Whitebox Orchestrator / Planning', layer: 'Planning Drop',
    files: ['backend/wb-orchestrator/activities/planning.py', 'shared/whitebox/compatibility.py'], owner: 'Platform Orchestrator (Planning)',
    why: (v, t, d) => d.ranOutsideMatrix
      ? `The tool-to-version matrix for ${LANG.lb(v)} says ${t} must not run, but the plan scheduled it. The planning gate let it through.`
      : `${t} belongs to the supported tool set for ${LANG.lb(v)}, but the orchestrator left it out of the execution plan: no task was scheduled and no S3 folder was created. The omission therefore happens before the worker is started.`,
    fix: (v, t) => `Make the planning gate schedule ${t} for ${LANG.lb(v)} (check the version ceiling / parserCompatibility entry for ${t} in shared/whitebox/compatibility.py and any Wave 2b omission in planning.py).`,
    expected: 'Must be planned in Wave 2b for this version', actual: (d) => d.ranOutsideMatrix ? 'Planned and executed although excluded for this version' : 'Not planned — 0 tasks scheduled, no S3 folder',
    artifact: 'the tool output folder and its report file',
  },
  '[False Empty Defect]': {
    title: () => 'False empty report emitted — the tool scanned 0 files',
    component: 'Whitebox Platform / CPU Worker', layer: 'Target Discovery Bug',
    files: ['backend/wb-cpu-worker/app/analyzers/python/_targets.py', 'backend/wb-cpu-worker/app/parsers/python/<tool>_parser.py'], owner: 'Platform CPU Worker',
    why: (v, t) => `${t} finished but wrote an empty report because it was pointed at 0 source files, although the branch contains ${LANG.name} code. This normally means the target discovery did not find the repository's source folders.`,
    fix: (v, t) => `Fix the target discovery so ${t} receives the repository's ${LANG.ext} files (check _targets.py for the repository layout used by this branch).`,
    expected: 'Must scan the repository source files and write authentic metrics', actual: () => 'Empty report with 0 files scanned',
    artifact: 'a non-empty report with parsed metrics',
  },
  '[Runner Execution Defect]': {
    title: () => 'Tool failed to run on the worker',
    component: 'Whitebox Platform / CPU Worker', layer: 'Runner Crash',
    files: ['backend/wb-cpu-worker/app/analyzers/python/<tool>_runner.py'], owner: 'Platform CPU Worker',
    why: (v, t, d) => `${t} did not finish: ${d.note}. The failure is not caused by the customer repository (no import/test error), so the runner or the worker image is the suspect.`,
    fix: (v, t) => `Fix the runner of ${t} (tool binary on the worker image, unhandled exception or timeout) so it writes its report on ${LANG.lb(v)}.`,
    expected: 'Must execute successfully and write its report', actual: () => 'FAILED (failure.json written)',
    artifact: 'a report with parsed metrics',
  },
  '[Language Contamination]': {
    title: () => `Non-${LANG.name} tool planned for a ${LANG.name} branch`,
    component: 'Whitebox Orchestrator / Planning', layer: 'Language Isolation Defect',
    files: ['backend/wb-orchestrator/activities/planning.py', 'shared/whitebox/compatibility.py'], owner: 'Platform Orchestrator (Planning)',
    why: (v, t) => `${t} belongs to another language but was planned and run for a ${LANG.lb(v)} repository. The language isolation in planning did not filter it out.`,
    fix: (v, t) => `Make the planning gate filter tools by the repository language so ${t} is never planned for ${LANG.name} branches.`,
    expected: `Only ${LANG.name} tools are planned for a ${LANG.name} repository`, actual: (d) => `Foreign tool folder present: ${d.tool}`,
    artifact: 'no folder for this tool',
  },
};

interface Ctx { pm?: string; layout?: string; version: string; branch: string; repo: string; runId: string; short: string; commit: string; s3Path: string; gateHtml: string }

/** The QA EKS Mentor's diagnosis as label/value rows (empty when there is none, so the report stays exactly as before). One line each, cut at 700 characters. */
function aiRows(ai?: EksAiDiagnosis | null): Array<[string, string]> {
  // Only a diagnosis built from real QA EKS log lines (a ready analyze.py report) is printed. A direct model answer carries no log lines and can invent evidence, so it is left out.
  if (!ai || ai.source !== 'report') return [];
  const one = (s?: string) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 700);
  const rows: Array<[string, string]> = [['Verdict', one(ai.verdict)], ['Summary', one(ai.summary)], ['Root cause', one(ai.rootCause)], ['Evidence (QA EKS log line)', one(ai.evidence)], ['Owner', one(ai.owner)], ['Suggested fix', one(ai.suggestedFix)]];
  return rows.filter(([, v]) => v);
}
const AI_NOTE = 'Written by the local QA EKS Mentor model from the QA EKS logs. A draft: check it against the logs before filing.';
const aiHtml = (ai?: EksAiDiagnosis | null) => {
  const rows = aiRows(ai); if (!rows.length) return '';
  return `<h3>AI root-cause diagnosis (QA EKS Mentor)</h3>\n<table>\n${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('\n')}\n</table>\n<div class="draft">${esc(AI_NOTE)}</div>\n`;
};
const aiJira = (ai?: EksAiDiagnosis | null) => {
  const rows = aiRows(ai); if (!rows.length) return '';
  const jx = (s: string) => s.replace(/[|{}]/g, ' '); // keep the Jira wiki markup intact
  return `\n{panel:title=AI diagnosis (QA EKS Mentor) - draft, verify against the logs}\n${rows.map(([k, v]) => `*${k}:* ${jx(v)}`).join('\n')}\n{panel}`;
};

function pdfHtml(c: Ctx, d: PyDefect, proof: Proof, shot: string | null, ai?: EksAiDiagnosis | null): string {
  const k = KIND[d.tag]; const tool = d.tool;
  const repoUrl = c.repo.includes('/') ? `https://github.com/${c.repo}` : '';
  const branchUrl = repoUrl ? `${repoUrl}/tree/${encodeURIComponent(c.branch)}` : '';
  const sev = 'Major';
  const link = (u: string, t: string) => (u ? `<a href="${esc(u)}">${esc(t)}</a>` : esc(t));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{font:11px/1.45 "Segoe UI",Arial,sans-serif;color:#1f2937;margin:0}
.banner{background:#7f1d1d;color:#fff;padding:12px 16px;border-radius:6px}.banner h1{margin:0;font-size:17px}.banner div{font-size:10.5px;opacity:.9;margin-top:3px}
.bluf{margin:12px 0;padding:11px 14px;border:2px solid #b91c1c;background:#fef2f2;border-radius:6px}.bluf h2{margin:0 0 5px;font-size:12px;color:#991b1b;text-transform:uppercase;letter-spacing:.04em}
.bluf b{color:#7f1d1d}
h3{font-size:12.5px;margin:13px 0 5px;color:#111827;border-bottom:1px solid #e5e7eb;padding-bottom:3px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #e5e7eb;padding:4px 7px;text-align:left;vertical-align:top;font-size:10.5px}th{background:#f3f4f6;width:30%}
.shot{border:1px solid #d1d5db;border-radius:4px;padding:5px;background:#fff;text-align:center}.shot img{max-width:100%;max-height:285px;object-fit:contain}
.cap{font-size:9.5px;color:#6b7280;margin-top:3px}
pre{background:#0f172a;color:#e2e8f0;padding:8px 10px;border-radius:5px;font:10px/1.4 Consolas,monospace;white-space:pre-wrap;margin:5px 0}
.p2{page-break-before:always}.ok{color:#047857;font-weight:600}.bad{color:#b91c1c;font-weight:600}
ul{margin:4px 0 4px 18px;padding:0}a{color:#1d4ed8}.draft{font-size:9.5px;color:#92400e;background:#fffbeb;border:1px solid #fcd34d;border-radius:4px;padding:3px 7px;margin-top:6px;display:inline-block}
</style></head><body>
<div class="p1">
<div class="banner"><h1>WHITEBOX DEFECT REPORT: ${esc(tool)}</h1><div>${esc(d.tag)} · ${esc(LANG.lb(c.version))} · branch ${esc(c.branch)} · run ${esc(c.short)}</div></div>
<div class="bluf"><h2>30-second summary</h2>
<b>What failed:</b> ${esc(tool)} — ${esc(k.title(c.version, tool, d).toLowerCase())}.<br>
<b>Who owns the fix:</b> ${esc(k.owner)} (platform, not the customer repository).<br>
<b>Is the repository clean:</b> ${proof.found ? '<span class="ok">Yes — trigger.yaml is committed on the tested branch</span>' : d.tag === '[Planning Defect]' ? 'Not confirmed — ' + esc(proof.note) : 'Not a repository problem — see the root cause on page 2'}.<br>
<b>Severity:</b> ${sev}
</div>
<h3>Test run &amp; environment</h3>
<table>
<tr><th>Platform run ID</th><td>${esc(c.runId)}</td></tr>
<tr><th>Repository</th><td>${link(repoUrl, c.repo)}</td></tr>
<tr><th>Tested branch</th><td>${link(branchUrl, c.branch)}</td></tr>
<tr><th>Commit</th><td>${esc(c.commit)}</td></tr>
<tr><th>Language &amp; version</th><td>${esc(LANG.lb(c.version))}</td></tr>
<tr><th>Defective tool</th><td>${esc(tool)}</td></tr>
<tr><th>Gate report</th><td>${esc(path.basename(c.gateHtml))}</td></tr>
</table>
<h3>Platform taxonomy gate evidence</h3>
<div class="shot">${shot ? `<img src="data:image/png;base64,${shot}">` : '<i>screenshot of the row was not available</i>'}</div>
<div class="cap">The tool's row in the taxonomy report (Tool / JSON and S3 comment columns).</div>
<table style="margin-top:7px">
<tr><th>Tool planning</th><td>Expected: ${esc(k.expected)}<br>Actual: <span class="bad">${esc(k.actual(d))}</span></td></tr>
<tr><th>Observed output</th><td>${esc(d.observed)}</td></tr>
<tr><th>Finding</th><td>${esc(d.note)}</td></tr>
</table>
</div>
<div class="p2">
<div class="banner" style="background:#1e3a8a"><h1>Source proof &amp; remediation</h1><div>${esc(tool)} · ${esc(LANG.lb(c.version))}</div></div>
<h3>Repository trigger data (ran-branch verification)</h3>
<table>
<tr><th>Authoritative trigger file</th><td>${link(proof.url, proof.path)}</td></tr>
<tr><th>Status</th><td>${proof.found ? '<span class="ok">Found and committed</span>' : esc(proof.note)}</td></tr>
</table>
${proof.snippet.length ? `<pre>${esc(proof.snippet.join('\n'))}</pre>` : ''}
<h3>Root cause (plain English)</h3>
<p>${esc(k.why(c.version, tool, d))}${proof.found ? ' The tool\'s trigger file is committed on the tested branch, so the repository is ready.' : ''}</p>
<p><b>Layer:</b> ${esc(k.layer)} — files to check: ${k.files.map((f) => `<code>${esc(f.replace('<tool>', tool.replace(/-/g, '_')).replace('/python/', `/${LANG.dir}/`))}</code>`).join(', ')}.<br><span style="color:#6b7280">The exact line is for the platform team to confirm; this report is built from the run evidence only.</span></p>
${aiHtml(ai)}<h3>Platform team fix</h3><p>${esc(k.fix(c.version, tool))}</p>
<h3>QA retest acceptance criteria</h3>
<ul>
<li>Re-run branch <b>${esc(c.branch)}</b> (${esc(LANG.lb(c.version))}) on the fixed platform build.</li>
<li>${esc(tool)} appears in the taxonomy gate with ${esc(k.artifact)}${d.tag === '[Planning Defect]' && !d.ranOutsideMatrix ? ' and its S3 folder exists' : ''}.</li>
<li>The ${LANG.name} tool validation line for this branch no longer lists ${esc(tool)} as a defect.</li>
</ul>
<div class="draft">DRAFT — generated automatically for verification; not filed in Jira.</div>
</div></body></html>`;
}

function jiraMd(c: Ctx, d: PyDefect, proof: Proof, pdfName: string, shotName: string, ai?: EksAiDiagnosis | null): string {
  const k = KIND[d.tag]; const tool = d.tool;
  const files = k.files.map((f) => f.replace('<tool>', tool.replace(/-/g, '_')).replace('/python/', `/${LANG.dir}/`));
  const bUrl = c.repo.includes('/') ? `https://github.com/${c.repo}/tree/${encodeURIComponent(c.branch)}` : '';
  return `h1. 1. Ticket header
||Field||Value||
|Issue Type|Bug|
|Summary|[Whitebox][${LANG.lb(c.version)}][${tool}] ${k.title(c.version, tool, d)}|
|Component|${k.component}|
|Severity|Major|
|Labels|whitebox-qa, ${LANG.slug}-validation, tool-triggering, tp-defect|${LANG === TSL ? `\n|Runtime|TypeScript (Node.js ${c.version} · ${c.pm}${c.layout ? ' · ' + c.layout : ''})|` : LANG === JSL ? `\n|Runtime|JavaScript (Node.js ${c.version} · ${c.pm}${c.layout ? ' · ' + c.layout : ''})|` : LANG === CSL ? `\n|Runtime|C# (${c.version} · target ${c.pm || ''})|` : LANG === JVL ? `\n|Runtime|Java (JDK ${c.version} · ${c.pm || 'maven'})|` : ''}
|Classification|${d.tag}|

h1. 2. Defect description
During the ${LANG.lb(c.version)} White-Box validation run {{${c.runId}}} on {{${c.repo}}} (branch {{${c.branch}}}), ${tool} ${d.tag === '[Planning Defect]' && !d.ranOutsideMatrix ? 'was expected but was not triggered' : d.tag === '[Language Contamination]' ? 'was planned although it belongs to another language' : d.tag === '[Planning Defect]' ? 'ran although it must be excluded' : d.tag === '[False Empty Defect]' ? 'produced an empty report after scanning 0 files' : 'failed to run'}. The tool is missing from the Whitebox quality score input for this branch.

h1. 3. Expected vs. actual
||Attribute||Expected (per ${LANG.name} version matrix)||Actual platform behaviour||
|Tool planning|${k.expected}|${k.actual(d)}|
|Execution state|Executes and writes its report|${d.observed}|
|Artifact output|${k.artifact}|${d.note.replace(/\|/g, '/')}|

h1. 4. Root cause analysis
Layer: *${k.layer}*. Files to check: ${files.map((f) => `{{${f}}}`).join(', ')}.
${k.why(c.version, tool, d)}
_The exact lines must be confirmed by the platform team._${aiJira(ai)}

h1. 5. Sequence of the failure
{{Repo profiling}} → {{Planning gate (compatibility.py)}} → {{Worker execution}} → {{${d.tag}}}

h1. 6. Suggested fix
${k.fix(c.version, tool)}
{panel:title=Before / after code}
To be completed by the platform team after they confirm the exact lines.
{panel}

h1. 7. Reproduction steps and evidence
* Branch: ${bUrl ? `[${c.branch}|${bUrl}]` : c.branch}
* Commit: {{${c.commit}}}
* Trigger file: ${proof.url ? `[${proof.path}|${proof.url}]` : proof.path} — ${proof.note}
* Open the taxonomy gate report of run {{${c.runId}}} and find the row of ${tool}.
* Attachments: [^${pdfName}] [^${shotName}]
* S3 artifact URI: {{s3://${'<bucket>'}/${c.s3Path}${tool}/0/}}

_Draft generated automatically — not filed in Jira yet._
`;
}

export async function writeBugReports(bd: string, repoArg?: string): Promise<string[]> {
  if (/^(off|0|false|no)$/i.test(process.env.BUG_REPORTS || '')) return [];
  const f = path.join(bd, 's3-check.json'); if (!fs.existsSync(f)) return [];
  const s3 = JSON.parse(fs.readFileSync(f, 'utf8'));
  const blk = s3.java || s3.csharp || s3.typescript || s3.javascript || s3.python; LANG = s3.java ? JVL : s3.csharp ? CSL : s3.typescript ? TSL : s3.javascript ? JSL : PYL;
  const defects: PyDefect[] = blk?.defects || [];
  const outDir = path.join(bd, 'bugs');
  if (!defects.length) { try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ } return []; }
  fs.mkdirSync(outDir, { recursive: true });
  const repo = repoArg || s3.repo || '';
  const gateHtml = fs.readdirSync(bd).find((x) => /^taxonomy.*with-ui-values\.html$/i.test(x));
  const c: Ctx = { version: blk.version, pm: blk.packageManager || blk.target, layout: blk.layout, branch: s3.branch, repo, runId: s3.run_id, short: String(s3.run_id).slice(0, 8), commit: s3.commit_sha, s3Path: s3.s3_path, gateHtml: gateHtml ? path.join(bd, gateHtml) : '' };
  const token = (process.env.GITHUB_TOKEN || '').trim();
  const dirs: { list?: string[] } = {};
  const made: string[] = []; const index: any[] = [];
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1500, height: 900 } });
    const page = await ctx.newPage();
    if (c.gateHtml) await page.goto('file:///' + c.gateHtml.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 60_000 });
    for (const d of defects) {
      const tool = d.tool; const base = `${safe(tool)}`;
      try {
        // visual proof 1: the tool's row in the taxonomy gate
        const shotName = `${base}_gate_screenshot_2x.png`; let shot: string | null = null;
        if (c.gateHtml) {
          let loc = page.locator('tr', { has: page.locator('td.s3-cell', { hasText: tool }) }).first();
          if (!(await loc.count())) loc = page.locator('div', { hasText: /tool validation/ }).last();
          if (await loc.count()) { await loc.scrollIntoViewIfNeeded().catch(() => {}); const buf = await loc.screenshot({ timeout: 20_000 }).catch(() => null); if (buf) { fs.writeFileSync(path.join(outDir, shotName), buf); shot = buf.toString('base64'); } }
        }
        // visual proof 2: the repository
        const proof = await repoProof(repo, c.branch, tool, token, dirs);
        const pdfName = `Defect_Report_${base}_${LANG.short}${c.version.replace(/\./g, '').replace(/^\.?NET\s*/i, '').replace(/\s+/g, '')}_${c.short}.pdf`;
        const p2 = await ctx.newPage();
        const ai = await getEksAiDiagnosis(tool, c.runId, {
          branch: c.branch,
          version: c.version,
          repo,
          observed: d.observed,
          note: d.note,
        }).catch(() => null);
        await p2.setContent(pdfHtml(c, d, proof, shot, ai), { waitUntil: 'load' });
        await p2.pdf({ path: path.join(outDir, pdfName), format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '14mm', left: '12mm', right: '12mm' }, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: `<div style="font-size:8px;color:#6b7280;width:100%;text-align:center">Whitebox defect report · ${esc(tool)} · ${esc(LANG.lb(c.version))} · page <span class="pageNumber"></span> of <span class="totalPages"></span></div>` });
        await p2.close();
        const jiraName = `JIRA_${base}_${c.short}.jira.md`;
        fs.writeFileSync(path.join(outDir, jiraName), jiraMd(c, d, proof, pdfName, shotName, ai));
        made.push(pdfName);
        index.push({ tool, classification: d.tag, observed: d.observed, summary: `[Whitebox][${LANG.lb(c.version)}][${tool}] ${KIND[d.tag].title(c.version, tool, d)}`, pdf: pdfName, jira: jiraName, screenshot: shot ? shotName : null, repoProof: proof.found, status: 'draft (not filed in Jira)' });
      } catch (e) { console.log(`  Bug report for ${tool} failed: ${e instanceof Error ? e.message : e}`); }
    }
  } finally { await browser.close().catch(() => {}); }
  fs.writeFileSync(path.join(outDir, 'bugs.json'), JSON.stringify({ branch: c.branch, run_id: c.runId, version: c.version, bugs: index }, null, 2));
  return made;
}
