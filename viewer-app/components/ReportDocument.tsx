import { type ComponentChildren } from "preact";
import { reportImageUrl } from "../../src/viewer/report-paths.ts";
import { blocks, Linked, type Block } from "./Markdown.tsx";

const EXTERNAL = /^https?:\/\//i;
const TOKEN = /(`[^`\n]+`)|!\[([^\]\n]*)\]\(([^()\s]+)\)|\[([^\]\n]+)\]\(([^()\s]+)\)|\*\*([^\n]+?)\*\*|__([^\n]+?)__|(?<![\w*])\*([^*\s][^*\n]*?)\*(?![\w*])|(?<![\w_])_([^_\s][^_\n]*?)_(?![\w_])/g;
const HR = /^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/;

function Image({alt, src, jobId}: {alt:string; src:string; jobId:string}) {
 const url = reportImageUrl(jobId, src);
 if (url) return <img class="report-image" src={url} alt={alt} loading="lazy"/>;
 // The app's CSP loads images from this origin only, so a remote image is offered as a link instead.
 if (EXTERNAL.test(src)) return <a href={src} target="_blank" rel="noopener noreferrer">{alt || src} ↗</a>;
 return <span class="report-refused" title={src}>image refused: {alt || src}</span>;
}

/** Inline report markdown: code, images, links, bold and italic; bare URLs via linkify. Never HTML. */
function Inline({text, jobId}: {text:string; jobId:string}) {
 const out: ComponentChildren[] = [];
 let at = 0;
 for (const m of text.matchAll(TOKEN)) {
  if (m.index > at) out.push(<Linked key={at} text={text.slice(at, m.index)} chips={false}/>);
  const key = `t${m.index}`;
  if (m[1]) out.push(<code key={key}>{m[1].slice(1, -1)}</code>);
  else if (m[3] !== undefined) out.push(<Image key={key} alt={m[2]!} src={m[3]} jobId={jobId}/>);
  else if (m[5] !== undefined) out.push(EXTERNAL.test(m[5]) ? <a key={key} href={m[5]} target="_blank" rel="noopener noreferrer"><Inline text={m[4]!} jobId={jobId}/></a> : <span key={key} class="report-local-link" title={m[5]}><Inline text={m[4]!} jobId={jobId}/></span>);
  else if (m[6] ?? m[7]) out.push(<strong key={key}><Inline text={(m[6] ?? m[7])!} jobId={jobId}/></strong>);
  else out.push(<em key={key}><Inline text={(m[8] ?? m[9])!} jobId={jobId}/></em>);
  at = m.index + m[0].length;
 }
 if (at < text.length) out.push(<Linked key={at} text={text.slice(at)} chips={false}/>);
 return <>{out}</>;
}

const flow = (text: string) => text.replace(/\s*\n\s*/g, " ");

function List({list, jobId}: {list:Extract<Block,{kind:"list"}>; jobId:string}) {
 const items = list.items.map((item, j) => <li key={j}><Inline text={flow(item)} jobId={jobId}/>{list.sub?.[j] && <List list={list.sub[j]!} jobId={jobId}/>}</li>);
 return list.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
}

/** A paragraph block split at its `---` rule lines: a rule renders as <hr>, the rest as paragraphs. */
function Paragraph({text, jobId}: {text:string; jobId:string}) {
 const parts: (string | null)[] = [];
 for (const line of text.split("\n")) {
  if (HR.test(line)) parts.push(null);
  else if (typeof parts.at(-1) === "string") parts[parts.length - 1] += `\n${line}`;
  else parts.push(line);
 }
 return <>{parts.map((part, i) => part === null ? <hr key={i}/> : <p key={i}><Inline text={flow(part)} jobId={jobId}/></p>)}</>;
}

function Blocks({text, jobId}: {text:string; jobId:string}) {
 return <>{blocks(text).map((b, i) => {
  if (b.kind === "code") return <pre key={i} class="report-code"><code>{b.text}</code></pre>;
  if (b.kind === "table") return <div key={i} class="report-table" tabIndex={0}><table><thead><tr>{b.head.map((c, j) => <th key={j}><Inline text={c} jobId={jobId}/></th>)}</tr></thead><tbody>{b.rows.map((row, k) => <tr key={k}>{row.map((c, j) => <td key={j}><Inline text={c} jobId={jobId}/></td>)}</tr>)}</tbody></table></div>;
  if (b.kind === "list") return <List key={i} list={b} jobId={jobId}/>;
  if (b.kind === "quote") return <blockquote key={i}><Blocks text={b.text} jobId={jobId}/></blockquote>;
  if (b.kind === "heading") { const H = `h${Math.min(b.level, 6)}` as "h2"; return <H key={i}><Inline text={b.text} jobId={jobId}/></H>; }
  return <Paragraph key={i} text={b.text} jobId={jobId}/>;
 })}</>;
}

/**
 * A job's report.md as a document: headings, lists, tables, code, quotes, links and images from its own artifact dir.
 * Text only ever becomes elements; raw HTML in the source stays visible text.
 */
export function ReportDocument({text, jobId}: {text:string; jobId:string}) {
 return <div class="report-doc"><Blocks text={text} jobId={jobId}/></div>;
}
