import { linkify } from "../../src/viewer/linkify.ts";

type Links = Record<string,string> | undefined;
/** Text with its links as elements (linkify.ts): external ones open in a new tab; nothing is ever raw HTML. */
export function Linked({text,links}: {text:string;links?:Links}) {
 return <>{linkify(text,links).map((s,i)=>s.href ? <a key={i} href={s.href} {...(s.external ? {target:"_blank",rel:"noopener noreferrer"} : {})}>{s.text}</a> : s.text)}</>;
}
/** Inline markdown: `code` and **bold**, everything else linked text. */
export function InlineText({text,links}: {text:string;links?:Links}) {
 return <>{text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part,i)=>i % 2 === 1 && part.startsWith("`") ? <code key={i}><Linked text={part.slice(1,-1)} links={links}/></code> : i % 2 === 1 ? <strong key={i}>{part.slice(2,-2)}</strong> : <Linked key={i} text={part} links={links}/>)}</>;
}

export type Block = {kind:"p"|"quote"|"heading"|"code";text:string} | {kind:"list";ordered:boolean;items:string[];sub?:Record<number,Extract<Block,{kind:"list"}>>} | {kind:"table";head:string[];rows:string[][]};
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^#{1,6}\s+/;
const ROW = /^\s*\|.*\|\s*$/;
const RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const cells = (line: string) => line.trim().replace(/^\||\|$/g,"").split("|").map(c=>c.trim());
const isTable = (lines: string[], i: number) => ROW.test(lines[i]!) && RULE.test(lines[i+1] ?? "");

const indentOf = (l: string) => /^\s*/.exec(l)![0].length;
/** One list from its raw lines: an item indented deeper than the first becomes a nested list under the item above it (`sub`, by item index). */
function buildList(raw: string[]): Extract<Block,{kind:"list"}> {
 const base = indentOf(raw[0]!), items: string[] = [], deeper: Record<number,string[]> = {};
 for (const l of raw) {
  const last = items.length - 1, nested = last >= 0 && indentOf(l) > base;
  if (nested && (ITEM.test(l) || deeper[last])) (deeper[last] ??= []).push(l);
  else if (ITEM.test(l)) items.push(l.replace(ITEM,""));
  else items[last] += `\n${l.trim()}`;
 }
 const list: Extract<Block,{kind:"list"}> = {kind:"list",ordered:/^\s*\d/.test(raw[0]!),items};
 const keys = Object.keys(deeper);
 if (keys.length) list.sub = Object.fromEntries(keys.map(k => [k,buildList(deeper[+k]!)]));
 return list;
}
/**
 * The chat subset of markdown a transcript message uses: paragraphs (their line breaks kept), fenced code,
 * lists, pipe tables, headings and quotes. Anything else is a paragraph; nothing is ever HTML.
 */
export function blocks(text: string): Block[] {
 const lines = text.split("\n"), out: Block[] = [];
 for (let i = 0; i < lines.length;) {
  const line = lines[i]!;
  if (!line.trim()) { i++; continue; }
  const fence = FENCE.exec(line);
  if (fence) {
   const close = new RegExp(`^\\s*${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
   const body: string[] = [];
   for (i++; i < lines.length && !close.test(lines[i]!); i++) body.push(lines[i]!);
   i++; out.push({kind:"code",text:body.join("\n")}); continue;
  }
  if (isTable(lines,i)) {
   const head = cells(line), rows: string[][] = [];
   for (i += 2; i < lines.length && ROW.test(lines[i]!); i++) rows.push(cells(lines[i]!));
   out.push({kind:"table",head,rows}); continue;
  }
  if (ITEM.test(line)) {
   const raw: string[] = [], ordered = /^\s*\d/.test(line);
   for (; i < lines.length && lines[i]!.trim(); i++) {
    const l = lines[i]!;
    if (ITEM.test(l) && (/^\s/.test(l) || /^\d/.test(l) === ordered)) raw.push(l);
    else if (/^\s/.test(l)) raw.push(l);
    else break;
   }
   out.push(buildList(raw)); continue;
  }
  if (HEADING.test(line)) { out.push({kind:"heading",text:line.replace(HEADING,"")}); i++; continue; }
  if (line.startsWith(">")) {
   const body: string[] = [];
   for (; i < lines.length && lines[i]!.startsWith(">"); i++) body.push(lines[i]!.replace(/^>\s?/,""));
   out.push({kind:"quote",text:body.join("\n")}); continue;
  }
  const body: string[] = [];
  for (; i < lines.length && lines[i]!.trim() && !FENCE.test(lines[i]!) && !ITEM.test(lines[i]!) && !HEADING.test(lines[i]!) && !isTable(lines,i); i++) body.push(lines[i]!);
  out.push({kind:"p",text:body.join("\n")});
 }
 return out;
}

function MdList({list,links}: {list:Extract<Block,{kind:"list"}>;links?:Links}) {
 const items = list.items.map((item,j)=><li key={j}><InlineText text={item} links={links}/>{list.sub?.[j] && <MdList list={list.sub[j]!} links={links}/>}</li>);
 return list.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
}
/** A message body: code blocks and tables scroll sideways inside their own box, never the bubble. */
export function Markdown({text,links}: {text:string;links?:Links}) {
 return <div class="md">{blocks(text).map((b,i)=>{
  if (b.kind === "code") return <pre key={i} class="md-code"><code>{b.text}</code></pre>;
  if (b.kind === "table") return <div key={i} class="md-table"><table><thead><tr>{b.head.map((c,j)=><th key={j}><InlineText text={c} links={links}/></th>)}</tr></thead><tbody>{b.rows.map((row,k)=><tr key={k}>{row.map((c,j)=><td key={j}><InlineText text={c} links={links}/></td>)}</tr>)}</tbody></table></div>;
  if (b.kind === "list") return <MdList key={i} list={b} links={links}/>;
  if (b.kind === "quote") return <blockquote key={i}><p><InlineText text={b.text} links={links}/></p></blockquote>;
  if (b.kind === "heading") return <p key={i} class="md-heading"><strong><InlineText text={b.text} links={links}/></strong></p>;
  return <p key={i}><InlineText text={b.text} links={links}/></p>;
 })}</div>;
}
