import * as fs from 'fs';
import * as path from 'path';

/**
 * SharePoint upload (add-on), through a OneDrive shortcut.
 * In SharePoint open the day's folder (e.g. 22-10-2026) → "Add shortcut to OneDrive". It then shows on this PC as
 *   C:\Users\<you>\OneDrive - <company>\Shortcuts\Testable - Execution team - 22-10-2026
 * Put that path in .env as SHAREPOINT_DIR. After each branch finishes, its whole results folder is copied in there
 * (<SHAREPOINT_DIR>\<branch folder>) and OneDrive uploads it to SharePoint by itself.
 * Empty SHAREPOINT_DIR = off. Never throws — a copy problem can not affect the run.
 */
export const sharepointDir = () => (process.env.SHAREPOINT_DIR || '').trim().replace(/^["']|["']$/g, '');

function copyTree(from: string, to: string, stats: { files: number; bytes: number; failed: string[] }) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const a = path.join(from, name);
    const b = path.join(to, name);
    try {
      if (fs.statSync(a).isDirectory()) copyTree(a, b, stats);
      else { fs.copyFileSync(a, b); stats.files++; stats.bytes += fs.statSync(a).size; }
    } catch (e) { stats.failed.push(`${path.relative(from, a) || name}: ${e instanceof Error ? e.message : e}`); }
  }
}

/** Copies the branch folder into SHAREPOINT_DIR. Returns a one-line result (also printed). */
export function uploadBranchToSharePoint(branchFolder: string): string {
  const root = sharepointDir();
  if (!root) return '';
  try {
    if (!fs.existsSync(root)) {
      const m = `SharePoint: folder not found: ${root} — add the day's folder as a shortcut in OneDrive and set SHAREPOINT_DIR in .env (copy skipped)`;
      console.log(`  ${m}`);
      return m;
    }
    if (!fs.existsSync(branchFolder)) return '';
    const target = path.join(root, path.basename(branchFolder));
    const stats = { files: 0, bytes: 0, failed: [] as string[] };
    copyTree(branchFolder, target, stats);
    const mb = (stats.bytes / 1024 / 1024).toFixed(1);
    let m = `SharePoint: copied ${stats.files} file(s), ${mb} MB to ${target} — OneDrive uploads it now`;
    if (stats.failed.length) {
      m += `\n  SharePoint: ${stats.failed.length} file(s) could not be copied (first: ${stats.failed[0]})`;
      fs.writeFileSync(path.join(branchFolder, 'sharepoint-copy-errors.txt'), stats.failed.join('\n') + '\n');
    }
    console.log(`  ${m}`);
    return m;
  } catch (e) {
    const m = `SharePoint: not copied (${e instanceof Error ? e.message : e}) — the run is not affected`;
    console.log(`  ${m}`);
    return m;
  }
}

/**
 * Link to this branch's folder in SharePoint, for the Teams card. Needs SHAREPOINT_URL in .env = the address-bar URL of the day's folder
 * (open it in SharePoint, copy the address from the browser, NOT the "Copy link" button). Empty (or SHAREPOINT_DIR empty) = no link.
 */
export function sharepointBranchUrl(branchFolder: string): string {
  const base = (process.env.SHAREPOINT_URL || '').trim().replace(/^["']|["']$/g, '');
  if (!base || !sharepointDir()) return '';
  if (/\/:[a-z]:\//i.test(base)) { console.log('  SharePoint link: SHAREPOINT_URL is a "Copy link" sharing link — use the address-bar URL of the day folder instead (no button added)'); return ''; }
  try {
    const name = path.basename(branchFolder);
    const u = new URL(base);
    const id = u.searchParams.get('id');
    if (id) { u.searchParams.set('id', `${id.replace(/\/+$/, '')}/${name}`); u.searchParams.delete('viewid'); }
    else {
      // plain folder path (https://host/sites/<site>/<library>/<folders>/<day>) -> the folder-view address SharePoint really opens
      const full = decodeURIComponent(u.pathname).replace(/\/+$/, '');
      const parts = full.split('/').filter(Boolean); // sites, <site>, <library>, ...
      if (parts[0] === 'sites' && parts.length >= 4) {
        u.pathname = `/${parts.slice(0, 3).map(encodeURIComponent).join('/')}/Forms/AllItems.aspx`;
        u.search = '';
        u.searchParams.set('id', `${full}/${name}`);
      } else u.pathname = `${u.pathname.replace(/\/+$/, '')}/${encodeURIComponent(name)}`;
    }
    return u.toString().replace(/\+/g, '%20');
  } catch { return ''; }
}
