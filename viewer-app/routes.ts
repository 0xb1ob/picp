/**
 * The route table (dashboard audit P4 §1): the seven desktop items (eight after S8b) and five phone tabs (`primaryNav`), then the views
 * reached through them — Board and Map are Jobs views, Schedules, Files and Settings live under More. Search lists them all.
 */
export const navigation = [
 {id:"overview", label:"Overview", href:"#overview"},
 {id:"decisions", label:"Decisions", href:"#decisions"},
 {id:"jobs", label:"Jobs", href:"#jobs"},
 {id:"sessions", label:"Sessions", href:"#sessions"},
 {id:"reports", label:"Reports", href:"#reports"},
 {id:"more", label:"More", href:"#more"},
 {id:"board", label:"Board", href:"#board"},
 {id:"map", label:"Map", href:"#map"},
 {id:"schedules", label:"Schedules", href:"#schedules"},
 {id:"files", label:"Files", href:"#files"},
 {id:"settings", label:"Settings", href:"#settings"},
] as const;
export type NavId = typeof navigation[number]["id"];
/** The sidebar (desktop) and the tab bar (phone); Reports sits under More on phone only. */
export const primaryNav = (desktop: boolean): readonly NavId[] => desktop ? ["overview","decisions","jobs","sessions","reports","settings","more"] : ["overview","decisions","jobs","sessions","more"];
/** The top-level item a screen belongs to: Board and Map are Jobs views, Schedules and Files (and Reports on phone) are More. */
export function navOwner(screen: Route["screen"], desktop: boolean): NavId {
 if (screen === "job" || screen === "board" || screen === "map") return "jobs";
 if (screen === "schedules" || screen === "files" || (screen === "settings" && !desktop) || (screen === "reports" && !desktop)) return "more";
 return screen;
}
export interface Route {screen:"overview" | "more" | "decisions" | "sessions" | "files" | "map" | "jobs" | "job" | "board" | "reports" | "schedules" | "settings"; jobId?:string; section:"awaiting" | "decided" | "answers" | null; query?:string; defaulted?:boolean}
export function route(hash: string): Route {
 const fallback: Route = {screen:"overview",section:null};
 let value: string; try { value = decodeURIComponent(hash.replace(/^#/,"")); } catch { return fallback; }
 if (/^(sessions|files)(?:\?|$)/.test(hash.replace(/^#/,""))) {
  const [screen,...query]=hash.replace(/^#/,"").split("?");
  const params=new URLSearchParams(query.join("?"));
  if (screen === "sessions" && !params.has("view")) params.set("view","you");
  // Operator ↔ you opens on the Full transcript unless the hash chose (`transcript=0` is Decisions); the
  // app falls back to Decisions when the server refuses the transcript (`defaulted`, see decisionsFallback).
  const defaulted=screen === "sessions" && params.get("view") === "you" && !params.has("transcript");
  if (defaulted) params.set("transcript","1");
  return {...fallback,screen:screen as "sessions" | "files",query:screen === "sessions" ? params.toString() : query.join("?"),...(defaulted ? {defaulted} : {})};
 }
 if (value === "jobs" || value === "board" || value === "reports" || value === "schedules") return {...fallback,screen:value};
 if (/^job\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) return {...fallback,screen:"job",jobId:value.slice(4)};
 if (value.startsWith("job/")) return fallback;
 if (value === "more" || value === "decisions" || value === "map" || value === "settings") return {...fallback,screen:value};
 // Awaiting and Decided are one Decisions page (audit P4 #24): their old hashes scroll to its sections.
 if (value === "awaiting" || value === "decided" || value === "answers") return {...fallback,screen:"decisions",section:value};
 if (/^overview\/(awaiting|decided)$/.test(value)) return {...fallback,section:value.slice(9) as Route["section"]};
 if (value === "dashboard") return {...fallback,screen:"jobs"};
 if (/^(session\/)?cp-[A-Za-z0-9_-]+$/.test(value)) {
  const id=value.replace(/^session\//,"");
  return route(sessionHref(id === "cp-parent" ? "parent" : "workers",id === "cp-parent" ? undefined : id));
 }
 if (/^(files|git)\//.test(value)) {
  const [,root,...path]=value.split("/");
  return root ? route(filesHref(root,path.join("/"))) : fallback;
 }
 return fallback;
}
/** The JSON a detail screen (sessions, files) loads for `current`: the hash's own query, so a deep link reaches the API. */
export function screenDataUrl(current: Route): string {
 const query=new URLSearchParams(current.query);
 // The composer's draft (composerHref) stays in the hash; it never reaches the API.
 query.delete("draft");
 if (current.screen !== "sessions") query.set("view","screen");
 return `/api/${current.screen}?${query}`;
}
export const sessionHref = (tier:"you" | "parent" | "workers", id?:string): string => `#sessions?${new URLSearchParams({view:tier,...(id ? {id} : {})})}`;
/** The Full transcript with its composer prefilled (the Schedules page's Add schedule…). */
export const composerHref = (draft: string): string => `#sessions?${new URLSearchParams({view:"you",transcript:"1",draft})}`;
/** Operator ↔ you's recorded Decisions: an explicit choice, since the bare view opens the Full transcript. */
export const DECISIONS_HREF = "#sessions?view=you&transcript=0";
/** A defaulted Full transcript the server refused (403: not served here) becomes Decisions, silently. */
export const decisionsFallback = (current: Route): Route => {
 const query=new URLSearchParams(current.query); query.set("transcript","0");
 return {...current,query:query.toString(),defaulted:false};
};
export const filesHref = (root:string,path=""): string => `#files?${new URLSearchParams({root,path})}`;
export const jobHref = (id: string): string => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) ? `#job/${encodeURIComponent(id)}` : "#jobs";
