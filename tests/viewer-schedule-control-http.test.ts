/**
 * cp-hhuf P6, the viewer's half: `POST /api/schedules/request` refuses in the dashboard-control order and then its
 * own (shape, parent, token, schedule, pending, journal), journals each refusal once, and answers 202 only after its
 * `request` line is on disk; `GET /api/schedules/control` is --require-tailnet only.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { ControlLimiter } from "../src/viewer/control-api.ts";
import { appendScheduleControlLine } from "../src/viewer/control-audit.ts";
import { controlConfigFile, controlJournalFile, scheduleControlFile } from "../src/viewer/control-files.ts";
import { pushConfigFile, pushDataDir } from "../src/viewer/push-files.ts";
import { createViewer, type ViewerOptions } from "../src/viewer/server.ts";
import { createScratchHome } from "./harness/index.ts";

const ORIGIN = "https://cp.example.ts.net";
const SCHEDULE = "sch-abc123";
const REQUEST = "/api/schedules/request";
const STATUS = "/api/schedules/control";
const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const lines = (file: string): Array<Record<string, unknown>> => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }
function call(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: { host: `127.0.0.1:${port}`, ...options.headers } }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { text += chunk; });
			res.on("end", () => { let body: Record<string, unknown> = {}; try { body = JSON.parse(text); } catch { body = { raw: text }; } resolve({ status: res.statusCode ?? 0, headers: res.headers, body }); });
		});
		req.on("error", reject);
		req.end(options.body);
	});
}

const schedule = { id: SCHEDULE, name: "nightly", project: "demo", mandate_id: "md-abcd1234", trigger: { type: "cron", cron: "0 9 * * *", tz: "UTC" }, job: { title: "nightly report", kind: "research", delivery: "answer" }, enabled: true, created_at: "2026-07-01T00:00:00Z" };

async function setup(t: import("node:test").TestContext, viewer: Partial<ViewerOptions> = {}) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	put(pushConfigFile(pushDataDir(stateDir)), JSON.stringify({ origin: ORIGIN, subject: "mailto:op@example.com", public_key: Buffer.alloc(65, 4).toString("base64url"), created_at: "2026-09-27T08:00:00Z" }));
	put(join(stateDir, "parent.lock"), JSON.stringify({ pid: process.pid, started_at: "2026-07-01T00:00:00Z" }));
	put(join(stateDir, "schedules.json"), JSON.stringify({ schema_version: 1, schedules: [schedule] }));
	const options: ViewerOptions = { home: home.path, stateDir, host: "127.0.0.1", port: 0, requireTailnet: true, log: () => {}, operatorStart: { herdr: null }, ...viewer };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	return { stateDir, options, port: options.port };
}

const json = (token: string | null, body: unknown, extra: Record<string, string> = {}) => ({
	method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
	headers: { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", ...(token ? { "x-cp-control-token": token } : {}), ...extra },
});

test("every refusal, in order, is one viewer line of kind schedule and never a request line", async (t) => {
	const { stateDir, options, port } = await setup(t);
	const token = String((await call(port, STATUS)).body.token);
	assert.match(token, /^[0-9a-f]{64}$/);
	const audit = controlJournalFile(stateDir);
	const body = { op: "disable", schedule_id: SCHEDULE };
	const refused = async (reply: Promise<Reply>, status: number, reason: RegExp, fields: Record<string, unknown> = {}) => {
		options.controlLimiter = new ControlLimiter();
		const before = lines(audit).length;
		const out = await reply;
		assert.equal(out.status, status, JSON.stringify(out.body));
		assert.match(String(out.body.error), reason);
		const after = lines(audit);
		assert.equal(after.length, before + 1, `one audit line for ${status} ${reason}`);
		const line = after.at(-1)!;
		assert.deepEqual({ type: line.type, by: line.by, kind: line.kind, status: line.status, peer: line.peer }, { type: "refused", by: "viewer", kind: "schedule", status, peer: "127.0.0.1" });
		for (const [key, value] of Object.entries(fields)) assert.deepEqual(line[key], value, key);
		assert.equal(lines(scheduleControlFile(stateDir)).filter((l) => l.type === "request").length, 0, "no refusal writes a request line");
	};
	// Method 405 is not journaled.
	assert.equal((await call(port, REQUEST)).status, 405);
	assert.equal(lines(audit).length, 0);
	// Rate: 20 per 60 s per client address, refusals counted.
	options.controlLimiter = new ControlLimiter();
	for (let i = 0; i < 20; i++) await call(port, REQUEST, json(null, "{"));
	const limited = await call(port, REQUEST, json(token, body));
	assert.equal(limited.status, 429);
	assert.equal(lines(audit).at(-1)!.status, 429);
	rmSync(audit);

	put(controlConfigFile(stateDir), '{"enabled": "maybe"}');
	await refused(call(port, REQUEST, json(token, body)), 503, /config is invalid/);
	put(controlConfigFile(stateDir), '{"enabled": false}');
	await refused(call(port, REQUEST, json(token, body)), 403, /dashboard control is off/);
	rmSync(controlConfigFile(stateDir));
	await refused(call(port, REQUEST, json(token, body, { origin: "https://evil.example" })), 403, /Origin must be/);
	await refused(call(port, REQUEST, json(token, body, { "sec-fetch-site": "cross-site" })), 403, /cross-site/);
	await refused(call(port, REQUEST, json(token, body, { "content-type": "text/plain" })), 415, /application\/json/);
	await refused(call(port, REQUEST, json(token, { op: "disable", schedule_id: SCHEDULE, pad: "z".repeat(21 * 1024) })), 413, /20480 bytes/);
	await refused(call(port, REQUEST, json(token, "{not json")), 400, /not JSON/);
	await refused(call(port, REQUEST, json(token, { op: "shell", schedule_id: SCHEDULE })), 400, /body must be/, { schedule_id: SCHEDULE });
	await refused(call(port, REQUEST, json(token, { ...body, extra: 1 })), 400, /body must be/, { op: "disable" });
	await refused(call(port, REQUEST, json(token, { op: "run_now", schedule_id: "sch-../x" })), 400, /body must be/, { op: "run_now", schedule_id: undefined });

	put(join(stateDir, "parent.lock"), JSON.stringify({ pid: 2 ** 30, started_at: "2026-07-01T00:00:00Z" }));
	await refused(call(port, REQUEST, json(token, body)), 503, /parent not running: the recorded parent pid 1073741824 is not running/, { op: "disable", schedule_id: SCHEDULE });
	put(join(stateDir, "parent.lock"), JSON.stringify({ pid: process.pid, started_at: "2026-07-01T00:00:00Z" }));
	await refused(call(port, REQUEST, json(null, body)), 403, /control token missing or stale/);
	await refused(call(port, REQUEST, json("f".repeat(64), body)), 403, /control token missing or stale/);
	await refused(call(port, REQUEST, json(token, { op: "remove", schedule_id: "sch-ffffff" })), 404, /no schedule sch-ffffff/);
	put(join(stateDir, "schedules.json"), "{");
	await refused(call(port, REQUEST, json(token, body)), 503, /schedules unreadable/);
	put(join(stateDir, "schedules.json"), JSON.stringify({ schema_version: 1, schedules: [schedule] }));

	const now = new Date().toISOString();
	for (let i = 0; i < 20; i++) appendScheduleControlLine(stateDir, { type: "request", by: "viewer", id: `sc-00000000000000-${String(i).padStart(8, "0")}`, at: now, peer: null, op: "disable", schedule_id: SCHEDULE });
	const before = lines(scheduleControlFile(stateDir)).length;
	options.controlLimiter = new ControlLimiter();
	const full = await call(port, REQUEST, json(token, body));
	assert.equal(full.status, 409);
	assert.match(String(full.body.error), /20 schedule requests already wait for the parent/);
	assert.equal(lines(scheduleControlFile(stateDir)).length, before);
	rmSync(scheduleControlFile(stateDir));

	if (process.getuid?.() !== 0) {
		appendScheduleControlLine(stateDir, { type: "outcome", by: "parent", id: "sc-x", at: now, state: "done", reason: null, job_id: null });
		chmodSync(scheduleControlFile(stateDir), 0o400);
		await refused(call(port, REQUEST, json(token, body)), 500, /schedule control journal unwritable/);
		chmodSync(scheduleControlFile(stateDir), 0o600);
	}
});

test("a 202 exists only with its request line; the status shows it queued, and one 121 s old expired", async (t) => {
	const { stateDir, port } = await setup(t);
	const status = await call(port, STATUS);
	assert.equal(status.status, 200);
	assert.deepEqual([status.body.enabled, status.body.reason, status.body.error, status.body.requests], [true, null, null, []]);
	assert.deepEqual((status.body.parent as Record<string, unknown>).running, true);
	assert.equal(existsSync(scheduleControlFile(stateDir)), false, "the status route never writes");
	const sent = await call(port, REQUEST, json(String(status.body.token), { op: "run_now", schedule_id: SCHEDULE }));
	assert.equal(sent.status, 202, JSON.stringify(sent.body));
	assert.match(String(sent.body.id), /^sc-\d{14}-[0-9a-f]{8}$/);
	assert.equal(sent.body.state, "queued");
	const [line] = lines(scheduleControlFile(stateDir));
	assert.deepEqual([line?.type, line?.by, line?.id, line?.op, line?.schedule_id, line?.peer], ["request", "viewer", sent.body.id, "run_now", SCHEDULE, "127.0.0.1"]);
	appendScheduleControlLine(stateDir, { type: "request", by: "viewer", id: "sc-00000000000000-00000000", at: new Date(Date.now() - 121_000).toISOString(), peer: null, op: "disable", schedule_id: SCHEDULE });
	const after = (await call(port, STATUS)).body.requests as Array<Record<string, unknown>>;
	assert.deepEqual(after.map((r) => [r.op, r.state]), [["disable", "expired"], ["run_now", "queued"]]);
	assert.match(String(after[0]?.reason), /not taken by the parent within 120 s/);

	put(controlConfigFile(stateDir), '{"enabled": false}');
	const off = await call(port, STATUS);
	assert.deepEqual([off.body.enabled, off.body.token], [false, null], "off: no token");
	assert.match(String(off.body.reason), /^Dashboard control is off/);
	rmSync(controlConfigFile(stateDir));
	rmSync(join(stateDir, "parent.lock"));
	assert.equal((await call(port, STATUS)).body.reason, "Parent not running: no parent lock");
	assert.equal((await call(port, "/api/schedules", { method: "POST" })).status, 405, "/api/schedules stays read-only");
});

test("without --require-tailnet both routes are 403 and nothing is journaled", async (t) => {
	const { stateDir, port } = await setup(t, { requireTailnet: false });
	assert.equal((await call(port, STATUS)).status, 403);
	assert.equal((await call(port, REQUEST, json("x", { op: "disable", schedule_id: SCHEDULE }))).status, 403);
	assert.equal(existsSync(controlJournalFile(stateDir)), false);
	assert.equal(existsSync(scheduleControlFile(stateDir)), false);
});


test("new policy bodies keep the guard chain; client_id returns one receipt without another request",async(t)=>{
 const {stateDir,port}=await setup(t);
 const token=String((await call(port,STATUS)).body.token);
 const body={op:"adopt",schedule_id:SCHEDULE,revision:0,client_id:"sk-20261009090000-abcdef12"};
 assert.equal((await call(port,REQUEST,json(null,body))).status,403);
 assert.equal((await call(port,REQUEST,json(token,body,{origin:"https://evil.example"}))).status,403);
 assert.equal((await call(port,REQUEST,json(token,{...body,revision:-1}))).status,400);
 assert.equal((await call(port,REQUEST,json(token,{...body,op:"save_policy",policy:{}}))).status,400);
 const first=await call(port,REQUEST,json(token,body));assert.equal(first.status,202);
 const before=readFileSync(scheduleControlFile(stateDir),"utf8");
 const again=await call(port,REQUEST,json(token,body));assert.deepEqual(again.body,first.body);
 assert.equal(readFileSync(scheduleControlFile(stateDir),"utf8"),before);
 appendScheduleControlLine(stateDir,{type:"outcome",by:"parent",id:String(first.body.id),at:new Date().toISOString(),state:"done",reason:"Settings saved",job_id:null});
 const done=await call(port,REQUEST,json(token,body));assert.equal(done.body.id,first.body.id);assert.equal(done.body.state,"done");
 const requests=(await call(port,STATUS)).body.requests as Record<string,unknown>[];
 assert.equal(requests[0]?.client_id,body.client_id);assert.equal(requests[0]?.revision,0);
 assert.equal(lines(scheduleControlFile(stateDir)).filter(r=>r.type==="request").length,1);
 const deactivate=await call(port,REQUEST,json(token,{op:"deactivate",schedule_id:SCHEDULE}));assert.equal(deactivate.status,202);
});

test("policy GET is tailnet-only, pure, and names absent/malformed readiness",async(t)=>{
 const {stateDir,port}=await setup(t);
 const path=`/api/schedules/policy?schedule_id=${SCHEDULE}`;
 const before=readFileSync(join(stateDir,"schedules.json"),"utf8");
 const view=await call(port,path);assert.equal(view.status,200);assert.equal(view.body.policy,null);assert.equal(view.body.legacy,null);assert.match(String(view.body.blocking),/needs setup/);
 assert.equal(readFileSync(join(stateDir,"schedules.json"),"utf8"),before);
 assert.equal(existsSync(join(stateDir,"schedule-policies.json")),false);assert.equal(existsSync(scheduleControlFile(stateDir)),false);
 assert.equal((await call(port,"/api/schedules/policy?schedule_id=../bad")).status,400);
 assert.equal((await call(port,"/api/schedules/policy?schedule_id=sch-ffffff")).status,404);
 put(join(stateDir,"schedule-policies.json"),"{");assert.equal((await call(port,path)).status,503);
 const off=await setup(t,{requireTailnet:false});assert.equal((await call(off.port,path)).status,403);
});
