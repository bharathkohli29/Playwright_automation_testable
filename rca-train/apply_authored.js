// Writes the authored answers (authored.json) into review.xlsx as EDIT decisions, so the normal import turns them into train.jsonl / holdout.jsonl.
// Usage: node rca-train/apply_authored.js <export dir> "<reviewer name>"
const fs = require('fs'); const path = require('path'); const ExcelJS = require('exceljs');
(async () => {
  const dir = path.resolve(process.argv[2]); const who = process.argv[3] || 'reviewer';
  const A = JSON.parse(fs.readFileSync(path.join(dir, 'authored.json'), 'utf8'));
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path.join(dir, 'review.xlsx')); const ws = wb.getWorksheet('Review');
  const col = {}; ws.getRow(1).eachCell((c, i) => { col[String(c.value)] = i; });
  const C = { id: col.id, dec: col['DECISION (OK / EDIT / SKIP)'], one: col['corrected: one sentence'], what: col['corrected: what happened (one sentence per line)'], why: col['corrected: why'], imp: col['corrected: impact'], fix: col['corrected: what to do'], who: col.reviewer, note: col.note };
  let n = 0;
  ws.eachRow((row, i) => { if (i === 1) return; const a = A[row.getCell(C.id).text]; if (!a) return;
    row.getCell(C.dec).value = 'EDIT'; row.getCell(C.one).value = a.oneLine; row.getCell(C.what).value = a.whatHappened.join('\n'); row.getCell(C.why).value = a.why; row.getCell(C.imp).value = a.impact; row.getCell(C.fix).value = a.fix;
    row.getCell(C.who).value = who; row.getCell(C.note).value = `authored from the facts (${a.category})`; n++; });
  await wb.xlsx.writeFile(path.join(dir, 'review.xlsx')); console.log(`${n} case(s) written as EDIT by "${who}"`);
})();
