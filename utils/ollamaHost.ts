/**
 * Where the model server is. Default: this PC (http://localhost:11434). A team can run Ollama with the model on ONE shared PC and let everyone
 * else use it, without installing anything: set OLLAMA_HOST=http://<shared PC>:11434 in .env. With a shared host the script never starts Ollama,
 * never downloads or registers the model on this PC; it only checks that the shared server answers and has the model.
 * Accepted forms: http://host:11434, host:11434, host (port 11434 is added), an empty value = this PC. 0.0.0.0 (what a server sets to listen on
 * every network card) counts as this PC.
 */
const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** the base address of the model server, normalised: scheme and port always present, no trailing slash */
export function ollamaUrl(raw: string | undefined = process.env.OLLAMA_HOST): string {
  let v = (raw || '').trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
  if (!v) return 'http://localhost:11434';
  if (!/^https?:\/\//i.test(v)) v = `http://${v}`;
  const m = /^(https?):\/\/(\[[^\]]+\]|[^/:]+)(?::(\d+))?/i.exec(v);
  if (!m) return 'http://localhost:11434';
  const host = m[2] === '0.0.0.0' || m[2] === '' ? 'localhost' : m[2];
  return `${m[1].toLowerCase()}://${host}:${m[3] || '11434'}`;
}

/** true when the model server is on this PC (the script may start it and register the model) */
export function isLocalOllama(raw: string | undefined = process.env.OLLAMA_HOST): boolean {
  const m = /^https?:\/\/(\[[^\]]+\]|[^/:]+)/i.exec(ollamaUrl(raw));
  return !!m && LOCAL.has(m[1].toLowerCase());
}

/** names of the models the server holds, or null when it does not answer */
export async function ollamaModels(): Promise<string[] | null> {
  try {
    const r = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    return (((await r.json()) as any).models || []).map((m: any) => String(m.name));
  } catch { return null; }
}
