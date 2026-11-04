import * as fs from 'fs';
import './env'; // loads .env

/**
 * Redaction of a fact pack or a log excerpt BEFORE it may leave the PC (for example to another AI the lead has approved):
 *   no tokens or keys, no e-mails, no URLs, no tenant / project / run / commit ids, no pod hashes, no IP addresses or node names,
 *   no paths into the customer repository (everything after /source/), no Windows paths, and every known repo or branch name you pass in.
 * The same value always gets the same tag (<ID-1>, <ID-2> ...), so the text still reads as one story. The tag-to-value map is returned ONLY so you can
 * read an answer back on this PC: never send it, and never save it next to what you send.
 *   npm run rca:redact -- "<file>" [--known "repo=owner/name" --known "branch=PY_V312_X"] [--map <map.json>]     prints the redacted text
 */
export interface Known { label: string; value: string }
export interface Redaction { text: string; map: Record<string, string> }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SECRETS = [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, /\b(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi];

export function redact(input: string, known: Known[] = []): Redaction {
  const map: Record<string, string> = {}; const seen = new Map<string, string>(); const n: Record<string, number> = {};
  const tag = (kind: string, value: string) => { const k = `${kind}|${value}`; if (!seen.has(k)) { n[kind] = (n[kind] || 0) + 1; const t = `<${kind}-${n[kind]}>`; seen.set(k, t); map[t] = value; } return seen.get(k)!; };
  let t = input;
  for (const k of [...known].filter((x) => x.value && x.value.length > 2).sort((a, b) => b.value.length - a.value.length)) t = t.replace(new RegExp(esc(k.value), 'gi'), () => tag(k.label.toUpperCase(), k.value));
  for (const re of SECRETS) t = t.replace(re, () => '<SECRET>');
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, (m) => tag('EMAIL', m));
  t = t.replace(/https?:\/\/[^\s'")<>]+/g, (m) => tag('URL', m));
  t = t.replace(/\/source\/[^'"\n]*/g, () => '/source/<REPO_PATH>'); // the customer repository's own file names
  t = t.replace(/\b[A-Za-z]:\\[^\s'"]+/g, (m) => tag('WIN_PATH', m));
  t = t.replace(/\bwb-exec-[0-9a-f]{8,}-[a-z0-9]{4,6}\b/g, (m) => 'wb-exec-' + tag('POD', m));
  t = t.replace(/\bip-\d+-\d+-\d+-\d+(?:\.[\w-]+)*/g, (m) => tag('NODE', m));
  t = t.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (m) => tag('ID', m));
  t = t.replace(/\b[0-9a-f]{12,}\b/gi, (m) => tag('HEX', m));
  t = t.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, (m) => tag('IP', m));
  return { text: t, map };
}

if (require.main === module) {
  const a = process.argv.slice(2); const take = (f: string) => { const out: string[] = []; for (let i = a.indexOf(f); i >= 0; i = a.indexOf(f)) out.push(String(a.splice(i, 2)[1])); return out; };
  const known: Known[] = take('--known').map((s) => { const i = s.indexOf('='); return { label: s.slice(0, i), value: s.slice(i + 1) }; }); const mapFile = take('--map')[0];
  if (!a[0] || !fs.existsSync(a[0])) { console.log('Usage: npm run rca:redact -- "<file>" [--known "repo=owner/name" ...] [--map <map.json>]'); process.exit(1); }
  const r = redact(fs.readFileSync(a[0], 'utf8'), known); process.stdout.write(r.text + '\n');
  if (mapFile) { fs.writeFileSync(mapFile, JSON.stringify(r.map, null, 2)); console.error(`map saved to ${mapFile}: keep it on this PC, never send it`); }
}
