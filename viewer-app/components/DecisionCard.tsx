import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { AwaitingDetail } from "../../src/viewer/api-types.ts";
import { CONTROL_TEXT_MAX, type ControlView, controlLine, controlReady } from "../control.ts";
import { money } from "../format.ts";
import { jobHref } from "../routes.ts";

const BULLET = /^\s*[-*\u2022]\s+/;
/** An ask's plain-text context: blank lines split paragraphs, `- ` lines are bullets. Text only, never markup. */
export function ContextText({text}: {text:string}) {
 const blocks: {list:boolean;lines:string[]}[] = [];
 for (const line of text.split("\n")) {
  if (!line.trim()) { blocks.push({list:false,lines:[]}); continue; }
  const list = BULLET.test(line), last = blocks.at(-1);
  if (last && last.list === list && last.lines.length) last.lines.push(list ? line.replace(BULLET,"") : line);
  else blocks.push({list,lines:[list ? line.replace(BULLET,"") : line]});
 }
 return <>{blocks.filter(b => b.lines.length).map((b,i) => b.list ? <ul key={i}>{b.lines.map((l,j) => <li key={j}>{l}</li>)}</ul> : <p key={i}>{b.lines.join("\n")}</p>)}</>;
}

/**
 * One open operator ask, decidable in one tap: a button per option (`{kind:"answer"}`, the guarded PR 351 path),
 * an "Other answer…" message, and the context behind it. Shared by the Awaiting page and the transcript's pinned block.
 * Without control the buttons stay, disabled, with the one reason; never a copy command.
 */
export function DecisionCard({ask,control,level = 2,factsOpen = false,contextOpen,children}: {ask:AwaitingDetail;control?:ControlView | undefined;level?:2 | 3;factsOpen?:boolean;contextOpen?:boolean;children?:ComponentChildren}) {
 const [other,setOther] = useState("");
 const ready = controlReady(control?.status);
 const mine = control?.delivery?.ask_id === ask.id ? control.delivery : null;
 const disabled = !ready || control?.delivery?.state === "sending" || (mine !== null && mine.state !== "failed");
 const Heading = level === 2 ? "h2" : "h3";
 const sendOther = () => { const body = other.trim(); if (disabled || !body) return; control!.send({kind:"message",text:`${ask.id}: ${body}`},ask.id); setOther(""); };
 return <article class="decision-card" aria-labelledby={`question-${ask.id}`}>
  {children}
  <div class="decision-card-question"><Heading id={`question-${ask.id}`}>{ask.question}</Heading>{ask.reason && <span class="awaiting-reason">yours because: {ask.reason}</span>}</div>
  {ask.context && <details class="decision-card-context" open={contextOpen ?? ask.context.length <= 600}><summary>Background</summary><ContextText text={ask.context}/></details>}
  <div class="decision-card-options">{ask.options.map(option => <button key={option.label} type="button" class={ask.recommendation === option.label ? "decision-card-option decision-card-recommended" : "decision-card-option"} disabled={disabled} onClick={() => control?.send({kind:"answer",ask_id:ask.id,label:option.label})}>
   <span class="decision-card-option-heading"><strong>{option.label}</strong>{ask.recommendation === option.label && <span class="overview-rec-badge">recommended</span>}</span><span class="decision-card-consequence">{option.consequence}</span>
  </button>)}</div>
  {!ready && <p class="decision-card-disabled" role="status">{controlLine(control?.status)}</p>}
  <p class="decision-card-recommendation">operator session recommends <strong>{ask.recommendation}</strong></p>
  {ask.escalation?.differs && ask.escalation.recommended && <p class="decision-card-differs" role="note">automatic default: {ask.escalation.recommended}</p>}
  <div class="decision-card-other"><input type="text" aria-label={`Other answer to ${ask.id}`} placeholder="Other answer…" maxLength={CONTROL_TEXT_MAX - ask.id.length - 2} value={other} disabled={disabled}
   onInput={e => setOther(e.currentTarget.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); sendOther(); } }}/><button type="button" disabled={disabled || !other.trim()} onClick={sendOther}>Send</button></div>
  {mine && <p role={mine.state === "failed" ? "alert" : "status"} class={mine.state === "failed" ? "decision-card-delivery decision-card-failed" : "decision-card-delivery"}>{mine.state === "failed" ? `Failed: ${mine.reason ?? "unknown"}` : `${mine.state === "sending" ? "Sending" : mine.state === "queued" ? "Sent, queued" : "Sent"} — the card closes when the session records the answer`}</p>}
  <details class="decision-card-facts" open={factsOpen}><summary>Context: {[ask.jobs.length ? `${ask.jobs.length} job${ask.jobs.length === 1 ? "" : "s"}` : "", ask.mandate_id ? "mandate" : "", ask.escalation ? "parent's question" : "", ask.evidence.length ? `${ask.evidence.length} evidence` : ""].filter(Boolean).join(" · ") || "project"}</summary>
   <dl class="decision-card-dl">
    <div><dt>project</dt><dd>{ask.project}</dd></div>
    <div><dt>mandate</dt><dd>{ask.mandate_id ? <><a href="#map"><code>{ask.mandate_id}</code></a> &middot; {ask.mandate_status ?? "unknown"} &middot; {money(ask.spend)} / {money(ask.spend_cap)}{ask.mandate_objective && <span class="decision-card-objective">{ask.mandate_objective}</span>}</> : "Not recorded"}</dd></div>
   </dl>
   {ask.jobs.length > 0 && <ul class="decision-card-jobs">{ask.jobs.map(j => <li key={j.id}><a href={jobHref(j.id)}><code>{j.id}</code></a>{j.title && <span>{j.title}</span>}<small>{[j.phase,j.model,j.cost_usd === null ? null : money(j.cost_usd),j.ci && `CI ${j.ci}`,j.review && `review ${j.review}`].filter(Boolean).join(" · ")}</small>{j.pr_url && <a href={j.pr_url}>{j.pr_url}</a>}</li>)}</ul>}
   {ask.escalation && <div class="decision-card-escalation"><strong>Parent raised <code>{ask.escalation.id}</code>{ask.escalation.kind && ` · ${ask.escalation.kind.replaceAll("_"," ")}`}</strong><p>{ask.escalation.question}</p>{ask.escalation.recommended && <small>{ask.escalation.differs ? "automatic default:" : "parent recommends"} {ask.escalation.recommended}</small>}</div>}
   {ask.evidence.length > 0 && <ul class="decision-card-evidence">{ask.evidence.map(e => <li key={e.path}>{e.href ? <a href={e.href}>{e.path}</a> : <code>{e.path}</code>}{e.read && <a href={e.read}>read</a>}</li>)}</ul>}
  </details>
 </article>;
}
