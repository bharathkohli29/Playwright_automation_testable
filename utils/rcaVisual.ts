/**
 * Building blocks of the RCA reports that make them readable in a minute: colour-coded summary cards, badges, a cause chain (boxes with arrows) and call-out
 * boxes. Plain HTML + the classes of BASE_CSS (rcaReport.ts). No imports on purpose.
 */
export type Kind = 'ok' | 'warn' | 'bad' | 'info' | 'muted';
export const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** a short coloured label: "Proven", "Platform", "Cluster read" */
export const badge = (text: string, kind: Kind = 'muted') => `<span class="badge b-${kind}">${esc(text)}</span>`;

/** the first sentence or two of a text, so a card stays short (the whole text is further down the report) */
export function brief(text: string, max = 230): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim(); if (t.length <= max) return t;
  const cut = t.slice(0, max); const dot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; ')); return (dot > 80 ? cut.slice(0, dot + 1) : cut.replace(/\s+\S*$/, '') + ' …');
}

export interface Card { label: string; text: string; kind: Kind; icon: string }
/** the three cards at the top: what happened, why, how to fix */
export function summaryCards(cards: Card[]): string {
  return `<div class="cards3">${cards.map((c) => `<div class="card c-${c.kind}"><div class="card-h"><span class="ico">${esc(c.icon)}</span>${esc(c.label)}</div><div class="card-t">${esc(c.text)}</div></div>`).join('')}</div>`;
}

/** the cause chain: boxes joined by arrows, the last one marked as the root cause (or as "not established") */
export function chainHtml(nodes: string[], lastKind: Kind = 'info'): string {
  const n = nodes.filter(Boolean); if (n.length < 2) return '';
  return `<div class="chain">${n.map((t, i) => `${i ? '<span class="arrow">&#10140;</span>' : ''}<div class="node ${i === n.length - 1 ? `n-${lastKind}` : ''}"><span class="n-no">${i + 1}</span>${esc(t)}</div>`).join('')}</div>`;
}

/** a highlighted box with a title: fix (ok), now (warn), check (info), caution (bad) */
export const callout = (title: string, body: string, kind: Kind = 'info') => `<div class="callout k-${kind}"><div class="callout-h">${esc(title)}</div><div class="callout-b">${body}</div></div>`;

/** "Platform: ... Script: ..." becomes one line per owner */
export function steps(text: string): string[] {
  return String(text || '').split(/\s+(?=(?:Platform|Script|Repository|Team|Admin|Platform team|Developer)s?:\s)/).map((x) => x.trim()).filter(Boolean);
}

export const VISUAL_CSS = `
.badges{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 2px}.badge{display:inline-block;padding:2px 9px;border-radius:10px;font-size:10px;font-weight:700;letter-spacing:.03em;color:#fff}
.b-ok{background:#047857}.b-warn{background:#b45309}.b-bad{background:#b91c1c}.b-info{background:#1d4ed8}.b-muted{background:#6b7280}
.cards3{display:flex;gap:10px;margin:12px 0}.card{flex:1;border-radius:8px;padding:10px 12px;border:1px solid #e5e7eb;border-top:5px solid #9ca3af;background:#fff;break-inside:avoid}
.card-h{font-size:9.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#374151;margin-bottom:5px}.ico{display:inline-block;width:17px;height:17px;border-radius:50%;background:#374151;color:#fff;text-align:center;line-height:17px;margin-right:6px;font-size:10px}
.card-t{font-size:12px;line-height:1.45;color:#111827}
.c-bad{border-top-color:#b91c1c;background:#fef2f2}.c-warn{border-top-color:#d97706;background:#fffbeb}.c-ok{border-top-color:#047857;background:#ecfdf5}.c-info{border-top-color:#1d4ed8;background:#eff6ff}
.c-bad .ico{background:#b91c1c}.c-warn .ico{background:#d97706}.c-ok .ico{background:#047857}.c-info .ico{background:#1d4ed8}
.chain{display:flex;flex-wrap:wrap;align-items:stretch;gap:5px;margin:8px 0 12px}.node{flex:1 1 120px;min-width:110px;max-width:170px;border:1.5px solid #cbd5e1;border-radius:7px;padding:7px 8px;font-size:10.5px;line-height:1.35;background:#f8fafc;position:relative}
.n-no{display:inline-block;min-width:15px;height:15px;border-radius:8px;background:#64748b;color:#fff;font-size:9px;font-weight:700;text-align:center;line-height:15px;margin-right:5px}
.arrow{align-self:center;color:#94a3b8;font-size:16px}.n-info{border-color:#1d4ed8;background:#eff6ff}.n-warn{border-color:#d97706;background:#fffbeb}.n-bad{border-color:#b91c1c;background:#fef2f2}.n-ok{border-color:#047857;background:#ecfdf5}
.callout{border-radius:8px;padding:9px 12px;margin:8px 0;border-left:6px solid #9ca3af;background:#f9fafb;break-inside:avoid}.callout-h{font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px}.callout-b{font-size:11.5px;line-height:1.5}
.k-ok{border-left-color:#047857;background:#ecfdf5}.k-ok .callout-h{color:#047857}.k-warn{border-left-color:#d97706;background:#fffbeb}.k-warn .callout-h{color:#b45309}.k-info{border-left-color:#1d4ed8;background:#eff6ff}.k-info .callout-h{color:#1d4ed8}.k-bad{border-left-color:#b91c1c;background:#fef2f2}.k-bad .callout-h{color:#b91c1c}
.callout-b ol,.callout-b ul{margin:3px 0 3px 18px;padding:0}.pill{display:inline-block;padding:1px 8px;border-radius:9px;font-size:9.5px;font-weight:700;background:#fef3c7;color:#92400e}
.sec{font-size:13px;margin:16px 0 6px;padding:5px 9px;border-radius:5px;background:#1f3a5f;color:#fff;font-weight:700;break-after:avoid}.sec.light{background:#e5e7eb;color:#111827}
.appx{margin-top:14px;padding-top:6px;border-top:2px dashed #cbd5e1;color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:700}
figure img{box-shadow:0 1px 4px rgba(0,0,0,.18)}
`;
