import { join } from "node:path";
import type { Ask, Decision, DecisionDetail, Question } from "./api-types.ts";
import { isSafeId, obj, type ViewerState } from "./sessions.ts";
import { objectList, parseObject, readBounded, source, strings, text, timestamp, today } from "./overview-read.ts";

interface RecordedAsk { ask: Ask; state: "open" | "answered" | "withdrawn"; answered_at: string | null; answer: string | null; reason: string | null }
export function asks(state: ViewerState) {
 return source<RecordedAsk[]>(() => {
  const data = readBounded(join(state.stateDir, "operator", "asks.jsonl"));
  const records = new Map<string, RecordedAsk>();
  const complete = data.slice(0, data.lastIndexOf("\n") + 1).split("\n"); complete.pop();
  for (const line of complete) {
   const event = parseObject(line);
   if (!event || typeof event.id !== "string" || !/^ask-[a-f0-9]+$/.test(event.id)) throw new Error("invalid ask");
   const prior = records.get(event.id);
   if (event.type === "open") {
    const keys = ["type","id","created_at","project","question","options","recommendation","source_escalation","job_ids","evidence_paths","context"];
    if (prior || Object.keys(event).some(k => !keys.includes(k)) || !timestamp(event.created_at) || !text(event.project) || !text(event.question) || !text(event.recommendation) || !Array.isArray(event.options) || event.options.length < 1 || event.options.length > 5) throw new Error("invalid open");
    if (event.source_escalation !== undefined && (typeof event.source_escalation !== "string" || !/^es-[A-Za-z0-9_-]+$/.test(event.source_escalation))) throw new Error("invalid source");
    if (event.context !== undefined && (!text(event.context) || event.context.length > 2000)) throw new Error("invalid context");
    for (const key of ["job_ids","evidence_paths"]) if (event[key] !== undefined && (!Array.isArray(event[key]) || !(event[key] as unknown[]).every(text))) throw new Error("invalid list");
    const id = event.id;
    const options = event.options.map(value => {
     const option = obj(value);
     if (!option || !text(option.label) || !text(option.consequence) || Object.keys(option).some(k => k !== "label" && k !== "consequence")) throw new Error("invalid option");
     return {label:option.label, consequence:option.consequence, reply:`${id}: ${option.label}`};
    });
    records.set(id, {state:"open", answered_at:null, answer:null, reason:null, ask:{id, project:event.project, question:event.question, created_at:event.created_at, options, recommendation:event.recommendation, source_escalation:typeof event.source_escalation === "string" ? event.source_escalation : null, job_ids:strings(event.job_ids).filter(isSafeId), context:text(event.context) ? event.context : null, evidence_paths:strings(event.evidence_paths)}});
   } else {
    const keys = event.type === "answer" ? ["type","id","answer","answered_at"] : ["type","id","reason"];
    if (prior?.state !== "open" || Object.keys(event).some(k => !keys.includes(k)) || (event.type !== "answer" && event.type !== "withdraw")) throw new Error("invalid transition");
    if (event.type === "answer" ? !text(event.answer) || !timestamp(event.answered_at) : !text(event.reason)) throw new Error("invalid transition");
    prior.state = event.type === "answer" ? "answered" : "withdrawn";
    if (event.type === "answer") { prior.answer = String(event.answer); prior.answered_at = String(event.answered_at); }
    else prior.reason = String(event.reason);
   }
  }
  // Stable sort: asks raised in the same second keep journal (raise) order, oldest first.
  return [...records.values()].sort((a,b) => a.ask.created_at.localeCompare(b.ask.created_at));
 }, []);
}
/** Basis from the recorded delegation rule only. A missing standing-orders file matches nothing. */
function standingText(state: ViewerState): string {
 try { return readBounded(join(state.stateDir, "..", "data", "standing-orders.md")); }
 catch { return ""; }
}
function quoted(rule: string): string[] {
 return [...rule.matchAll(/"([^"]+)"/g)].map(m => m[1]!).filter(q => q.length > 0);
}
function basisFor(rule: string | null, standing: string): NonNullable<DecisionDetail["basis"]> {
 if (!rule) return {kind:"judgement", ref:null};
 const ids = rule.match(/ask-[0-9a-f]{12}(?![0-9a-f])/g);
 if (ids?.length) return {kind:"words", ref:ids.join(" · ")};
 const quotes = quoted(rule);
 const hit = quotes.find(q => standing.includes(q));
 if (/standing/i.test(rule) || hit) return {kind:"standing", ref:hit ?? rule.slice(0, 80)};
 if (/verbatim/i.test(rule) || quotes.length) {
  const q = quotes[0];
  if (!q) return {kind:"words", ref:rule.slice(0, 80)};
  const date = /(\d{4}-\d{2}-\d{2})/.exec(rule)?.[1];
  if (!date) return {kind:"words", ref:`“${q}”`};
  const [y, m, d] = date.split("-").map(Number);
  const label = new Intl.DateTimeFormat("en", {month:"short", day:"numeric", timeZone:"UTC"}).format(new Date(Date.UTC(y!, (m ?? 1) - 1, d)));
  return {kind:"words", ref:`${label} · “${q}”`};
 }
 return {kind:"judgement", ref:null};
}
function worthFor(basis: NonNullable<DecisionDetail["basis"]>): DecisionDetail["worth"] {
 return basis.kind === "judgement" ? ["judgement"] : [];
}
export function decisions(state: ViewerState, now: number) {
 const askHistory = asks(state);
 const askSource = {...askHistory, value:askHistory.value.filter(r => r.state === "open").map(r => r.ask)};
 const escalations = objectList(join(state.stateDir,"escalations.json"), "items", e =>
  typeof e.id === "string" && /^es-[A-Za-z0-9_-]+$/.test(e.id) && text(e.question) && timestamp(e.created_at) && ["open","answered","withdrawn","superseded"].includes(String(e.status)) &&
  (e.status !== "answered" || (text(e.answer) && text(e.answered_by) && timestamp(e.answered_at))));
 const represented = new Set(askSource.value.map(a => a.source_escalation));
 const opens = escalations.value.filter(e => e.status === "open");
 const parent_questions: Question[] = opens.filter(e => !represented.has(String(e.id))).map(e => ({id:String(e.id), question:String(e.question), kind:typeof e.kind === "string" ? e.kind : "", created_at:String(e.created_at), job_ids:strings(e.job_ids).filter(isSafeId), age_seconds:Math.max(0,(now-Date.parse(String(e.created_at)))/1000)}));
 const answered = escalations.value.filter(e => e.status === "answered" && today(e.answered_at, now));
 const delegated: Decision[] = answered.filter(e => e.answered_by === "operator-delegated").map(e => {
  const option = (Array.isArray(e.options) ? e.options : []).map(obj).find(o => o?.id === e.answer);
  return {id:String(e.id), question:String(e.question), answer:typeof option?.label === "string" ? option.label : String(e.answer), answered_at:String(e.answered_at), job_ids:strings(e.job_ids).filter(isSafeId)};
 }).sort((a,b) => b.answered_at.localeCompare(a.answered_at));
 const standing = standingText(state);
 const decision_items: DecisionDetail[] = escalations.value.filter(e => e.status === "answered" && (e.answered_by === "operator-delegated" || (text(obj(e.basis)?.run) && e.answered_by === `schedule-run:${obj(e.basis)?.run}`))).map(e => {
  const option = (Array.isArray(e.options) ? e.options : []).map(obj).find(o => o?.id === e.answer || o?.label === e.answer);
  const quote = obj(e.basis)?.operator_quote;
  const rule = text(e.delegation_rule) ? e.delegation_rule : null;
  const run = obj(e.basis)?.run;
  const basis: NonNullable<DecisionDetail["basis"]> = text(run) ? {kind:"run", ref:run} : basisFor(rule, standing);
  return {id:String(e.id), question:String(e.question), answer:typeof option?.label === "string" ? option.label : String(e.answer), quote:text(quote) ? quote : null, answered_at:String(e.answered_at), job_ids:strings(e.job_ids).filter(isSafeId), source:basis.kind === "run" ? "schedule-run" as const : "operator-delegated" as const, project:null, source_escalation:String(e.id), rule, worth:basis.kind === "run" ? [] : worthFor(basis), today:today(e.answered_at,now), kind:text(e.kind) ? e.kind : null, basis};
 });
 for (const record of askHistory.value) {
  if (!record.answer || !record.answered_at) continue;
  const linked = escalations.value.find(e => e.id === record.ask.source_escalation);
  const basis = {kind:"words" as const, ref:record.ask.id};
  decision_items.push({id:record.ask.id, question:record.ask.question, answer:record.answer, quote:record.answer, answered_at:record.answered_at, job_ids:record.ask.job_ids, source:"you", project:record.ask.project, source_escalation:record.ask.source_escalation, rule:null, worth:worthFor(basis), today:today(record.answered_at,now), kind:text(linked?.kind) ? linked.kind : null, basis});
 }
 decision_items.sort((a,b) => Date.parse(b.answered_at)-Date.parse(a.answered_at) || a.id.localeCompare(b.id));
 return {
  askSource, askHistory, escalations, decision_items,
  awaiting:{count:askSource.availability === "unavailable" ? null : askSource.value.length, items:askSource.value},
  parent_questions,
  decided_today:{count:escalations.availability === "unavailable" ? null : delegated.length, items:delegated.slice(0,3), worth_count:null, by_you:askHistory.availability === "unavailable" ? null : askHistory.value.filter(r => r.state === "answered" && !!r.answered_at && today(r.answered_at, now)).length},
  all_questions_delegated:escalations.availability !== "unavailable" && opens.length === 0 && answered.length > 0 && delegated.length === answered.length,
 };
}
