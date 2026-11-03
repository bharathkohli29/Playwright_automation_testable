import * as fs from 'fs';
import { chromium } from '@playwright/test';

/**
 * validation-report.pdf for npm run validate: the checker's table (PASS / EMPTY / FAIL per tool row) and, for every tool that did not pass,
 * the root cause. Each answer is marked with who wrote it: a RULE of qa-eks-mentor/RCA_PROMPT.md (code) or the MODEL (Ollama).
 * Built as HTML and printed by the same Chromium the bug drafts use (CHROMIUM_PATH can point to another one).
 */
export interface PdfRow { result: string; tool: string; technique: string; note: string }
export interface PdfProblem { tool: string; state: string; rule?: string; model?: string; modelChecks?: string[] }
export interface PdfData { name: string; source: string; language: string; counts: Record<string, number>; rows: PdfRow[]; problems: PdfProblem[]; modelUsed: boolean }

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FIELDS = ['Verdict', 'Root cause', 'Evidence', 'Owner', 'Action', 'Acceptance'];

/** an RCA answer as a small table (Verdict, Root cause, Evidence lines, Owner, Action, Acceptance) */
function answerTable(a: string): string {
  if (/^no rca needed/i.test(a.trim())) return `<p class="plain">${esc(a)}</p>`;
  const lines = a.split('\n'); const head = lines.find((l) => /^RCA:/i.test(l)) || '';
  const get = (k: string) => { const i = lines.findIndex((l) => l.toLowerCase().startsWith(`${k.toLowerCase()}:`)); if (i < 0) return ''; if (k === 'Evidence') { const ev: string[] = []; for (let j = i + 1; j < lines.length && /^\s*-\s/.test(lines[j]); j++) ev.push(lines[j].replace(/^\s*-\s*/, '')); return ev.map((e) => `<div class="ev">${esc(e)}</div>`).join(''); } return esc(lines[i].slice(k.length + 1).trim()); };
  return `<table class="ans">${head ? `<tr><th colspan="2">${esc(head)}</th></tr>` : ''}${FIELDS.map((k) => `<tr><td class="k">${k}</td><td>${get(k) || '-'}</td></tr>`).join('')}</table>`;
}

const html = (d: PdfData) => `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 14mm 12mm; }
  body { font-family: Segoe UI, Arial, sans-serif; font-size: 9.5pt; color: #0f172a; }
  h1 { font-size: 17pt; margin: 0 0 4px; color: #1e3a8a; } h2 { font-size: 12pt; color: #0d9488; margin: 16px 0 6px; border-bottom: 1px solid #cbd5e1; padding-bottom: 3px; }
  h3 { font-size: 10.5pt; margin: 12px 0 4px; } .sub { color: #475569; font-size: 8.5pt; margin: 2px 0; }
  table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #cbd5e1; padding: 3px 5px; vertical-align: top; text-align: left; }
  th { background: #1e3a8a; color: #fff; } tr { page-break-inside: avoid; }
  .PASS { background: #dcfce7; font-weight: 600; } .FAIL { background: #fee2e2; font-weight: 600; } .EMPTY { background: #fef3c7; font-weight: 600; } .NA { background: #f1f5f9; }
  .chips span { display: inline-block; padding: 2px 8px; margin-right: 6px; border-radius: 10px; font-weight: 600; font-size: 9pt; }
  .tag { display: inline-block; font-size: 8pt; font-weight: 700; padding: 1px 7px; border-radius: 8px; color: #fff; margin-right: 6px; }
  .rule { background: #0d9488; } .model { background: #7c3aed; } .bad { color: #b91c1c; font-size: 8.5pt; margin: 2px 0; }
  .ans { margin: 3px 0 8px; } .ans th { background: #475569; } .ans .k { width: 80px; font-weight: 600; background: #f1f5f9; } .ev { font-family: Consolas, monospace; font-size: 8pt; margin: 1px 0; word-break: break-all; }
  .plain { margin: 3px 0 8px; } .note { background: #eff6ff; border: 1px solid #bfdbfe; padding: 6px 8px; margin: 8px 0; font-size: 9pt; }
</style></head><body>
  <h1>Tool validation: ${esc(d.name)}</h1>
  <div class="sub">Source: ${esc(d.source)}</div><div class="sub">Language from the folder name: ${esc(d.language || 'not recognised')}</div>
  <div class="note">Only the tool files were available (no run id, no EKS logs), so the causes are limited to what the files say. Each answer is marked: <span class="tag rule">RULE</span> written by a rule of RCA_PROMPT.md (code), <span class="tag model">MODEL</span> written by the Ollama model${d.modelUsed ? '' : ' (not asked in this run)'}.</div>
  <div class="chips"><span class="PASS">PASS ${d.counts.PASS || 0}</span><span class="EMPTY">EMPTY ${d.counts.EMPTY || 0}</span><span class="FAIL">FAIL ${d.counts.FAIL || 0}</span>${d.counts.NA ? `<span class="NA">N/A ${d.counts.NA}</span>` : ''}</div>
  <h2>Result per tool row</h2>
  <table><tr><th style="width:48px">Result</th><th style="width:105px">Tool</th><th style="width:150px">Technique</th><th>What the file says</th></tr>
    ${d.rows.map((r) => `<tr><td class="${esc(r.result)}">${esc(r.result)}</td><td>${esc(r.tool)}</td><td>${esc(r.technique)}</td><td>${esc(String(r.note).slice(0, 220))}</td></tr>`).join('')}</table>
  <h2>Root causes (${d.problems.length} tool${d.problems.length === 1 ? '' : 's'} that did not pass)</h2>
  ${d.problems.map((p) => `<h3>${esc(p.tool)} <span class="sub">${esc(p.state)}</span></h3>
    ${p.rule ? `<span class="tag rule">RULE</span>${answerTable(p.rule)}` : ''}
    ${p.model ? `<span class="tag model">MODEL</span>${p.modelChecks?.length ? `<span class="bad">fails the prompt checks: ${esc(p.modelChecks.join('; '))}</span>` : '<span class="sub">passes the prompt checks</span>'}${answerTable(p.model)}` : ''}
    ${!p.rule && !p.model ? '<p class="bad">No answer: the rules cannot settle this case and the model did not answer (is Ollama running? npm run model:setup).</p>' : ''}`).join('')}
</body></html>`;

export async function writeValidationPdf(file: string, d: PdfData): Promise<void> {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage(); await page.setContent(html(d), { waitUntil: 'load' });
    await page.pdf({ path: file, format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } });
  } finally { await browser.close(); }
  void fs;
}
