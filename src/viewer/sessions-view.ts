import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JobTranscriptResponse, SessionEntry, SessionsResponse, SessionTier, TranscriptAsk } from "./api-types.ts";
import { listBoards } from "./boards.ts";
import { INBOX_REPLAY_PREFIX, isAskId, parseDashboardText, readUploadMetadata } from "./control-files.ts";
import { operatorSessionsFile, readOperatorSessions } from "./operator-sessions.ts";
import { askDetails, evidenceLink } from "./decision-views.ts";
import { localPaths } from "./linkify.ts";
import { attachPrChips, projectRepos } from "./pr-chips.ts";
import { parseChangeRequestUrl } from "../forge-url.ts";
import { projectByRefs, splitReply } from "./reply-split.ts";
import { applyReplySplits, readReplySplits, replyKey } from "./reply-splits.ts";
import { decisions } from "./overview-decisions.ts";
import { parseObject, source, timestamp } from "./overview-read.ts";
import { modelWindows, operatorContext, parentContext, workerContext } from "./context-usage.ts";
import { modelText } from "./model-text.ts";
import { parseSkillLines } from "./skill-mentions.ts";
import { fleetJobs, num, obj, readObject, resolveSessionFile, runtimeRoot, sessionRoots, sidebar, str, type Json, type ViewerState } from "./sessions.ts";
import { BACKLOG_BYTES, readLines, startOffset } from "./tail.ts";

const sendId = (v: unknown): v is string => typeof v === "string" && /^ps-\d{14}-[a-f0-9]{8}$/.test(v);
const entry = (id: string, at: string, kind: SessionEntry["kind"], who: string, text: string): SessionEntry => ({id,at,kind,who,text,name:null,send_id:null,tag:null,failed:false,trace:[]});
const stamp = (v: unknown) => timestamp(v) ? v : "";
function resultSummary(text: string, failed: boolean): string {
 const parsed = parseObject(text);
 const summary = parsed ? [parsed.summary,parsed.message,parsed.error,parsed.reason,parsed.status].find(v => typeof v === "string") : text.trim().split("\n")[0];
 return String(summary || (failed ? "Failed" : "Completed")).replace(/\s+/g," ").slice(0,140);
}

function textOf(content: unknown, images = true): string {
 if (typeof content === "string") return content;
 if (!Array.isArray(content)) return "";
 return content.map(block => {
  const b = obj(block);
  if (b?.type === "text" && typeof b.text === "string") return b.text;
  return images && b?.type === "image" ? "[image]" : "";
 }).filter(Boolean).join("\n");
}

/**
 * Who the two sides of a CLI transcript are, by tier. The operator session's
 * `user` turns are the human's own words and its `assistant` turns are the agent
 * running in that session — neither is the CP parent, so neither is called
 * "you" here.
 */
const SIDES = {
 parent: {user:"Operator → parent",assistant:"Parent → operator"},
 workers: {user:"Parent",assistant:"Worker"},
 you: {user:"Operator",assistant:"Assistant"},
} as const;

/**
 * One pi session file, entry for entry, the way the CLI shows it: user and
 * assistant messages, tool calls with their paired result, custom (cp-bridge)
 * messages marked as system/bridge, and compaction markers. Thinking is a tool
 * entry named `thinking`. A missing file reads as nothing here; the caller
 * names why.
 */
const BRIDGE_HEAD = /^\[cp-bridge (\S+)((?: \S+=\S+| stale)*)\]$/;
function bridgeHead(text: string): {bridge: NonNullable<SessionEntry["bridge"]>; rest: string} | undefined {
 const nl = text.indexOf("\n"), first = nl < 0 ? text : text.slice(0, nl), m = BRIDGE_HEAD.exec(first);
 if (!m) return;
 const attrs = m[2] ?? "", field = (key: string) => new RegExp(`(?:^| )${key}=(\\S+)`).exec(attrs)?.[1] ?? null;
 return {bridge:{kind:m[1]!,job:field("job"),id:field("id"),receipt:field("receipt")},rest:nl < 0 ? "" : text.slice(nl + 1)};
}
/** `projects/*` directory names, once per read. A missing dir matches nothing. */
function projectNames(state: ViewerState): Set<string> {
 try { return new Set(readdirSync(join(dirname(state.stateDir),"projects"),{withFileTypes:true}).filter(d => d.isDirectory()).map(d => d.name)); }
 catch { return new Set(); }
}
/** Id/URL → project from fleet, ledger labels, asks, escalations and registered repos; never the mandates (they drift). */
function refProject(state: ViewerState, d: ReturnType<typeof decisions>): (ref: string) => string | undefined {
 const jobs = new Map<string,string>(), rawLedger = readObject(join(runtimeRoot(state.home),"jobs.json"))?.jobs;
 for (const j of Array.isArray(rawLedger) ? rawLedger.map(obj) : []) {
  const label = (Array.isArray(j?.labels) ? j.labels : []).find((l): l is string => typeof l === "string" && l.startsWith("project:"));
  if (typeof j?.id === "string" && label) jobs.set(j.id,label.slice("project:".length));
 }
 for (const j of fleetJobs(state)) { const p = str(j.project); if (p) jobs.set(String(j.job_id),p); }
 const asks = new Map(d.askHistory.value.map(({ask}) => [ask.id,str(ask.project)]));
 const escalations = new Map(d.escalations.value.map(e => [String(e.id),(Array.isArray(e.job_ids) ? e.job_ids : []).map(id => jobs.get(String(id))).find(Boolean)]));
 const repos = [...projectRepos(state)].map(([name,r]) => [name,`${r.kind} ${r.web_base_url}/${r.path}`.toLowerCase()] as const);
 return ref => {
  const cr = ref.startsWith("http") ? parseChangeRequestUrl(ref) : undefined, key = cr && `${cr.kind} ${cr.origin}/${cr.path}`.toLowerCase();
  return key ? repos.find(([,k]) => k === key)?.[0] : jobs.get(ref) ?? asks.get(ref) ?? escalations.get(ref);
 };
}
/** The project names and id resolver operator replies split with; the bridge's header guard lints with the same. */
export function operatorReplyContext(state: ViewerState, now = Date.now()): {projects: Set<string>; projectOf: (ref: string) => string | undefined} {
 return {projects:projectNames(state),projectOf:refProject(state,decisions(state,now))};
}
/**
 * Operator tier chips: a reply splits into `[project]` sections (reply-split.ts), its fallback the project of the
 * last own message; own messages only lose a leading known `[project] ` header, as before issue 589.
 */
function stampSegments(entries: SessionEntry[], names: Set<string>, projectOf: (ref: string) => string | undefined): void {
 let replyTo: string | undefined;
 for (const e of entries) {
  if (e.kind === "via" || (e.kind === "say" && e.who === SIDES.you.user)) {
   const m = /^\[([^\]]+)\] /.exec(e.text), named = m && names.has(m[1]!) ? m[1]! : undefined;
   if (named && e.kind === "say") { e.project = named; e.text = e.text.slice(m![0].length); }
   replyTo = named ?? projectByRefs(e.text,{projects:names,projectOf});
   continue;
  }
  if (e.kind !== "say") continue;
  const segments = splitReply(e.text,{projects:names,projectOf,fallback:replyTo});
  if (segments.length > 1) { e.segments = segments; continue; }
  const only = segments[0];
  if (only?.source === "header") e.text = only.text;
  if (only?.projects.length) e.project = only.projects.join(", ");
 }
}
function parseTranscript(state: ViewerState, file: string, sides: {user:string;assistant:string}, backlog = BACKLOG_BYTES): {entries:SessionEntry[];truncated:boolean;keys?:Map<SessionEntry,string>} {
 const start = startOffset(file,undefined,backlog);
 const lines = readLines(file,start.offset,backlog);
 const entries: SessionEntry[] = [];
 const keys = new Map<SessionEntry,string>(); // assistant text block → its reply-splits key
 const calls = new Map<string,SessionEntry>();
 const askCalls = new Set<string>(); // cp_parent ask calls: their result names the ask id
 const answerCalls = new Set<string>(); // cp_parent answer calls: their result names the ans- id (posted, or the first on a duplicate)
 for (const line of lines.lines) {
  const record = parseObject(line.text);
  const at = stamp(record?.timestamp);
  const base = String(line.id);
  if (!record) continue;
  if (record.type === "compaction") {
   const before = num(record.tokensBefore);
   entries.push(entry(`${base}-compaction`,at,"system","compaction",before === undefined ? "Context compacted" : `Context compacted (${before} tokens before)`));
   continue;
  }
  if (record.type === "custom_message") {
   // `display: false` is a message the CLI never showed; skip it for the same reason.
   if (record.display === false) continue;
   const custom = str(record.customType) ?? "custom";
   const text = typeof record.content === "string" ? record.content : textOf(record.content);
   if (!text.trim()) continue;
   const customEntry = entry(`${base}-custom`,at,"system",custom,text);
   customEntry.tag = custom === "cp-bridge" ? "bridge" : "system";
   if (customEntry.tag === "bridge") { const parsed = bridgeHead(text); if (parsed) { customEntry.bridge = parsed.bridge; customEntry.text = parsed.rest; } }
   entries.push(customEntry);
   continue;
  }
  const message = obj(record.message);
  if (!message || record.type !== "message") continue;
  const role = str(message.role) ?? "message";
  if (role === "assistant") {
   const first = entries.length, cost = num(obj(obj(message.usage)?.cost)?.total);
   for (const [i,block] of (Array.isArray(message.content) ? message.content : []).entries()) {
    const b = obj(block); if (!b) continue;
    if (b.type === "text" && str(b.text)) { const e=entry(`${base}-${i}`,at,"say",sides.assistant,String(b.text)); keys.set(e,replyKey(message.timestamp,i)); entries.push(e); }
    if (b.type === "toolCall" || b.type === "thinking") {
     const e = entry(`${base}-${i}`,at,"tool",role,b.type === "thinking" ? String(b.thinking ?? "") : `Arguments\n${JSON.stringify(b.arguments ?? {},null,2)}`);
     e.name = b.type === "thinking" ? "thinking" : str(b.name) ?? "tool";
     e.summary = b.type === "thinking" ? resultSummary(e.text,false) : "Result not recorded";
     if (b.type === "toolCall" && str(b.id)) { calls.set(String(b.id),e); const action=sides === SIDES.you && e.name === "cp_parent" ? obj(b.arguments)?.action : undefined; if (action === "ask") askCalls.add(String(b.id)); if (action === "answer") answerCalls.add(String(b.id)); }
     entries.push(e);
    }
   }
   if (str(message.errorMessage)) { const e=entry(`${base}-error`,at,"say","Error",String(message.errorMessage)); e.failed=true; entries.push(e); }
   if (cost !== undefined && entries[first]) entries[first]!.cost_usd = cost;
  } else if (role === "toolResult") {
   const text=textOf(message.content), callId=str(message.toolCallId), call=callId ? calls.get(callId) : undefined;
   const e=call ?? entry(base,at,"tool",role,"");
   e.name=str(message.toolName) ?? e.name ?? "tool";
   e.text+=`${call ? "\n\n" : ""}Result\n${text}`; e.failed=message.isError === true; e.summary=resultSummary(text,e.failed);
   if (callId && askCalls.has(callId)) { const id=parseObject(text)?.id; if (isAskId(id)) e.ask_id=id; }
   if (callId && answerCalls.has(callId)) { const id=/\bans-[a-f0-9]{12}\b/.exec(text)?.[0]; if (id) e.answer_id=id; }
   if (!call) entries.push(e);
   if (callId) calls.delete(callId);
  } else {
   const text=textOf(message.content);
   if (!text.trim()) continue; // an empty system/prompt record is nothing the CLI showed
   // Image parts follow the text, so the end-anchored marker is read from the text parts alone. The marker's upload ids
   // render as thumbnails (`images`); image parts a marker does not name stay `[image]`.
   const dashboard=role === "user" && sides === SIDES.you && !text.startsWith(INBOX_REPLAY_PREFIX) ? parseDashboardText(textOf(message.content,false)) : undefined;
   if (dashboard) {
    const shown=!dashboard.images && Array.isArray(message.content) ? message.content.filter(b => obj(b)?.type === "image").map(() => "[image]") : [];
    const sk=parseSkillLines(dashboard.body);
    const e=entry(base,at,"via","Operator (dashboard)",[sk.body,...shown].filter(Boolean).join("\n")); e.tag="dashboard"; e.dashboard_id=dashboard.id;
    if (sk.names.length) e.skills=sk.names;
    if (dashboard.images) e.images=dashboard.images;
    if (dashboard.files) e.files=dashboard.files;
    if (dashboard.askId) e.ask_id=dashboard.askId;
    if (dashboard.remote) e.remote=dashboard.remote;
    entries.push(e); continue;
   }
   // Read delivery markers without importing the mutable parent outbox or its policy dependencies.
   const ids=role === "user" ? [...new Set([...text.matchAll(/\[cp-send (ps-\d{14}-[a-f0-9]{8})\b/g)].map(m=>m[1]!))] : [];
   const body=ids.length ? text.replace(/\n*^\[cp-send ps-\d{14}-[a-f0-9]{8} [^\n]*$/gm,"").trim() : text;
   const e=entry(base,at,ids.length ? "via" : "say",role === "user" ? sides.user : role,body);
   e.send_id=ids.length === 1 ? ids[0]! : null; entries.push(e);
  }
 }
 const uploadMetadata=readUploadMetadata(state.stateDir,entries.flatMap(e=>e.files ?? []));
 for (const e of entries) if (e.files) e.file_metadata=Object.fromEntries(e.files.flatMap(id=>uploadMetadata.has(id) ? [[id,uploadMetadata.get(id)!]] : []));
 return {entries,truncated:start.offset>0,keys};
}
/** The parent session file as the Sessions tier parses it, with a caller-sized tail (Stats reads whole archives). */
export function parentTranscript(state: ViewerState, file: string, backlog: number): {entries:SessionEntry[];truncated:boolean} {
 return parseTranscript(state,file,SIDES.parent,backlog);
}

/** A cp-bridge relay's trailing `paths:` block (formatBridgeRelay in src/cp-bridge.ts). */
function relayPaths(text: string): string[] {
 const lines = text.split("\n");
 const at = lines.findIndex((line) => line.trim() === "paths:");
 return at < 0 ? [] : lines.slice(at + 1).filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim()).filter(Boolean);
}

/**
 * Each bridge notice's `paths:` block as viewer links, so the transcript renders a list, never a wall of paths;
 * and every entry's bare `.pi-command-post` paths (linkify.ts) the same helper resolves, as `links`.
 */
function attachNoticePaths(state: ViewerState, entries: SessionEntry[]): void {
 let slugs: string[] | undefined;
 const seen = new Map<string, ReturnType<typeof evidenceLink>>();
 const link = (path: string) => { let found = seen.get(path); if (!found) seen.set(path, found = evidenceLink(state, path, "", () => (slugs ??= listBoards(state).map((board) => board.slug)))); return found; };
 for (const entry of entries) {
  const resolved = localPaths(entry.text).flatMap((path) => { const href = link(path).href; return href ? [[path, href] as const] : []; });
  if (resolved.length) entry.links = Object.fromEntries(resolved);
  if (entry.tag !== "bridge") continue;
  const paths = relayPaths(entry.text);
  if (paths.length) entry.paths = paths.map(link);
 }
}

const WINDOW = 300;
/** The last WINDOW entries; `keep` entries before the window stay (an open decision card is never cut). */
function windowed(entries: SessionEntry[], keep: (e: SessionEntry) => boolean = () => false): {entries:SessionEntry[];cut:boolean} {
 if (entries.length <= WINDOW) return {entries,cut:false};
 const from=entries.length-WINDOW;
 return {entries:entries.filter((e,i)=>i>=from || keep(e)),cut:true};
}

/**
 * Decision cards: each operator ask from the ask journal, right after the `cp_parent ask` call that raised it.
 * An open ask with no call in this file is placed by when it was raised; a settled one with no call is omitted.
 */
function withAskCards(entries: SessionEntry[], asks: ReturnType<typeof decisions>["askHistory"]["value"]): SessionEntry[] {
 const cards=new Map(asks.map(({ask,state,answer,answered_at,reason}) => {
  const card: TranscriptAsk={id:ask.id,question:ask.question,options:ask.options,recommendation:ask.recommendation,state,answer,answered_at,reason};
  const row=entry(`ask-card-${ask.id}`,ask.created_at,"ask","Operator → you",ask.question);
  row.tag=state === "open" ? "awaiting you" : state; row.ask_id=ask.id; row.ask=card;
  return [ask.id,row] as const;
 }));
 const out: SessionEntry[]=[];
 for (const e of entries) {
  out.push(e);
  const card=e.kind === "tool" && e.ask_id ? cards.get(e.ask_id) : undefined;
  if (card) { out.push(card); cards.delete(card.ask_id!); }
 }
 for (const card of cards.values()) {
  if (card.ask?.state !== "open") continue;
  const at=Date.parse(card.at), index=out.findIndex(e=>Date.parse(e.at)>at);
  out.splice(index<0 ? out.length : index,0,card);
 }
 return out;
}

function transcript(state: ViewerState, id: string) {
 const file = resolveSessionFile(state,id);
 if (!file) return {entries:[],truncated:false,warning:"Transcript unavailable"};
 const result = source(() => parseTranscript(state, file, id === "cp-parent" ? SIDES.parent : SIDES.workers),{entries:[] as SessionEntry[],truncated:false});
 const window = windowed(result.value.entries);
 attachNoticePaths(state,window.entries);
 return {entries:window.entries,truncated:result.value.truncated || window.cut,warning:result.availability === "ok" ? null : "Transcript unavailable"};
}

/**
 * A job's worker transcript for the job page: the same safe session resolution as the Sessions tier, but keyed by job id
 * alone, so a done or torn-down job still reads. No recorded session (script job, no file, path outside the roots) is a
 * 200 with a warning, never an error. When the 300-entry window cut the brief, the first Parent message is kept in front.
 */
export function readWorkerTranscript(state: ViewerState, id: string): JobTranscriptResponse {
 const file = resolveSessionFile(state,id);
 if (!file) return {entries:[],truncated:false,warning:"No worker session recorded",from:null,to:null};
 const result = source(() => parseTranscript(state,file,SIDES.workers),{entries:[] as SessionEntry[],truncated:false});
 const all = result.value.entries, window = windowed(all);
 const brief = window.cut && !window.entries.includes(all[0]!) ? all.find(e => e.kind === "say" && e.who === SIDES.workers.user) : undefined;
 const entries = brief && !window.entries.includes(brief) ? [brief,...window.entries] : window.entries;
 attachNoticePaths(state,entries);
 return {entries,truncated:result.value.truncated || window.cut,warning:result.availability === "ok" ? null : "Transcript unavailable",from:entries[0]?.at || null,to:entries.at(-1)?.at || null};
}

export interface SessionsOptions {
 /** Operator tier: the Full transcript view instead of the recorded decisions (the default). */
 transcript?: boolean;
 /** Operator tier: which recorded session file to show; absent is the newest. */
 session?: string | null;
 now?: number;
}

/**
 * The operator tier's Full transcript: the operator session's own pi file, as
 * recorded by the bridge, with every older file still selectable. An unknown
 * `session` id is the same 404 an unknown worker id is; a recorded file that is
 * gone names its path and why in `warnings`, never an empty page.
 */
function operatorTranscript(state: ViewerState, wanted: string | null, now: number, rows: ReturnType<typeof sidebar>, workers: SessionsResponse["workers"]): SessionsResponse | undefined {
 const dir = sessionRoots(state)[0]!;
 const files = readOperatorSessions(dir);
 if (wanted && !files.some((file) => file.id === wanted)) return undefined;
 const selected = wanted ? files.find((file) => file.id === wanted) : files[0];
 const warnings: string[] = [];
 let entries: SessionEntry[] = [];
 let truncated = false, keys = new Map<SessionEntry,string>();
 if (!selected) warnings.push(`No operator session recorded yet (${operatorSessionsFile(dir)})`);
 else {
  try {
   if (!statSync(selected.file).isFile()) throw new Error("not a file");
   const parsed = parseTranscript(state, selected.file, SIDES.you);
   entries = parsed.entries; truncated = parsed.truncated; keys = parsed.keys ?? keys;
  } catch (error) {
   const code = (error as NodeJS.ErrnoException).code;
   warnings.push(`Operator transcript ${code === "ENOENT" ? "missing" : "unreadable"}: ${selected.file} (${code ?? "not a file"})`);
  }
 }
 const d = decisions(state,now), asks = d.askHistory;
 stampSegments(entries,projectNames(state),refProject(state,d));
 if (selected) applyReplySplits(entries,keys,readReplySplits(state.stateDir,selected.file));
 if (asks.availability === "unavailable") warnings.push("asks unavailable");
 const cards = withAskCards(entries,asks.value);
 const window = windowed(cards,(e)=>e.ask?.state === "open");
 entries = window.entries; truncated ||= window.cut;
 attachNoticePaths(state,entries);
 const pr_chips = attachPrChips(state,entries);
 return {
  generated_at: new Date(now).toISOString(), selected: "you", session_id: selected?.id ?? null,
  parent: rows.parent, workers, entries, title: "Operator ↔ you", subtitle: "Full transcript", warnings, truncated,
  transcript: true, operator_session: selected?.id ?? null, operator_sessions: files.map((file) => ({id:file.id,at:file.at})),
  open_asks: askDetails(state,d.awaiting.items,now,d), pr_chips,
 };
}

/** Read-only evidence, never a reconstruction of unrecorded operator speech. */
export function sessionsView(state: ViewerState, tier: SessionTier, workerId: string | null, options: SessionsOptions = {}): SessionsResponse | undefined {
 const now=options.now ?? Date.now();
 const base=sidebar(state,now), windows=modelWindows(state.stateDir);
 const rows={...base,parent:{...base.parent,context:parentContext(state,base.parent,windows)}};
 const workers=[...rows.active,...rows.recent].filter(w=>w.phase !== "done").map(w=>{const context=workerContext(state,w.id,w.model,windows), thinking=context?.thinking ?? w.thinking; return {...w,...(thinking ? {thinking} : {}),...(context ? {context} : {})};});
 const selected=tier === "workers" ? workers.find(w=>w.id===(workerId ?? workers[0]?.id)) : null;
 if (tier === "workers" && workerId && !selected) return undefined;
 if (tier === "you" && options.transcript === true) { const view=operatorTranscript(state,options.session ?? null,now,rows,workers); return view && {...view,operator_context:operatorContext(state,windows)}; }
 const d=decisions(state,now), warnings:string[]=[];
 for (const [name,availability] of [["escalations",d.escalations.availability],["asks",d.askSource.availability]]) if (availability === "unavailable") warnings.push(`${name} unavailable`);
 const bySend=new Map<string,Json[]>();
 for (const e of d.escalations.value) if (sendId(e.send_id)) bySend.set(e.send_id,[...(bySend.get(e.send_id) ?? []),e]);
 const trace=(e:Json): SessionEntry["trace"] => [
  ...(timestamp(e.created_at) ? [{id:String(e.id),label:"parent asked",at:e.created_at,detail:String(e.question)}] : []),
  ...(e.status === "answered" && timestamp(e.answered_at) ? [{id:String(e.id),label:"decided",at:e.answered_at,detail:String(e.answer)}] : []),
 ];
 const entries:SessionEntry[]=[];
 let truncated=false;
 if (tier === "you") {
  for (const e of d.escalations.value.filter(e=>e.status === "answered" && e.answered_by === "operator-delegated")) {
   const option=(Array.isArray(e.options) ? e.options : []).map(obj).find(o=>o?.id === e.answer);
   const row=entry(`decision-${e.id}`,stamp(e.answered_at),"decision","Operator → you",`${e.question}\n${str(option?.label) ?? e.answer}${str(e.delegation_rule) ? `\nRule: ${e.delegation_rule}` : ""}`);
   row.send_id=sendId(e.send_id) ? e.send_id : null;
   row.tag="decided for you"; row.trace=trace(e);
   entries.push(row);
  }
  for (const record of d.askHistory.value) {
   const {ask}=record;
   const row=entry(ask.id,record.answered_at ?? ask.created_at,"ask","Operator → you",[ask.question,record.answer,record.reason].filter(Boolean).join("\n"));
   row.tag=record.state === "open" ? "awaiting you" : record.state;
   const escalation=d.escalations.value.find(e=>e.id===ask.source_escalation);
   row.send_id=sendId(escalation?.send_id) ? escalation.send_id : null;
   row.trace=[...(escalation ? trace(escalation) : []),{id:ask.id,label:"raised",at:ask.created_at,detail:ask.recommendation},...(record.answered_at ? [{id:ask.id,label:"answered",at:record.answered_at,detail:record.answer ?? ""}] : [])];
   row.trace.sort((a,b)=>String(a.at).localeCompare(String(b.at)));
   entries.push(row);
  }
  entries.sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id)); truncated=entries.length>300;
  attachNoticePaths(state,entries);
 } else {
  const id=tier === "parent" ? rows.parent.id : selected?.id;
  if (id) {
   const t=transcript(state,id); entries.push(...t.entries); truncated=t.truncated;
   if (t.warning) warnings.push(t.warning);
   for (const e of entries) if (e.send_id) e.trace=(bySend.get(e.send_id) ?? []).flatMap(trace);
  }
 }
 const shown=entries.slice(-300), pr_chips=attachPrChips(state,shown);
 return {generated_at:new Date(now).toISOString(),selected:tier,session_id:tier === "parent" ? rows.parent.id : selected?.id ?? null,parent:rows.parent,workers,entries:shown,title:tier === "you" ? "Operator ↔ you" : tier === "parent" ? "CP parent" : selected?.id ?? "Workers",subtitle:tier === "you" ? "Recorded decisions and questions" : tier === "workers" && selected ? modelText({model:selected.context?.model ?? selected.model,thinking:selected.thinking}) : "",warnings,truncated,operator_context:operatorContext(state,windows),pr_chips};
}
