import * as fs from 'fs';
import * as path from 'path';

/**
 * One page for the whole round: <round folder>/summary.md, rebuilt after every branch's post-processing from what the branch folders hold
 * (postprocess.json, s3-check.json, eks-rca/, warnings.log). One row per branch: language and version, tool results, defects, the state of each
 * post-processing step. Read only apart from writing summary.md; never throws.
 */
const rj = (p: string): any => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const LANGS: [string, string][] = [['python', 'Python'], ['javascript', 'JavaScript'], ['typescript', 'TypeScript'], ['csharp', 'C#'], ['java', 'Java']];

export function writeRoundSummary(branchDir: string): string | null {
  try {
    const round = path.dirname(path.resolve(branchDir));
    const rows: string[] = [];
    for (const e of fs.readdirSync(round, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const d = path.join(round, e.name);
      const post = rj(path.join(d, 'postprocess.json')); const s3 = rj(path.join(d, 's3-check.json')); const rd = rj(path.join(d, 'run-details.json'));
      if (!post && !s3 && !rd) continue;
      let lang = '-', tools = '-', defects = '-';
      if (s3) {
        const parts: string[] = []; const t: string[] = []; let nd = 0;
        for (const [k, name] of LANGS) { const b = s3[k]; if (!b || !b.version) continue; parts.push(`${name} ${b.version}`); t.push(`${b.ok + b.clean}/${b.expected} ok`); nd += (b.defects || []).length; }
        if (parts.length) { lang = parts.join(', '); tools = t.join(', '); defects = String(nd); }
      } else if (fs.existsSync(path.join(d, 'eks-rca'))) { tools = 'S3 not available'; defects = `${(fs.readdirSync(path.join(d, 'eks-rca')).filter((f) => /^RCA_/.test(f))).length} (EKS logs only)`; }
      const steps = post ? Object.entries(post.steps || {}).map(([k, v]) => `${k} ${v}`).join(', ') : 'not post-processed';
      const warns = (() => { try { return fs.readFileSync(path.join(d, 'warnings.log'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } })();
      rows.push(`| ${e.name} | ${(rd?.run_id || s3?.run_id || '-').toString().slice(0, 8)} | ${lang} | ${tools} | ${defects} | ${post?.state || '-'} | ${steps}${warns ? `; ${warns} warning(s)` : ''} |`);
    }
    if (!rows.length) return null;
    const file = path.join(round, 'summary.md');
    fs.writeFileSync(file, [`# Round summary: ${path.basename(round)}`, '', `Updated ${new Date().toISOString()}. Rebuilt after every branch; the details are in each branch folder.`, '',
      '| Branch | Run | Language | Tools | Defects | Post-processing | Steps |', '|---|---|---|---|---|---|---|', ...rows.sort(), ''].join('\n'));
    return file;
  } catch { return null; }
}
