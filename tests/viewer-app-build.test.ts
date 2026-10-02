import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildViewer } from "../src/viewer/build.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

test("build publishes only hashed JS CSS and fonts under the selected state directory", async t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const stateDir = join(home.path, LAYOUT.state);
 const app = await buildViewer({stateDir, packageRoot: REPO_ROOT});
 assert.match(app.script, /^\/assets\/viewer\/main-[A-Z0-9]+\.js$/);
 assert.match(app.stylesheet, /\.css$/);
 assert.equal(Object.values(app.assets).filter(a => a.mime === "font/woff2").length, 8);
 for (const [url, asset] of Object.entries(app.assets)) {
  assert.deepEqual(readFileSync(join(stateDir, "viewer-dist", url.split("/").at(-1)!)), Buffer.from(asset.bytes));
 }
 assert.ok(app.bytes > 0);
});

test("build refuses a symlinked output directory and missing package entry", async t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const stateDir = join(home.path, LAYOUT.state); mkdirSync(stateDir, {recursive:true});
 const outside = join(home.path, "outside"); mkdirSync(outside);
 writeFileSync(join(outside, "sentinel"), "keep");
 symlinkSync(outside, join(stateDir, "viewer-dist"));
 await assert.rejects(buildViewer({stateDir, packageRoot: REPO_ROOT}), /symlink|directory/);
 assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "keep");
 await assert.rejects(buildViewer({stateDir: join(home.path, "other"), packageRoot: home.path}));
});

test("the compilation deadline cancels and disposes without publishing a partial snapshot", async t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const schedule = globalThis.setTimeout;
 t.mock.method(globalThis,"setTimeout",(callback:()=>void,ms?:number) => {
  const timer = schedule(callback,ms);
  if (ms === 30_000) queueMicrotask(callback);
  return timer;
 });
 await assert.rejects(buildViewer({stateDir:join(home.path, LAYOUT.state)}),/exceeded 30 seconds/);
 assert.deepEqual(readdirSync(join(home.path, LAYOUT.state,"viewer-dist")),[]);
});

test("CLI catches a broken esbuild executable, keeps health available, and resolves inputs independently of cwd", async t => {
 const home = createScratchHome(); t.after(() => home.cleanup());
 const built = spawnSync(process.execPath,[join(REPO_ROOT,"scripts/build-viewer.ts"),"--home",home.path],{cwd:home.path,env:process.env,encoding:"utf8",timeout:45_000});
 assert.equal(built.status,0,built.stderr); assert.match(built.stdout,/10 assets/);
 const broken = join(home.path,"broken-esbuild"); writeFileSync(broken,"#!/bin/sh\nexit 1\n"); chmodSync(broken,0o755);
 const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0,"127.0.0.1",resolve));
 const port = (reservation.address() as AddressInfo).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
 const child = spawn(process.execPath,[join(REPO_ROOT,"src/viewer/cli.ts"),"--home",home.path,"--host","127.0.0.1","--port",String(port)],{cwd:home.path,env:{...process.env,ESBUILD_BINARY_PATH:broken},stdio:["ignore","pipe","pipe"]});
 const closed = once(child,"exit");
 t.after(async () => { child.kill("SIGTERM"); await closed; });
 let stderr = ""; child.stderr.on("data",c => stderr += c);
 await new Promise<void>((resolve,reject) => {
  const timer = setTimeout(() => reject(new Error(`CLI failed to listen: ${stderr}`)),10_000);
  let stdout = "";
  child.stdout.on("data",c => { stdout += c; if (stdout.includes(`http://127.0.0.1:${port}/`)) { clearTimeout(timer); resolve(); } });
  child.on("error",e => { clearTimeout(timer); reject(e); });
  child.on("exit",() => { clearTimeout(timer); reject(new Error(stderr)); });
 });
 assert.match(stderr,/startup build failed/);
 assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status,503);
 assert.equal((await fetch(`http://127.0.0.1:${port}/classic`)).status,404);
 assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status,200);
});
