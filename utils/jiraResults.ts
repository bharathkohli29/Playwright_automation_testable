import * as path from 'path';
import type { RunFacts } from './jiraFacts';

/** Tool_Execution_Results_<run8>_<branch>_<dd-mm-yyyy>.xlsx: one row per expected tool of the run (what S3 and the platform showed), written next to the run files and attached to the ticket */
export const resultsName = (f: RunFacts, ext: string) => `Tool_Execution_Results_${f.short}_${f.branch}_${f.date}.${ext}`;

export async function writeResultsXlsx(f: RunFacts): Promise<string | undefined> {
  try {
    const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Tool execution');
    ws.columns = [{ header: 'Tool', width: 24 }, { header: 'Role', width: 12 }, { header: 'S3 state', width: 16 }, { header: 'Verdict', width: 12 }, { header: 'Metrics', width: 60 }, { header: 'Note', width: 80 }];
    const bug = new Set(f.bugs.map((b) => b.tool));
    for (const r of f.rows) { const row = ws.addRow([r.tool, r.kind, r.state, bug.has(r.tool) ? 'BUG' : r.verdict, r.metrics, r.note]); if (bug.has(r.tool)) row.getCell(4).font = { bold: true, color: { argb: 'FFC00000' } }; }
    ws.getRow(1).font = { bold: true }; ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.addRow([]); ws.addRow([`Run ${f.runId}`, `${f.language} ${f.fullVersion}`, f.branch, f.date]);
    const file = path.join(f.dir, resultsName(f, 'xlsx')); await wb.xlsx.writeFile(file); return file;
  } catch { return undefined; }
}
