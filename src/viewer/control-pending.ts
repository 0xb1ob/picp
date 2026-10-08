import { readFileSync, statSync } from "node:fs";
import type { ControlPendingSend } from "./api-types.ts";
import { controlInboxFile, controlJournalFile, DASHBOARD_ID_RE, readThreads } from "./control-files.ts";

/** Read-only reload projection. Keep every unresolved send; settled rows only update a browser's existing bubbles. */
export function readPendingSends(stateDir: string): {sends: ControlPendingSend[]; sends_error: string | null} {
 const sends = new Map<string, ControlPendingSend>();
 const accepted = new Set<string>();
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
    if (line.type === "held") accepted.add(line.id);
   } else {
    const send = sends.get(line.id);
    if (!send) continue;
    if (line.state === "queued" || line.state === "injected") accepted.add(line.id);
    if (line.state === "delivered" || line.type === "delivered") send.state = "delivered";
    else if (line.state === "failed" || line.state === "refused" || line.type === "dropped") { send.state = "failed"; send.reason = typeof line.reason === "string" ? line.reason : "Delivery failed"; }
   }
  }
 }
 // Thread bindings also recover tags from requests written by older bridges that did not journal the tag.
 const threads = readThreads(stateDir);
 for (const send of sends.values()) {
  const id = threads.refs.get(`dashboard:${send.id}`);
  const tag = threads.threads.find(thread=>thread.id === id)?.tag;
  if (tag) send.body.thread = tag;
 }
 const all = [...sends.values()].filter(send=>send.state === "delivered" || accepted.has(send.id)).sort((a,b)=>a.at.localeCompare(b.at));
 const settled = all.filter(send=>send.state === "delivered").slice(-100);
 return {sends:all.filter(send=>send.state !== "delivered" || settled.includes(send)),sends_error:errors.length ? [...new Set(errors)].join("; ") : null};
}
