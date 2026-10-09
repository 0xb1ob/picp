import { readFileSync, statSync } from "node:fs";
import type { ControlPendingSend } from "./api-types.ts";
import { controlInboxFile, controlJournalFile, DASHBOARD_ID_RE, INBOX_MAX_AGE_MS, readThreads } from "./control-files.ts";
import { operatorSession } from "./control-inbox.ts";

/** Read-only reload projection. Abandoned accepted sends settle without delivery or retry bubbles. */
export function readPendingSends(stateDir: string, now = new Date(), session = operatorSession(stateDir)): {sends: ControlPendingSend[]; sends_error: string | null} {
 const sends = new Map<string, ControlPendingSend>();
 const accepted = new Set<string>();
 const injected = new Set<string>();
 const targets = new Map<string, {since?: string; file?: string}>();
 const errors: string[] = [];
 for (const file of [controlJournalFile(stateDir), controlInboxFile(stateDir)]) {
  let text: string;
  try {
   if (statSync(file).size > 16 * 1024 * 1024) throw new Error("over the 16 MiB read cap");
   text = readFileSync(file, "utf8");
  } catch (error) {
   if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${file}: ${(error as Error).message}`);
   continue;
  }
  const lines = text.split("\n"); lines.pop(); // a torn final line waits for its newline
  for (const row of lines) {
   let line: Record<string, unknown>;
   try { line = JSON.parse(row); } catch { errors.push(`${file}: invalid journal line`); continue; }
   if (!line || typeof line.id !== "string" || !DASHBOARD_ID_RE.test(line.id)) continue;
   if ((line.type === "request" && line.kind === "message") || line.type === "held") {
    if (typeof line.text !== "string" || typeof line.at !== "string" || !Number.isFinite(Date.parse(line.at)) || sends.has(line.id)) continue;
    sends.set(line.id, {id:line.id,at:line.at,state:line.type === "held" ? "held" : "queued",reason:null,ask_id:typeof line.ask_id === "string" ? line.ask_id : null,
     body:{kind:"message",text:line.text,...(line.deliver === "followUp" || line.deliver === "steer" ? {deliver:line.deliver} : {}),...(Array.isArray(line.images) && line.images.every(id=>typeof id === "string") ? {images:line.images} : {}),...(Array.isArray(line.files) && line.files.every(id=>typeof id === "string") ? {files:line.files} : {}),...(typeof line.thread === "string" ? {thread:line.thread} : {})}});
    if (line.type === "request") targets.set(line.id, {since:typeof line.session_started_at === "string" ? line.session_started_at : undefined,file:typeof line.session_file === "string" ? line.session_file : undefined});
    if (line.type === "held") accepted.add(line.id);
   } else {
    const send = sends.get(line.id);
    if (!send) continue;
    if (line.state === "queued" || line.state === "injected") accepted.add(line.id);
    if (line.state === "injected") injected.add(line.id);
    if (send.state === "dropped") continue;
    // cp-y43c: an edit applies only while the dashboard still holds the message (control-queue.ts).
    if (line.type === "edited") { if (typeof line.text === "string" && !injected.has(line.id)) send.body = {...send.body,text:line.text}; continue; }
    if (line.type === "outcome" && line.state === "cancelled") { send.state = "dropped"; send.reason = "Cancelled from the dashboard"; continue; }
    if (line.type === "outcome" && line.state === "dropped") { send.state = "dropped"; send.reason = typeof line.reason === "string" ? line.reason : "Abandoned operator send"; continue; }
    if (line.state === "delivered" || line.type === "delivered") send.state = "delivered";
    else if (line.state === "failed" || line.state === "refused" || line.type === "dropped") { send.state = "failed"; send.reason = typeof line.reason === "string" ? line.reason : "Delivery failed"; }
   }
  }
 }
 // Thread bindings also recover tags from requests written by older bridges that did not journal the tag.
 const threads = readThreads(stateDir);
 for (const send of sends.values()) {
  if (send.state === "queued" && accepted.has(send.id)) {
   const target = targets.get(send.id);
   let missing = false;
   const held = !injected.has(send.id); // cp-y43c: the dashboard's own queue outlives the session; the next one takes it
   if (!held && target?.file) { try { missing = !statSync(target.file).isFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") missing = true; else errors.push(`${target.file}: ${(error as Error).message}`); } }
   const ended = !held && ((!session.running && (session.reason === "no dashboard control record" || session.reason.includes("is not running"))) || (session.running && (target?.since ? target.since !== session.since : !!session.since && Date.parse(send.at) < Date.parse(session.since))));
   if (missing || ended || now.getTime() - Date.parse(send.at) > INBOX_MAX_AGE_MS) {
    send.state = "dropped";
    send.reason = missing ? "target operator session missing" : ended ? "target operator session ended" : "queued longer than 24 h";
   } else if (held) send.editable = true;
  }
  const id = threads.refs.get(`dashboard:${send.id}`);
  const tag = threads.threads.find(thread=>thread.id === id)?.tag;
  if (tag) send.body.thread = tag;
 }
 const all = [...sends.values()].filter(send=>send.state === "delivered" || send.state === "dropped" || accepted.has(send.id)).sort((a,b)=>a.at.localeCompare(b.at));
 const settled = all.filter(send=>send.state === "delivered").slice(-100);
 return {sends:all.filter(send=>send.state !== "delivered" || settled.includes(send)),sends_error:errors.length ? [...new Set(errors)].join("; ") : null};
}
