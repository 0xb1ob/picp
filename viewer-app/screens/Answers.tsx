import type { AnswerItem, AnswersView } from "../../src/viewer/api-types.ts";
import { type AnswersControlView, answersControlLine, answersControlReady } from "../answers-control.ts";
import { Icon } from "../components/icons.tsx";
import { observedTime } from "../format.ts";
import { linkify } from "../../src/viewer/linkify.ts";

/** The full answer as plain text: only `http(s)` URLs and links the server resolved become `<a>`; everything else stays text. */
function AnswerText({item}: {item: AnswerItem}) {
 return <div class="answers-text">{linkify(item.answer, item.links).map((part, i) => part.href
  ? <a key={i} href={part.href} {...(part.external ? {target: "_blank", rel: "noopener noreferrer"} : {})}>{part.text}</a>
  : part.text)}</div>;
}

function AnswerMeta({item, at}: {item: AnswerItem; at: string}) {
 return <p class="answers-meta"><span class="answers-project">[{item.project}]</span><time dateTime={at}>{observedTime(at)}</time>
  {item.job && <a href={item.job.href}>{item.job.id}</a>}{item.job?.read && <a href={item.job.read}>read</a>}</p>;
}

function AnswerBody({item}: {item: AnswerItem}) {
 return <>
  <p class="answers-question" title={item.question}>{item.question}</p>
  <p class="answers-short">{item.short}</p>
  <details class="answers-full"><summary>Full answer</summary><AnswerText item={item}/></details>
  {item.evidence.length > 0 && <ul class="answers-evidence">{item.evidence.map(e => <li key={e.path}>{e.href ? <a href={e.href}>{e.path}</a> : <code>{e.path}</code>}{e.read && <a href={e.read}>read</a>}</li>)}</ul>}
 </>;
}

/** Answers to acknowledge (cp-mxk4): what the operator asked for, one tick to clear it; the tick sends nothing anywhere. */
export function AnswersSection({data, control}: {data: AnswersView; control?: AnswersControlView | undefined}) {
 if (data.availability === "missing") return null; // no journal yet: the section is absent, not empty
 const ready = answersControlReady(control?.status);
 const open = data.open.filter(item => !control?.acked.includes(item.id));
 const pending = data.open_count === null ? null : Math.max(0, data.open_count - (data.open.length - open.length));
 const quiet = data.availability === "ok" && pending === 0 && !data.warning;
 const history = data.history.map(item => <article key={item.id} class="answers-row answers-done" aria-label={`Acknowledged answer ${item.id}`}>
  <AnswerMeta item={item} at={item.posted_at}/><AnswerBody item={item}/>
  {item.acked_at && <p class="answers-acked">Acknowledged <time dateTime={item.acked_at}>{observedTime(item.acked_at)}</time></p>}
 </article>);
 if (quiet) return <details class="answers-quiet"><summary>No answers waiting &middot; {data.history_total ?? "-"} acknowledged</summary>{history.length ? history : <p class="answers-empty">No acknowledged answers yet</p>}</details>;
 return <div class="answers">
  <div class="answers-header"><h2>Answers to acknowledge</h2><span class="answers-count">{pending ?? "-"}</span></div>
  <p class="answers-control" role="status">{answersControlLine(control?.status)}</p>
  {data.warning && <p role="alert" class="answers-warning">{data.warning}</p>}
  {open.map(item => <article key={item.id} class="answers-row" aria-label={`Answer ${item.id}`}>
   <AnswerMeta item={item} at={item.posted_at}/>
   <AnswerBody item={item}/>
   <button type="button" class="answers-ack" aria-label={`Acknowledge ${item.id}`} disabled={!ready || control?.sending === item.id} onClick={() => control?.ack(item.id)}><Icon name="check" size={16}/> Acknowledge</button>
   {control?.failed?.id === item.id && <p role="alert" class="answers-failed">Failed: {control.failed.reason}</p>}
  </article>)}
  {history.length > 0 && <details class="answers-history"><summary>Acknowledged &middot; {data.history_total}</summary>{history}</details>}
 </div>;
}
