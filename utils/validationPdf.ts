import { chromium } from '@playwright/test';
import type { EksAiDiagnosis } from './eksRootCause';

/**
 * validation-report.pdf for npm run validate: the checker's table (PASS / EMPTY / FAIL per tool row) and, for every tool that did not pass, what its
 * own file says plus the diagnosis of the known-pattern rules when the folder holds real evidence for it. Built as HTML and printed by the same
 * Chromium the bug drafts use (CHROMIUM_PATH can point to another one).
 */
export interface PdfRow { result: string; tool: string; technique: string; note: string }
export interface PdfProblem { tool: string; state: string; note: string; diag?: EksAiDiagnosis }
export interface PdfData { name: string; source: string; language: string; counts: Record<string, number>; rows: PdfRow[]; problems: PdfProblem[] }

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const diagTable = (d: EksAiDiagnosis) => `<table class="ans">${([['Verdict', d.verdict], ['Root cause', d.rootCause], ['Evidence', d.evidence], ['Owner', d.owner], ['Suggested fix', d.action || d.suggestedFix]] as [string, string | undefined][])
  .filter(([, v]) => v).map(([k, v]) => `<tr><td class="k">${k}</td><td>${k === 'Evidence' ? `<div class="ev">${esc(v)}</div>` : esc(v)}</td></tr>`).join('')}</table>`;

const html = (d: PdfData) => `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 14mm 12mm; }
  body { font-family: Segoe UI, Arial, sans-serif; font-size: 9.5pt; color: #0f172a; }
  h1 { font-size: 17pt; margin: 0 0 4px; color: #1e3a8a; } h2 { font-size: 12pt; color: #0d9488; margin: 16px 0 6px; border-bottom: 1px solid #cbd5e1; padding-bottom: 3px; }
  h3 { font-size: 10.5pt; margin: 12px 0 4px; } .sub { color: #475569; font-size: 8.5pt; margin: 2px 0; }
  table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #cbd5e1; padding: 3px 5px; vertical-align: top; text-align: left; }
  th { background: #1e3a8a; color: #fff; } tr { page-break-inside: avoid; }
  .PASS { background: #dcfce7; font-weight: 600; } .FAIL { background: #fee2e2; font-weight: 600; } .EMPTY { background: #fef3c7; font-weight: 600; } .NA { background: #f1f5f9; }
  .chips span { display: inline-block; padding: 2px 8px; margin-right: 6px; border-radius: 10px; font-weight: 600; font-size: 9pt; }
  .ans { margin: 3px 0 8px; } .ans .k { width: 80px; font-weight: 600; background: #f1f5f9; } .ev { font-family: Consolas, monospace; font-size: 8pt; margin: 1px 0; word-break: break-all; }
  .note { background: #eff6ff; border: 1px solid #bfdbfe; padding: 6px 8px; margin: 8px 0; font-size: 9pt; } .file { margin: 3px 0 6px; }
</style></head><body>
  <h1>Tool validation: ${esc(d.name)}</h1>
  <div class="sub">Source: ${esc(d.source)}</div><div class="sub">Language from the folder name: ${esc(d.language || 'not recognised')}</div>
  <div class="note">Only the tool files were available (no run id, no EKS logs). A tool that never produced a folder can only be reported as not triggered; a diagnosis (known-pattern rules) appears only when the folder holds real evidence for the tool, such as a failure.json.</div>
  <div class="chips"><span class="PASS">PASS ${d.counts.PASS || 0}</span><span class="EMPTY">EMPTY ${d.counts.EMPTY || 0}</span><span class="FAIL">FAIL ${d.counts.FAIL || 0}</span>${d.counts.NA ? `<span class="NA">N/A ${d.counts.NA}</span>` : ''}</div>
  <h2>Result per tool row</h2>
  <table><tr><th style="width:48px">Result</th><th style="width:105px">Tool</th><th style="width:150px">Technique</th><th>What the file says</th></tr>
    ${d.rows.map((r) => `<tr><td class="${esc(r.result)}">${esc(r.result)}</td><td>${esc(r.tool)}</td><td>${esc(r.technique)}</td><td>${esc(String(r.note).slice(0, 220))}</td></tr>`).join('')}</table>
  <h2>Tools that did not pass (${d.problems.length})</h2>
  ${d.problems.map((p) => `<h3>${esc(p.tool)} <span class="sub">${esc(p.state)}</span></h3><div class="file">${esc(p.note.slice(0, 300))}</div>${p.diag ? diagTable(p.diag) : ''}`).join('')}
</body></html>`;

export async function writeValidationPdf(file: string, d: PdfData): Promise<void> {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage(); await page.setContent(html(d), { waitUntil: 'load' });
    await page.pdf({ path: file, format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } });
  } finally { await browser.close(); }
}
