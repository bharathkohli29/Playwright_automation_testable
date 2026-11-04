import * as fs from 'fs';
import * as path from 'path';

/**
 * Dry run of the post-processing: POST_DRYRUN=1 in .env (or  npm run post -- "<branch folder>" --dry-run).
 * Everything that only READS still runs (EKS logs, S3 check, the RCA Report with its local model, bug drafts, SharePoint history). The two things that leave this PC are not done,
 * they are shown instead: the SharePoint upload (what would be copied, where) and the Teams card (its text, buttons and size; the full card is saved
 * as <branch folder>/teams-card.dryrun.json). Use it to test a new .env without filling the team's channel and folder.
 */
export const dryRun = () => /^(1|yes|on|true)$/i.test((process.env.POST_DRYRUN || '').trim());

const WEBHOOK_LIMIT = 28_000; // the Teams webhook refuses bigger messages

const walk = (dir: string): { n: number; bytes: number } => {
  let n = 0, bytes = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = walk(p); n += r.n; bytes += r.bytes; } else { n++; bytes += fs.statSync(p).size; }
  }
  return { n, bytes };
};

/** what the SharePoint upload would do */
export function drySharePoint(branchDir: string, day: string): string {
  try {
    const r = walk(branchDir);
    const msg = `DRY RUN, SharePoint: would upload ${r.n} file(s), ${(r.bytes / 1048576).toFixed(1)} MB from ${branchDir} to <evidence folder>/${day}/${path.basename(branchDir)} (_RUN2, _RUN3 ... if that folder exists). Nothing was uploaded.`;
    console.log(`  ${msg}`); return msg;
  } catch (e) { const msg = `DRY RUN, SharePoint: could not read ${branchDir} (${e instanceof Error ? e.message : e})`; console.log(`  ${msg}`); return msg; }
}

/** what the Teams message would be; returns true (as if sent) */
export function dryTeams(payload: any, dir?: string): boolean {
  const body: any[] = payload?.attachments?.[0]?.content?.body || [];
  const texts = body.filter((b) => b.type === 'TextBlock').map((b) => String(b.text).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim());
  const buttons = body.filter((b) => b.type === 'ActionSet').flatMap((b) => b.actions || []).map((a: any) => a.title);
  const tables = body.filter((b) => b.type === 'Table').length;
  const size = JSON.stringify(payload).length;
  console.log(`  DRY RUN, Teams: would send a card of ${(size / 1024).toFixed(1)} KB${size > WEBHOOK_LIMIT ? ` (OVER the ${WEBHOOK_LIMIT / 1000} KB webhook limit: Teams would refuse it)` : ''}, ${texts.length} text line(s), ${tables} table(s), buttons: ${buttons.join(' | ') || 'none'}`);
  for (const t of texts.slice(0, 6)) console.log(`      ${t.slice(0, 150)}`);
  if (texts.length > 6) console.log(`      ... ${texts.length - 6} more line(s) in the saved card`);
  try {
    if (dir) {
      const out = path.join(dir, '..', 'dryrun'); fs.mkdirSync(out, { recursive: true });
      const file = path.join(out, `${path.basename(dir)}-teams-card.json`); fs.writeFileSync(file, JSON.stringify(payload, null, 2));
      console.log(`      full card: ${file}. Nothing was sent.`);
    }
  } catch { /* preview only */ }
  return true;
}
