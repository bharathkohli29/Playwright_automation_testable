import * as fs from 'fs';
import * as path from 'path';
import { sessionFileRequest, sessionSaved } from './sharepointSession';

/**
 * QA EKS logs of a run that was NOT executed on this PC (post-processing from a run id, or a re-run of the post step): the live collector of the
 * PC that ran the test saved <branch>/eks-live/ into the team SharePoint folder with the rest of the evidence. This step finds that folder
 * (<DD-MM-YYYY>/<branch>[_RUNn]/eks-live whose summary.json has THIS run id), and downloads it (read only) into <branch folder>/eks-live/, so the
 * bug drafts explain the tools from the real pod logs. Skipped when eks-live is already here, when there is no saved sign-in (npm run sp:login),
 * or when no folder of that run exists. Never throws.
 */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const say = (m: string) => console.log(`  QA EKS logs: ${m}`);
const get = (segs: string[]) => { const b = sessionFileRequest(segs); return { url: b.url, headers: b.headers }; };
const folderUrl = (segs: string[]) => get(segs).url.replace('GetFileByServerRelativePath', 'GetFolderByServerRelativePath').replace(/\/\$value$/, '');

async function api(segs: string[], kind: string): Promise<any[]> {
  const b = get(segs);
  const r = await fetch(`${folderUrl(segs)}/${kind}`, { headers: { ...b.headers, Accept: 'application/json;odata=nometadata' }, redirect: 'manual' });
  if (r.status >= 300 && r.status < 400) throw new Error('SharePoint sign-in expired: run  npm run sp:login');
  if (!r.ok) return [];
  return (((await r.json()) as any).value || []) as any[];
}
async function readText(segs: string[]): Promise<string | null> {
  const b = get(segs); const r = await fetch(b.url, { headers: b.headers, redirect: 'manual' });
  return r.ok ? await r.text() : null;
}
async function download(segs: string[], out: string, counter: { files: number; bytes: number }) {
  fs.mkdirSync(out, { recursive: true });
  for (const f of await api(segs, 'Files?$select=Name')) {
    const b = get([...segs, f.Name]); const r = await fetch(b.url, { headers: b.headers, redirect: 'manual' });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${f.Name}`);
    const buf = Buffer.from(await r.arrayBuffer()); fs.writeFileSync(path.join(out, f.Name), buf); counter.files++; counter.bytes += buf.length;
  }
  for (const d of await api(segs, 'Folders?$select=Name')) if (d.Name !== 'Forms') await download([...segs, d.Name], path.join(out, d.Name), counter);
}

/** returns a short result for postprocess.json, or 'skipped' */
export async function fetchEksLive(branchDir: string): Promise<string> {
  try {
    if (/^(off|no|0|false)$/i.test((process.env.EKS_LIVE || '').trim())) return 'skipped';
    const rdFile = path.join(branchDir, 'run-details.json'); if (!fs.existsSync(rdFile)) return 'skipped';
    const rd = JSON.parse(fs.readFileSync(rdFile, 'utf8')); const runId = String(rd.run_id || ''); const branch = String(rd.branch_name || path.basename(branchDir));
    if (!runId) return 'skipped';
    const local = path.join(branchDir, 'eks-live', 'summary.json');
    try { if (JSON.parse(fs.readFileSync(local, 'utf8')).run_id === runId) { say('already here (saved by the live collector of this run)'); return 'skipped'; } } catch { /* not here */ }
    if (!sessionSaved()) { say('not on this PC and no SharePoint sign-in saved (npm run sp:login), skipped'); return 'skipped'; }
    const days = (await api([], 'Folders?$select=Name')).map((f) => f.Name as string).filter((n) => /^\d{2}-\d{2}-\d{4}$/.test(n))
      .sort((a, b) => b.split('-').reverse().join('').localeCompare(a.split('-').reverse().join(''))).slice(0, 5);
    const re = new RegExp(`^${esc(branch)}(?:_RUN\\d+)?$`);
    for (const day of days) {
      for (const f of (await api([day], 'Folders?$select=Name')).map((x) => x.Name as string).filter((n) => re.test(n))) {
        const t = await readText([day, f, 'eks-live', 'summary.json']); if (!t) continue;
        let id = ''; try { id = JSON.parse(t).run_id; } catch { /* not json */ }
        if (id !== runId) continue;
        const c = { files: 0, bytes: 0 }; await download([day, f, 'eks-live'], path.join(branchDir, 'eks-live'), c);
        say(`downloaded ${c.files} file(s), ${(c.bytes / 1048576).toFixed(1)} MB from SharePoint ${day}/${f}/eks-live (live capture of run ${runId.slice(0, 8)})`);
        return `${c.files} files from ${day}/${f}`;
      }
    }
    say(`no eks-live folder of run ${runId.slice(0, 8)} on SharePoint (the run was not captured live), skipped`); return 'skipped';
  } catch (e) { say(`failed (${e instanceof Error ? e.message : e}), the other steps continue`); return 'skipped'; }
}
