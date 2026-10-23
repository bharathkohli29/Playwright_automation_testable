import type { Language } from './techniqueTools';
/** Rules that turn the json found in a tool folder into a result. */
export type Verdict = 'PASS' | 'EMPTY' | 'FAIL';

const emptyish = (v: unknown): boolean => {
  if (v === null || v === undefined || v === '' || v === 0 || v === false) return true;
  if (Array.isArray(v)) return v.every(emptyish);
  if (typeof v === 'object') return Object.values(v as object).every(emptyish);
  return false;
};

const BAD = /(not[_ -]?applicable|not[_ -]?implemented|not[_ -]?supported|unsupported|fail|error|skip|timeout|timed[_ -]?out|unavailable|not[_ -]?installed|denied|aborted|cancel)/i;
const GOOD = /^(ok|success|succeeded|passed|pass|completed|complete|done|finished|clean)$/i;
const short = (v: unknown) => String(v).replace(/\s+/g, ' ').slice(0, 80);

/** What the tool itself says happened: status / result / reason / error fields (top level, or one level down). */
function outcomeOf(j: any): { text: string; bad: boolean; good: boolean } | null {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  // tool error object, e.g. npm audit: { error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.' } }
  if (j.error && typeof j.error === 'object' && !Array.isArray(j.error) && (j.error.code || j.error.summary || j.error.message)) {
    return { text: `error ${short(j.error.code || '')}${j.error.summary || j.error.message ? ` — ${short(j.error.summary || j.error.message)}` : ''}`.trim(), bad: true, good: false };
  }
  const scopes: any[] = [j, ...['summary', 'result', 'meta', 'metadata', 'run'].map((k) => j[k]).filter((x) => x && typeof x === 'object' && !Array.isArray(x))];
  const pick = (keys: string[]) => { for (const sc of scopes) for (const k of keys) if (sc[k] !== undefined && sc[k] !== null && sc[k] !== '' && typeof sc[k] !== 'object') return { k, v: sc[k] }; return null; };
  const st = pick(['status', 'state', 'outcome', 'result']);
  const ok = pick(['success', 'ok']);
  const why = pick(['reason', 'skip_reason', 'skipped_reason', 'message', 'error', 'error_message', 'detail']);
  const code = pick(['error_code', 'error_type', 'code']);
  const flag = pick(['permanent_runner_error']);
  if (!st && !ok && !why && !code) return null;
  const stText = st ? String(st.v) : ok ? (ok.v === false || /^false$/i.test(String(ok.v)) ? 'failed' : 'ok') : '';
  const bad = (!!st && BAD.test(stText)) || (!!ok && (ok.v === false || /^false$/i.test(String(ok.v)))) || (!st && !ok && !!why && /error|fail/i.test(why.k));
  const good = !bad && !!stText && GOOD.test(stText);
  const parts = [stText ? `status=${short(stText)}` : '', why ? `${bad || /skip/i.test(stText) || why.k === 'reason' ? '(' : 'note: '}${short(why.v)}${bad || /skip/i.test(stText) || why.k === 'reason' ? ')' : ''}` : '', code ? `[${short(code.v)}]` : '', flag && flag.v ? `[permanent_runner_error]` : ''].filter(Boolean);
  return { text: parts.join(' '), bad, good };
}

/** A few headline numbers from the json (findings, files, vulnerabilities …) so a PASS says what was found. */
function numbersOf(j: any): string {
  const nums: string[] = [];
  const add = (o: any, prefix = '') => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o)) {
      if (nums.length >= 4) return;
      if (typeof v === 'number' && Number.isFinite(v) && !/^(line|column|start|end|version|port|id|index)$/i.test(k)) nums.push(`${prefix}${k}=${v}`);
    }
  };
  add(j);
  if (nums.length < 2) for (const k of ['summary', 'statistics', 'total', 'metrics', 'stats']) { add(j?.[k], `${k}.`); add(j?.[k]?.total, `${k}.total.`); }
  if (!nums.length && j && typeof j === 'object') {
    for (const [k, v] of Object.entries(j)) if (Array.isArray(v) && nums.length < 4) nums.push(`${k}=${v.length} item(s)`);
  }
  return nums.slice(0, 4).join(', ');
}

/** empty = triggered but empty / tool reported failed-skipped-not_applicable. note = what really happened, taken from the json. */
export function analyseJson(text: string): { empty: boolean; note: string } {
  let j: any;
  try { j = JSON.parse(text); } catch { return { empty: text.trim() === '', note: text.trim() === '' ? 'file is blank' : 'not valid json (kept as data)' }; }
  if (emptyish(j)) return { empty: true, note: Array.isArray(j) ? '[] (empty list)' : '{} / all values 0' };
  const o = outcomeOf(j);
  if (o?.bad) return { empty: true, note: o.text };
  // nyc / istanbul coverage-summary: nothing measured (every metric has total 0)
  const cs = j?.total;
  if (cs && typeof cs === 'object' && ['lines', 'statements', 'branches', 'functions'].every((k) => cs[k] && typeof cs[k] === 'object')
      && ['lines', 'statements', 'branches', 'functions'].every((k) => Number(cs[k].total) === 0)) return { empty: true, note: 'coverage summary: 0 lines / statements / branches measured' };
  const total = j?.statistics?.total; // jscpd
  if (total && typeof total === 'object' && (total.sources === 0 || total.lines === 0)) return { empty: true, note: 'jscpd: 0 sources analysed' };
  const nums = numbersOf(j);
  if (o && !nums && /(_missing|missing_|no[_ ]data|not[_ ]available|nothing|not[_ ]implemented|not[_ ]applicable)/i.test(o.text)) return { empty: true, note: o.text };
  if (o && (o.good || o.text)) return { empty: false, note: `${o.text}${nums ? ` — ${nums}` : ''}` };
  return { empty: false, note: nums ? `has data — ${nums}` : 'has data' };
}

export function verdict(jsons: { empty: boolean }[]): Verdict {
  if (!jsons.length) return 'FAIL';
  return jsons.some((x) => !x.empty) ? 'PASS' : 'EMPTY';
}


/** Which languages a tool's json is about, from the source-file names inside it (.js / .ts / .py / .cs …). */
export function detectLanguages(text: string): Language[] {
  const has = (re: RegExp) => re.test(text);
  const out: Language[] = [];
  if (has(/\.(js|jsx|mjs|cjs)(?![A-Za-z0-9])/i)) out.push('javascript');
  if (has(/\.(ts|tsx|mts|cts)(?![A-Za-z0-9])/i)) out.push('typescript');
  if (has(/\.py(?![A-Za-z0-9])/i)) out.push('python');
  if (has(/\.(cs|cshtml|csx|csproj)(?![A-Za-z0-9])/i)) out.push('csharp');
  return out;
}

/** lizard (and other xml reports): triggered-with-data when the xml holds items / functions / measures. */
export function analyseXml(text: string): { empty: boolean; note: string } {
  if (!text.trim()) return { empty: true, note: 'file is blank' };
  const items = (text.match(/<(item|function|file|testcase|violation|issue|package|class)[\s>]/gi) || []).length;
  const err = /<(error|failure)[\s>]/i.test(text) && !items;
  if (err) return { empty: true, note: 'xml reports an error / failure and no items' };
  if (!items) return { empty: true, note: 'xml has no items (empty report)' };
  return { empty: false, note: `has data — xml with ${items} item(s)` };
}

/** Picks the reader by file type. */
export function analyseFile(key: string, text: string): { empty: boolean; note: string } {
  return /\.xml$/i.test(key) ? analyseXml(text) : analyseJson(text);
}
