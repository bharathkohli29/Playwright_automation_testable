import * as fs from 'fs';
import * as path from 'path';

/**
 * "Screenshot of the issue" for the RCA reports: the picture is embedded in the PDF itself (a data address), so the PDF can be sent on its own.
 * Where the pictures come from:
 *   - a failed step of the script: <branch folder>/errors/failure.png (saved by the script when the step failed)
 *   - an issue described by hand:  npm run rca:issue -- "..." --screenshot <file> [--screenshot <file2>]
 * A picture larger than 8 MB or not a png / jpg / jpeg / webp / gif is left out and said so; a missing file is skipped. Never throws.
 */
const MAX_BYTES = 8 * 1024 * 1024;
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** the screenshots that exist for a branch folder (the failure picture of the script) */
export function folderShots(branchDir: string): string[] {
  const f = path.join(branchDir, 'errors', 'failure.png'); return fs.existsSync(f) ? [f] : [];
}

export function screenshotHtml(files: string[]): string {
  const parts: string[] = [];
  for (const f of files) {
    try {
      if (!fs.existsSync(f)) continue; const mime = MIME[path.extname(f).toLowerCase()];
      if (!mime) { parts.push(`<p class="small">${esc(path.basename(f))}: not a picture type that can be embedded (png, jpg, webp, gif).</p>`); continue; }
      const size = fs.statSync(f).size; if (size > MAX_BYTES) { parts.push(`<p class="small">${esc(path.basename(f))} is ${(size / 1048576).toFixed(1)} MB and was left out (limit 8 MB).</p>`); continue; }
      const when = fs.statSync(f).mtime.toISOString().slice(0, 19).replace('T', ' ');
      parts.push(`<figure style="margin:8px 0;page-break-inside:avoid"><img src="data:${mime};base64,${fs.readFileSync(f).toString('base64')}" style="max-width:100%;max-height:230mm;border:1px solid #d1d5db;border-radius:4px" alt="${esc(path.basename(f))}"><figcaption class="small">${esc(path.basename(f))} · ${when} UTC</figcaption></figure>`);
    } catch { /* an unreadable picture is skipped */ }
  }
  return parts.length ? `<h2>Screenshot of the issue</h2>${parts.join('')}` : '';
}
