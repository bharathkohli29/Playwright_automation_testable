import * as fs from 'fs';
import * as path from 'path';

/**
 * A problem that must not stop the run (a log line that could not be parsed, a snapshot that could not be written ...) used to be swallowed by an
 * empty catch and left no trace. warn() keeps it: one line in <branch folder>/warnings.log (uploaded with the evidence) and, for the first few of
 * each kind, on the console. Never throws.
 */
const shown = new Map<string, number>();
export function warn(branchDir: string | undefined, where: string, e: unknown): void {
  const msg = `${where}: ${e instanceof Error ? e.message : String(e)}`.replace(/\s+/g, ' ').slice(0, 300);
  try { if (branchDir) fs.appendFileSync(path.join(branchDir, 'warnings.log'), `${new Date().toISOString()} ${msg}\n`); } catch { /* the warning itself is best effort */ }
  const n = (shown.get(where) || 0) + 1; shown.set(where, n);
  if (n <= 3) console.log(`  warning: ${msg}${n === 3 ? ' (further warnings of this kind are only in warnings.log)' : ''}`);
}

/** number of lines in <branch folder>/warnings.log (0 when there is none) */
export function warningCount(branchDir: string): number {
  try { return fs.readFileSync(path.join(branchDir, 'warnings.log'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}
