/**
 * Message text as link segments (transcript-links): `[label](http…)`, a bare `http(s)://` URL, and a bare
 * `/…/.pi-command-post/…` path. Pure and DOM-free — the server finds the paths to resolve with `localPaths`,
 * the viewer renders `linkify` segments as elements. Only `http:`/`https:` ever become external links.
 */
export type LinkSegment = { text: string; href?: string; external?: boolean };

const TOKEN = /\[([^\]\n]+)\]\((https?:\/\/[^\s()]+)\)|\b(https?:\/\/[^\s<>"'`]+)|(?<![\w./~-])(\/[^\s<>"'`]*?\/\.pi-command-post\/[^\s<>"'`]*)/g;

/** Drop trailing `.,:;` and any unbalanced closing `)` or `]` (a balanced `(…)` inside a URL stays). */
function trim(token: string): string {
 const count = (s: string, c: string) => s.split(c).length - 1;
 for (;;) {
  const last = token.at(-1);
  if (last && ".,:;".includes(last)) token = token.slice(0, -1);
  else if (last === ")" && count(token, "(") < count(token, ")")) token = token.slice(0, -1);
  else if (last === "]" && count(token, "[") < count(token, "]")) token = token.slice(0, -1);
  else return token;
 }
}

/** `local` maps a bare path to its viewer href (SessionEntry.links); an unresolved path stays plain text. */
export function linkify(text: string, local: Record<string, string> = {}): LinkSegment[] {
 const out: LinkSegment[] = [];
 const plain = (s: string) => { if (!s) return; const tail = out.at(-1); if (tail && !tail.href) tail.text += s; else out.push({ text: s }); };
 let at = 0;
 for (const m of text.matchAll(TOKEN)) {
  plain(text.slice(at, m.index));
  if (m[1] !== undefined) { out.push({ text: m[1], href: m[2]!, external: true }); at = m.index + m[0].length; continue; }
  const url = m[3] !== undefined, token = trim(m[3] ?? m[4]!);
  const href = url ? (/^https?:\/\/./.test(token) ? token : undefined) : local[token];
  if (href) out.push(url ? { text: token, href, external: true } : { text: token, href });
  else plain(token);
  at = m.index + token.length;
 }
 plain(text.slice(at));
 return out;
}

/** Every bare `.pi-command-post` path `linkify` would look up, so the server resolves exactly those. */
export function localPaths(text: string): string[] {
 return [...new Set([...text.matchAll(TOKEN)].filter((m) => m[4] !== undefined).map((m) => trim(m[4]!)))];
}
