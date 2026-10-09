import assert from "node:assert/strict";
import { test } from "node:test";
import { route, navigation, navOwner, primaryNav, jobHref } from "../viewer-app/routes.ts";
test("hash routes normalize unknown input and migrate legacy deep links into the app", () => {
 for (const hash of ["", "#%E0", "#unknown", "#overview/missing"]) assert.deepEqual(route(hash), {screen:"overview", section:null});
 assert.equal(route("#more").screen,"more");
 // Audit P4 #24: Awaiting and Decided are one Decisions page; their old hashes still resolve, to its sections.
 assert.deepEqual(route("#decisions"),{screen:"decisions",section:null});
 assert.deepEqual(route("#awaiting"),{screen:"decisions",section:"awaiting"});
 assert.deepEqual(route("#decided"),{screen:"decisions",section:"decided"});
 assert.equal(navigation.find(n => n.id === "decisions")?.href,"#decisions");
 // The Mandates page is gone: old links fall back to the Overview, and nothing links to it.
 for (const hash of ["#mandates","#overview/mandates"]) assert.deepEqual(route(hash),{screen:"overview",section:null},hash);
 assert.equal(navigation.some(n => n.id === ("mandates" as string)),false);
 for (const [hash,screen,query] of [
  ["#session/cp-parent","sessions","view=parent"],
  ["#session/cp-a","sessions","view=workers&id=cp-a"],
  ["#cp-a","sessions","view=workers&id=cp-a"],
  ["#files/project:demo","files","root=project%3Ademo&path="],
  ["#files/project%3Ademo/dir%2Fa%3Fb","files","root=project%3Ademo&path=dir%2Fa%3Fb"],
  ["#git/project%3Ademo","files","root=project%3Ademo&path="],
  ["#dashboard","jobs",undefined],
 ] as const) assert.deepEqual(route(hash),{screen,section:null,...(query ? {query} : {})},hash);
 assert.equal(route("#files").screen,"files");
 assert.equal(route("#sessions?view=workers&id=cp-a").screen,"sessions");
 assert.equal(route("#files?root=project%3Ademo&path=a%3Fb").query,"root=project%3Ademo&path=a%3Fb");
 assert.equal(navigation.find(n=>n.id==="map")?.href,"#map");
 assert.equal(route("#map").screen,"map");
 assert.equal(route("#jobs").screen,"jobs");
 assert.equal(route("#board").screen,"board");
 assert.equal(route("#job/cp-a").screen,"job");
 assert.equal(route("#job/cp-a").jobId,"cp-a");
 assert.equal(route("#job/..%2Fbad").screen,"overview");
 assert.equal(jobHref("../bad"),"#jobs");
 assert.equal(jobHref("cp-a"),"#job/cp-a");
 assert.equal(navigation.find(n => n.id === "board")?.href,"#board");
 assert.equal(route("#reports").screen,"reports");
 assert.equal(navigation.find(n => n.id === "reports")?.href,"#reports");
});
test("audit P4: every pre-consolidation hash keeps resolving, and the nav shows eight desktop items and five phone tabs", () => {
 // The hashes the app answered before phase 4, each with the screen (and section) it lands on now.
 for (const [hash,screen,section] of [
  ["#overview","overview",null],["#more","more",null],["#awaiting","decisions","awaiting"],["#decided","decisions","decided"],
  ["#jobs","jobs",null],["#board","board",null],["#map","map",null],["#reports","reports",null],["#schedules","schedules",null],["#settings","settings",null],
  ["#files","files",null],["#sessions","sessions",null],["#job/cp-a","job",null],["#overview/awaiting","overview","awaiting"],["#dashboard","jobs",null],
 ] as const) {
  assert.equal(route(hash).screen,screen,hash); assert.equal(route(hash).section,section,hash);
 }
 // Every entry in the route table routes to itself: nothing links to a hash that falls back to the Overview.
 for (const n of navigation) assert.equal(route(n.href).screen,n.id,n.href);
 assert.deepEqual(primaryNav(true),["overview","decisions","jobs","sessions","stats","reports","settings","more"]);
 assert.equal(route("#stats").screen,"stats"); assert.equal(route("#stats?range=7d&project=a").query,"range=7d&project=a");
 assert.equal(navOwner("stats",true),"stats"); assert.equal(navOwner("stats",false),"more");
 assert.deepEqual(primaryNav(false),["overview","decisions","jobs","sessions","more"]);
 // Board and Map light Jobs; Schedules and Files light More (Reports too, on phone only).
 for (const [screen,desktop,owner] of [["board",true,"jobs"],["map",false,"jobs"],["job",true,"jobs"],["schedules",true,"more"],["files",false,"more"],["settings",true,"settings"],["settings",false,"more"],["reports",true,"reports"],["reports",false,"more"],["decisions",false,"decisions"]] as const) assert.equal(navOwner(screen,desktop),owner,`${screen} ${desktop}`);
});
