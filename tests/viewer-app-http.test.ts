import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { createViewer, pollingStreams } from "../src/viewer/server.ts";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { buildViewer } from "../src/viewer/build.ts";
import { APP_CSP, APP_VIEWPORT, appPage } from "../src/viewer/app-page.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

test("app asset URLs cannot break out of HTML attributes", () => {
 const page = appPage({script:'/assets/viewer/a"<>&\'.js',stylesheet:'/assets/viewer/b"<>&\'.css',assets:{},duration_ms:0,bytes:0});
 assert.ok(page.includes('src="/assets/viewer/a&quot;&lt;&gt;&amp;&#39;.js"'));
 assert.ok(page.includes('href="/assets/viewer/b&quot;&lt;&gt;&amp;&#39;.css"'));
 assert.ok(page.includes(`<meta name="viewport" content="${APP_VIEWPORT}">`), "no zooming on the app page, safe-area insets on, and Android Chrome resizes for the keyboard");
});

test("a missing app build returns 503 without a classic fallback; APIs and health remain available", async (t) => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const options = { home: home.path, stateDir: join(home.path, LAYOUT.state), host: "127.0.0.1", port: 0 };
 mkdirSync(join(options.stateDir,"sessions"),{recursive:true});
 writeFileSync(join(options.stateDir,"sessions","cp-parent.jsonl"),"{}\n");
 mkdirSync(join(options.stateDir,"operator"),{recursive:true});
 writeFileSync(join(options.stateDir,"operator","asks.jsonl"),`${JSON.stringify({type:"open",id:"ask-ab",created_at:"2026-09-26T11:00:00Z",project:"demo",question:"Keep paused?",options:[{label:"Keep",consequence:"Paused"}],recommendation:"Keep"})}\n`);
 writeFileSync(join(options.stateDir,"escalations.json"),JSON.stringify({items:[{id:"es-parent",status:"open",question:"Proceed?",created_at:"2026-09-26T11:00:00Z",kind:"plan_approval",job_ids:["cp-demo"],options:[]}]}));
 const server = createViewer(options);
 await new Promise<void>((resolve) => server.listen(0, options.host, resolve));
 options.port = (server.address() as AddressInfo).port;
 t.after(() => server.close());
 const get = async (path: string, method = "GET", host = `127.0.0.1:${options.port}`) => new Promise<{status: number; body: string}>((resolve, reject) => {
  const req = request({host: "127.0.0.1", port: options.port, path, method, headers: {host}}, res => {
   let body = ""; res.on("data", c => body += c); res.on("end", () => resolve({status: res.statusCode!, body}));
  }); req.on("error", reject); req.end();
 });
 assert.equal((await get("/")).status, 503);
 assert.doesNotMatch((await get("/")).body, /\/classic/);
 for (const path of ["/classic", "/classic/", "/api/stream?id=cp-parent"]) {
  assert.equal((await get(path)).status, 404, path);
 }
 assert.equal((await get("/healthz")).status, 200);
 assert.equal((await get("/", "POST")).status, 405);
 assert.equal((await get("/", "GET", "evil.example")).status, 421);
 for (const view of ["awaiting","decided","decisions"]) {
  const reply = await get(`/api/${view}`); assert.equal(reply.status,200);
  const data = JSON.parse(reply.body); assert.equal(data.generated_at.length,24); assert.equal(data.awaiting_count,1);
  assert.deepEqual(data.items.map((item:{id:string}) => item.id),view === "decided" ? [] : ["ask-ab"]);
  // Audit P4 #24: the one Decisions page carries Awaiting's asks and the Decided log in one read.
  if (view === "decisions") assert.deepEqual(data.decided,[]);
  for (const method of ["POST","PUT","DELETE"]) assert.equal((await get(`/api/${view}`,method)).status,405);
  assert.equal((await get(`/api/${view}`,"GET","evil.example")).status,421);
  assert.equal((await get(`/api/stream?view=${view}`,"HEAD")).status,200);
 }
 assert.equal((await get("/api/classic/awaiting")).status,404,"the classic awaiting projection is retired");
 assert.equal((await get("/api/stream?view=overview", "HEAD")).status, 200);
 assert.equal(pollingStreams(), 0);
 assert.equal((await get("/api/stream?view=unknown")).status, 404);
 assert.equal((await get("/api/stream?view=unknown&id=cp-parent","HEAD")).status,404);
});

test("built assets are allowlisted under the strict CSP; all requests leave operational state untouched", async t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const stateDir = join(home.path, LAYOUT.state); mkdirSync(stateDir,{recursive:true});
 writeFileSync(join(stateDir,"fleet.json"),JSON.stringify({jobs:[]}));
 const app = await buildViewer({stateDir,packageRoot:REPO_ROOT});
 const snapshot = (dir:string): unknown => readdirSync(dir,{withFileTypes:true}).map(e => [e.name,e.isDirectory() ? snapshot(join(dir,e.name)) : readFileSync(join(dir,e.name)).toString("base64")]);
 const before = snapshot(home.path);
 const options = {home:home.path,stateDir,host:"127.0.0.1",port:0,app};
 const server = createViewer(options); await new Promise<void>(resolve => server.listen(0,options.host,resolve));
 options.port = (server.address() as AddressInfo).port; t.after(() => server.close());
 const get = (path:string,method="GET",host=`127.0.0.1:${options.port}`) => new Promise<{status:number;body:Buffer;headers:Record<string,unknown>}>((resolve,reject) => {
  const req = request({host:"127.0.0.1",port:options.port,path,method,headers:{host}},res => {const chunks:Buffer[]=[];res.on("data",c => chunks.push(c));res.on("end",() => resolve({status:res.statusCode!,headers:res.headers,body:Buffer.concat(chunks)}));}); req.on("error",reject);req.end();
 });
 const root = await get("/"); assert.equal(root.status,200); assert.equal(root.headers["content-security-policy"],APP_CSP);
 assert.match(root.body.toString(),/type="module" src="\/assets\/viewer\//);
 assert.doesNotMatch(root.body.toString(),/<style|style=|unsafe-inline|https?:\/\//);
 for (const [url,asset] of Object.entries(app.assets)) {
  const response = await get(url); assert.equal(response.status,200);assert.equal(response.headers["content-type"],asset.mime);assert.equal(response.headers["content-security-policy"],APP_CSP);assert.deepEqual(response.body,Buffer.from(asset.bytes));
  const head = await get(url,"HEAD"); assert.equal(head.status,200); assert.equal(head.body.length,0);
  assert.equal((await get(url,"POST")).status,405); assert.equal((await get(url,"GET","evil.example")).status,421);
 }
 for (const path of ["/assets/viewer/", "/assets/viewer/%E0", "/assets/viewer/%2e%2e/fleet.json", "/assets/viewer/main.js.map", "/assets/viewer/../../state/fleet.json", `/assets/viewer/sub/../${app.script.split("/").at(-1)}`, "/state/fleet.json", "/viewer-app/main.tsx"]) assert.equal((await get(path)).status,404,path);
 const response = await get("/api/overview"); assert.equal(response.status,200); assert.equal(JSON.parse(response.body.toString()).awaiting.count,0);
 for (const endpoint of ["awaiting","decided","decisions","jobs","board","reports","map","sessions?view=you","sessions?view=parent","sessions?view=workers","files?view=screen"]) {
  const response = await get(`/api/${endpoint}`);
  assert.equal(response.status,200,endpoint);
  assert.match(String(response.headers["content-type"]),/application\/json/);
  JSON.parse(response.body.toString());
 }
 for (const view of ["overview","awaiting","decided","decisions","sessions","files","map","jobs","job","board","reports"]) assert.equal((await get(`/api/stream?view=${view}`,"HEAD")).status,200,view);
 assert.equal((await get("/api/mandates")).status,404,"the Mandates page and its endpoint are gone");
 assert.equal((await get("/api/classic/awaiting")).status,404,"the classic awaiting projection is retired");
 assert.equal(pollingStreams(),0);
 assert.deepEqual(snapshot(home.path),before);
});
