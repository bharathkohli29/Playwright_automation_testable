import * as fs from 'fs';
import * as path from 'path';
import './env'; // loads .env
import { buildFactPack, defectiveTools } from './rcaFacts';
import { writeReport } from './rcaWriter';

/**
 * Bake-off of base models for the RCA writer:   npm run rca:bakeoff -- "<branch folder>" [more folders]
 * RCA_BAKEOFF_MODELS="qwen3:4b,qwen2.5:3b-instruct,llama3.2:3b"   (comma list; each must already be pulled: ollama pull <name>)
 * Every model writes the report of every defective tool of the folder(s) with the SAME prompt and checks. Printed per model:
 *   accepted = answers that passed every check · fallback = answers thrown away (reason shown) · average seconds.
 * The reports themselves are written to  results/rca-bakeoff/<model>/<folder>/<tool>.md  so two people can score the wording (1 to 5).
 */
const dirs = process.argv.slice(2).filter((d) => fs.existsSync(d));
const models = (process.env.RCA_BAKEOFF_MODELS || 'rca-writer').split(',').map((s) => s.trim()).filter(Boolean);
if (!dirs.length) { console.log('Usage: npm run rca:bakeoff -- "<branch folder>" [...]   (RCA_BAKEOFF_MODELS=a,b,c)'); process.exit(1); }
(async () => {
  const out = path.join(__dirname, '..', 'results', 'rca-bakeoff'); const rows: string[] = ['model,folder,tool,used,seconds,note'];
  for (const model of models) {
    let ok = 0, fb = 0, secs = 0; const why: Record<string, number> = {};
    for (const d of dirs) for (const tool of defectiveTools(path.resolve(d))) {
      const p = buildFactPack(path.resolve(d), tool); const w = await writeReport(p, { model });
      const f = path.join(out, model.replace(/[^\w.-]+/g, '_'), path.basename(path.resolve(d))); fs.mkdirSync(f, { recursive: true });
      fs.writeFileSync(path.join(f, `${tool}.md`), `${w.used === 'model' ? '' : `<!-- NOT ACCEPTED: ${w.note} -->\n`}${JSON.stringify(w.report, null, 2)}\n`);
      if (w.used === 'model') ok++; else { fb++; const k = (w.note || '').replace(/^rule-written report used: /, '').replace(/\d+/g, '#').slice(0, 60); why[k] = (why[k] || 0) + 1; }
      secs += (w.ms || 0) / 1000; rows.push([model, path.basename(path.resolve(d)), tool, w.used, ((w.ms || 0) / 1000).toFixed(1), `"${(w.note || '').replace(/"/g, "'")}"`].join(','));
    }
    console.log(`${model.padEnd(28)} accepted ${ok}  fallback ${fb}  avg ${(secs / Math.max(1, ok + fb)).toFixed(1)}s${fb ? `   fallback reasons: ${Object.entries(why).map(([k, v]) => `${v}× ${k}`).join('; ')}` : ''}`);
  }
  fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'bakeoff.csv'), rows.join('\n') + '\n');
  console.log(`reports and bakeoff.csv: ${out}`);
})();
