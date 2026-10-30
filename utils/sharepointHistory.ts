import * as fs from 'fs';
import * as path from 'path';
import { graphConfigured, graphListFolders, graphReadText } from './sharepointGraph';
import { sessionSaved, withSession } from './sharepointSession';
import { runStamp, ToolRow } from './toolLog';

/**
 * The EARLIER run of a branch, read from SharePOINT (the team evidence folder), not from this PC:
 *   Automation Evidences Dump / <DD-MM-YYYY> / <branch> or <branch>_RUN2 ... / s3-check.json   (its per-tool rows, "tools")
 * The newest earlier folder of this branch that holds tool rows for a language of this run is used; the folder of the run itself is
 * skipped (same run_id). The result is written to <branch folder>/previous-tools.json, which the Teams card reads.
 * Works with the own sign-in session (npm run sp:login) or with Microsoft Graph. Never throws.
 */
export interface PreviousFile { date: string; time: string; source: string; langs: Record<string, ToolRow[]> }
interface Reader { list(segs: string[]): Promise<{ name: string; created: string }[]>; read(segs: string[]): Promise<string | null> }

const DAY = /^(\d{2})-(\d{2})-(\d{4})$/;
const LANG_KEYS = ['python', 'javascript', 'typescript', 'csharp', 'java'];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const p2 = (n: number) => String(n).padStart(2, '0');

/** exported for the tests */
export async function findPrevious(reader: Reader, branchFolder: string, keys: string[], currentRunId: string, maxDay?: number, maxDays = 90, maxReads = 15): Promise<PreviousFile | null> {
  // maxDay (yyyymmdd) = the day of the run being processed: runs of LATER days are never an "earlier run" (matters when an old branch is processed again)
  const days = (await reader.list([])).map((f) => ({ f, m: DAY.exec(f.name) })).filter((x) => x.m).filter((x) => maxDay === undefined || Number(`${x.m![3]}${x.m![2]}${x.m![1]}`) <= maxDay)
    .sort((a, b) => Number(`${b.m![3]}${b.m![2]}${b.m![1]}`) - Number(`${a.m![3]}${a.m![2]}${a.m![1]}`)).slice(0, maxDays);
  const re = new RegExp(`^${esc(branchFolder)}(?:_RUN(\\d+))?$`);
  let reads = 0;
  for (const d of days) {
    const mine = (await reader.list([d.f.name])).map((k) => ({ k, m: re.exec(k.name) })).filter((x) => x.m)
      .sort((a, b) => Number(b.m![1] || 1) - Number(a.m![1] || 1)); // _RUN3 before _RUN2 before the first run of the day
    let list = mine;
    if (maxDay !== undefined && currentRunId && Number(`${d.m![3]}${d.m![2]}${d.m![1]}`) === maxDay) {
      // the day of this run: later runs of the same day (a higher _RUN number than this run's own folder) are not "earlier"
      let selfNum: number | undefined;
      for (const x of mine) {
        if (reads++ >= maxReads) return null;
        const t = await reader.read([d.f.name, x.k.name, 's3-check.json']); let o: any = null; try { o = t ? JSON.parse(t) : null; } catch { /* ignore */ }
        if (o && o.run_id === currentRunId) { selfNum = Number(x.m![1] || 1); break; }
      }
      if (selfNum !== undefined) list = mine.filter((x) => Number(x.m![1] || 1) < selfNum!);
    }
    for (const { k } of list) {
      if (reads++ >= maxReads) return null;
      const txt = await reader.read([d.f.name, k.name, 's3-check.json']); if (!txt) continue;
      let j: any; try { j = JSON.parse(txt); } catch { continue; }
      if (currentRunId && j.run_id === currentRunId) continue; // that is this run itself
      const langs: Record<string, ToolRow[]> = {};
      for (const key of keys) if (Array.isArray(j[key]?.tools) && j[key].tools.length) langs[key] = j[key].tools;
      if (!Object.keys(langs).length) continue;
      const t = k.created ? new Date(k.created) : null;
      return { date: `${d.f.name.replace(/-/g, '/')}`, time: t && !isNaN(t.getTime()) ? `${p2(t.getHours())}:${p2(t.getMinutes())}` : '', source: `${d.f.name}/${k.name}`, langs };
    }
  }
  return null;
}

/** Looks the earlier run up on SharePoint and saves <branch folder>/previous-tools.json (removes an old one when nothing is found). Returns a one-line result. */
export async function attachPreviousFromSharePoint(branchDir: string): Promise<string> {
  const file = path.join(branchDir, 'previous-tools.json');
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  const sc = path.join(branchDir, 's3-check.json');
  if (!fs.existsSync(sc)) return 'skipped';
  const j = JSON.parse(fs.readFileSync(sc, 'utf8'));
  const keys = LANG_KEYS.filter((k) => Array.isArray(j[k]?.tools) && j[k].tools.length);
  if (!keys.length) return 'skipped';
  const branchFolder = path.basename(path.resolve(branchDir));
  const st = runStamp(path.basename(path.dirname(path.resolve(branchDir)))); // results/merge-flow_<date>_<time>/<branch>
  const maxDay = st ? Number(st.date.split('/').reverse().join('')) : undefined;
  let found: PreviousFile | null;
  if (graphConfigured()) found = await findPrevious({ list: graphListFolders, read: graphReadText }, branchFolder, keys, String(j.run_id || ''), maxDay);
  else if (sessionSaved()) found = await withSession((s) => findPrevious({ list: (x) => s.listFolders(x), read: (x) => s.readText(x) }, branchFolder, keys, String(j.run_id || ''), maxDay));
  else { console.log('  Earlier run: SharePoint is not set up on this PC (npm run sp:login), so the card has no comparison'); return 'skipped'; }
  if (!found) { console.log(`  Earlier run: no earlier run of ${branchFolder} with tool rows on SharePoint`); return 'none found'; }
  fs.writeFileSync(file, JSON.stringify(found, null, 1));
  console.log(`  Earlier run: ${found.source} on SharePoint (${found.date}${found.time ? ' ' + found.time : ''})`);
  return `compared with ${found.source}`;
}
