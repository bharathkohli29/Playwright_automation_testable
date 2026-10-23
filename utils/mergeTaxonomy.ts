import * as fs from 'fs';
import * as path from 'path';
import { s3Bucket, awsRegion } from './env';

/**
 * Builds "taxonomy-…-with-ui-values.html" next to the downloaded taxonomy report: every technique
 * table gets a "UI value" column right after Coverage, filled with the value the Confidence Engine
 * UI shows for that classification (read as text from the gate cards → ui-values.json).
 *  - same as the report  → plain
 *  - differs             → red, tooltip shows the report's value
 *  - not found on the UI → grey "—"
 * The original download is never modified.
 */
interface UiGate { category: string; technique: string; sub: string; rows: { classification: string; value: string; execution: string; result: string; coverage: string }[] }

interface S3Check { language: string; testingType: string; technique: string; tool: string; classifications?: string[]; primary?: string; secondary?: boolean; result: 'PASS' | 'EMPTY' | 'FAIL'; note: string; files: string[] }
interface S3File { s3_path: string; languages: string[]; checks: S3Check[] }
const LANG: Record<string, string> = { javascript: 'JS', typescript: 'TS', csharp: 'C#', python: 'PY' };
const RP: Record<string, string> = { PASS: 'rp-pass', EMPTY: 'rp-warn', FAIL: 'rp-fail' };

const norm = (s: string) => s.toLowerCase().replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9≤≥.%/]+/g, '');
const plain = (h: string) => h.replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&le;/g, '≤').replace(/&ge;/g, '≥').replace(/\s+/g, ' ').trim();
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const cmp = (s: string) => s.replace(/[\s ]+/g, '').toLowerCase();

export function mergeTaxonomy(branchDir: string): string | null {
  const report = fs.readdirSync(branchDir).find((f) => /^taxonomy.*\.html$/i.test(f) && !/with-ui-values|with-screenshots/i.test(f));
  const uiFile = path.join(branchDir, 'ui-values.json');
  if (!report) return null;
  const s3File = path.join(branchDir, 's3-check.json');
  const s3: S3File | null = fs.existsSync(s3File) ? JSON.parse(fs.readFileSync(s3File, 'utf8')) : null;
  const html = fs.readFileSync(path.join(branchDir, report), 'utf8');
  const gates: UiGate[] = fs.existsSync(uiFile) ? JSON.parse(fs.readFileSync(uiFile, 'utf8')) : [];
  const unmapped: string[] = []; let mappedTables = 0;

  let h2 = '', h3 = '', h4 = '';
  let same = 0, differ = 0, missing = 0;
  const re = /<h([234])[^>]*>([\s\S]*?)<\/h\1>|<table class="grid">[\s\S]*?<\/table>/g;
  let out = html.replace(re, (m: string, lvl?: string, title?: string) => {
    if (lvl) {
      if (lvl === '2') { h2 = title!; h3 = ''; h4 = ''; }
      else if (lvl === '3') { h3 = title!; h4 = ''; }
      else h4 = title!;
      return m;
    }
    const heads = [h2, h3, h4].filter(Boolean).map(norm);
    const last = heads[heads.length - 1];
    // UI gates that belong to this table: the technique (h2/h3) or the sub-item (h3/h4) name matches
    const related = gates.filter((g) => heads.includes(norm(g.technique)) || heads.includes(norm(g.sub)));
    const exact = related.filter((g) => norm(g.sub) === last || norm(g.technique) === last);
    const pool = exact.length ? exact : related;

    // S3 checks that belong to this table: the technique name is one of the headings (testing type breaks ties)
    let s3Rows: S3Check[] = [];
    if (s3) {
      const byTech = s3.checks.filter((c) => heads.includes(norm(c.technique)));
      const byType = byTech.filter((c) => heads.includes(norm(c.testingType)));
      s3Rows = byType.length ? byType : byTech;
      if (s3Rows.length) mappedTables++; else unmapped.push(heads.join(' › '));
    }
    // checks of one table row: the technique's general check per language, replaced by the language's own check when this classification has one
    const checksFor = (name: string) => {
      const own = s3Rows.filter((c) => c.classifications?.some((x) => norm(x) === norm(name)));
      const taken = new Set(own.map((c) => c.language));
      return s3Rows.filter((c) => (!c.classifications && !taken.has(c.language)) || own.includes(c));
    };
    const sigOf = (cs: S3Check[]) => JSON.stringify(cs.map((c) => [c.language, c.tool, c.result, c.note, c.files, c.secondary]));
    const s3Cells = (span: number, s3Rows: S3Check[]) => {
      if (!s3) return '';
      const rs = span > 1 ? ` rowspan="${span}"` : '';
      if (!s3Rows.length) return `<td class="s3-cell s3-none"${rs} title="no tool mapping for this technique">—</td>\n    <td class="s3-cell s3-none"${rs}>no tool mapped to this technique</td>`;
      const multi = new Set(s3Rows.map((c) => c.language)).size > 1;
      const tag = (c: S3Check) => (multi ? `<span class="s3-lang">${LANG[c.language] || c.language}</span> ` : '');
      const tools = s3Rows.map((c) => {
        const links = c.files.map((f) => {
          const name = f.split('/').pop();
          const local = 's3-evidence/' + f.split('/').map(encodeURIComponent).join('/');
          const cloud = `https://us-east-2.console.aws.amazon.com/s3/object/${s3Bucket}?region=${awsRegion}&prefix=${encodeURIComponent(s3.s3_path + f)}`;
          return `<a href="${local}" target="_blank" title="saved copy of ${esc(f)}">${esc(name || f)}</a> <a class="s3-cloud" href="${cloud}" target="_blank" title="open in the S3 console">S3</a>`;
        });
        return `<div class="s3-line">${tag(c)}<b>${esc(c.tool)}</b>${c.secondary ? ` <span class="s3-sec" title="primary tool ${esc(c.primary || '')} was not found / not applicable in this run">secondary</span>` : ''}${links.length ? '<br>' + links.join('<br>') : '<br><span class="s3-none">no json file</span>'}</div>`;
      }).join('');
      const notes = s3Rows.map((c) => `<div class="s3-line">${tag(c)}<span class="rp ${RP[c.result]}">${c.result}</span> ${c.secondary ? `<i class="s3-sec-note">secondary tool ${esc(c.tool)} used — primary ${esc(c.primary || '')} not found or N/A.</i> ` : ''}${esc(c.note)}</div>`).join('');
      return `<td class="s3-cell"${rs}>${tools}</td>\n    <td class="s3-cell"${rs}>${notes}</td>`;
    };

    let t = m.replace('</tr></thead>', `<th>UI value</th>${s3 ? '<th>Tool / JSON</th><th>S3 comment</th>' : ''}\n    </tr></thead>`);
    const dataRows = (t.match(/<tr>[\s\S]*?<\/tr>/g) || []).filter((r) => !r.includes('<th>')).length;
    let rowNo = 0;
    // rows whose classification has its own S3 check (primary tool N/A) form their own group; the others share one cell per run of rows
    const rowNames = (t.match(/<tr>[\s\S]*?<\/tr>/g) || []).filter((r) => !r.includes('<th>')).map((r) => plain((/<div class="cls-name">([\s\S]*?)<\/div>/.exec(r) || [])[1] || ''));
    const rowChecks = rowNames.map((n) => checksFor(n));
    const rowSigs = rowChecks.map(sigOf);
    const groupSize = (i: number) => { let k = 1; while (i + k < rowSigs.length && rowSigs[i + k] === rowSigs[i]) k++; return k; }; // consecutive rows with the same S3 result share one cell
    t = t.replace(/<tr>[\s\S]*?<\/tr>/g, (tr, offset: number) => {
      if (tr.includes('<th>')) return tr; // header row
      rowNo++;
      const name = plain((/<div class="cls-name">([\s\S]*?)<\/div>/.exec(tr) || [])[1] || '');
      const reportVal = plain((/<td class="value-cell">([\s\S]*?)<\/td>/.exec(tr) || [])[1] || '');
      const hit = pool.flatMap((g) => g.rows).find((r) => norm(r.classification) === norm(name))
        || (() => { // last resort: only when every gate on the UI that has this classification shows the same value (never guess between techniques)
          const all = gates.flatMap((g) => g.rows).filter((r) => norm(r.classification) === norm(name));
          return all.length && new Set(all.map((r) => cmp(r.value))).size === 1 ? all[0] : undefined; // one gate, or several showing the same value
        })();
      let cell: string;
      if (!hit) { missing++; cell = '<td class="ui-cell ui-missing" title="not found on the UI">—</td>'; }
      else if (cmp(hit.value) === cmp(reportVal)) { same++; cell = `<td class="ui-cell">${esc(hit.value)}</td>`; }
      else { differ++; cell = `<td class="ui-cell ui-diff" title="taxonomy report: ${esc(reportVal)}">${esc(hit.value)}</td>`; }
      return tr.replace(/<\/tr>$/, `${cell}${rowNo === 1 || rowSigs[rowNo - 1] !== rowSigs[rowNo - 2] ? `\n    ${s3Cells(groupSize(rowNo - 1), rowChecks[rowNo - 1])}` : ''}</tr>`);
    });
    return t;
  });

  const css = `<style>table.grid{table-layout:fixed}table.grid th:nth-child(1){width:15%}table.grid th:nth-child(2){width:7%}table.grid th:nth-child(3){width:7%}table.grid th:nth-child(4){width:9%}table.grid th:nth-child(5){width:7%}table.grid th:nth-child(6){width:8%}table.grid th:nth-child(7){width:20%}table.grid th:nth-child(8){width:27%}table.grid td.classification-cell{max-width:none;word-break:break-word}table.grid td{overflow-wrap:anywhere}table.grid td:not(.s3-cell) .rp{white-space:nowrap;display:inline-block;min-width:60px;text-align:center}table.grid td:last-child{font-family:inherit;font-variant-numeric:normal}.s3-cell{vertical-align:top}.s3-line{margin:0 0 10px;line-height:1.35}.s3-lang{display:inline-block;font-size:10px;font-weight:700;background:#e7e5e4;border-radius:4px;padding:0 5px}.s3-cell a{color:#1d4ed8;text-decoration:none;word-break:break-all}.s3-cell a:hover{text-decoration:underline}.s3-cloud{font-size:10px;border:1px solid #bfdbfe;border-radius:4px;padding:0 4px;margin-left:4px}.s3-none{color:#a8a29e}.s3-sec{display:inline-block;font-size:10px;font-weight:700;background:#fef3c7;color:#92400e;border:1px solid #fde68a;border-radius:4px;padding:0 5px}.s3-sec-note{color:#92400e;font-style:normal}.s3-cell .rp{min-width:0;padding:1px 6px;font-size:10px;margin-right:4px}.ui-cell{font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}.ui-diff{background:#fee2e2;color:#991b1b}.ui-missing{color:#a8a29e;font-weight:400}</style>`;
  out = out.replace('</head>', `${css}</head>`);
  // S3 location the evidence was read from — shown at the very top of the report
  if (s3) {
    const bucket = s3Bucket;
    const link = `https://us-east-2.console.aws.amazon.com/s3/buckets/${bucket}?region=us-east-2&prefix=${encodeURIComponent(s3.s3_path)}`;
    const box = `<div style="margin:10px 16px;padding:10px 14px;border:1px solid #c7d2fe;background:#eef2ff;border-radius:8px;font:13px/1.5 system-ui,sans-serif;color:#1e1b4b"><b>S3 evidence path</b><br><code style="word-break:break-all;user-select:all">s3://${esc(bucket)}/${esc(s3.s3_path)}</code><br><a href="${esc(link)}" target="_blank" rel="noopener">Open in the AWS console</a> (needs sign-in)${s3.languages?.length ? ` · languages: ${esc(s3.languages.join(', '))}` : ''}</div>`;
    out = /<body[^>]*>/.test(out) ? out.replace(/<body[^>]*>/, (t) => t + box) : box + out;
  }
  // keep the tool line and its comment line of each language at the same height
  const align = `<script>document.addEventListener('DOMContentLoaded',function(){document.querySelectorAll('td.s3-cell').forEach(function(a){var b=a.nextElementSibling;if(!b||!b.classList.contains('s3-cell')||a.classList.contains('s3-none'))return;var x=a.querySelectorAll('.s3-line'),y=b.querySelectorAll('.s3-line');for(var i=0;i<x.length&&i<y.length;i++){var h=Math.max(x[i].offsetHeight,y[i].offsetHeight);x[i].style.minHeight=h+'px';y[i].style.minHeight=h+'px';}});});</script>`;
  out = out.includes('</body>') ? out.replace('</body>', `${align}</body>`) : out + align;
  const dest = path.join(branchDir, report.replace(/\.html$/i, '-with-ui-values.html'));
  fs.writeFileSync(dest, out);
  console.log(`  Taxonomy + UI value column: ${dest}  (same ${same}, different ${differ}, not on UI ${missing})`);
  if (s3) console.log(`  S3 columns: ${mappedTables} tables mapped to a tool${unmapped.length ? `; no tool mapping for: ${unmapped.join(' | ')}` : ''}`);
  return dest;
}
