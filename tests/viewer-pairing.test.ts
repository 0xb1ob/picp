/**
 * Remote dashboard PR 1b (T2, HTTP half): issue a code from the eligible local screen, load the self-contained pair
 * page, claim over the remote listener, and every refusal on the way — Origin, body shape, replay, level, name, the
 * 10-per-10-minute claim limiter, a stopped binding — with the code never in a URL query, response body or log.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { controlJournalFile } from "../src/viewer/control-files.ts";
import { devicesFile } from "../src/viewer/device-files.ts";
import { DEVICES_REVOKE_PATH, DEVICES_TOKEN } from "../src/viewer/devices-api.ts";
import { bindOrigin } from "../src/viewer/push-api.ts";
import { REMOTE_ORIGIN as ORIGIN, remoteRig } from "./harness/remote.ts";

const rig = (t: { after(fn: () => void): void }) => remoteRig(t, { localDevices: true });
const journal = (stateDir: string): Array<Record<string, unknown>> => readFileSync(controlJournalFile(stateDir), "utf8").trim().split("\n").map((row) => JSON.parse(row));

async function create(env: Awaited<ReturnType<typeof rig>>, body: unknown = {}, headers: Record<string, string> = {}) {
	return env.l("/api/pair/create", {
		method: "POST",
		headers: { origin: bindOrigin(env.options), "content-type": "application/json", "x-cp-control-token": DEVICES_TOKEN, ...headers },
		body: JSON.stringify(body),
	});
}
const claimInit = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("the loopback Add device issues a code; the pair page claims it; the cookie signs in; one secret-free paired line names the route", async (t) => {
	const env = await rig(t);
	const devices = env.devices;
	const listed = await env.l("/api/devices");
	assert.equal(listed.status, 200, "an eligible loopback screen lists devices once device routes are configured");
	assert.equal(listed.body.can_create, true);
	assert.equal(listed.body.token, DEVICES_TOKEN);
	const made = await create(env, { level: "view" });
	assert.equal(made.status, 201);
	const link = String(made.body.link);
	assert.match(link, /^https:\/\/cp\.example\.test\/pair#[A-Za-z0-9_-]{43}$/, "the code travels in the fragment, never a query");
	assert.equal(made.body.level, "view");
	const code = link.split("#")[1]!;
	const page = await env.r("/pair");
	const csp = String(page.headers["content-security-policy"]);
	const script = /<script>([\s\S]*)<\/script>/.exec(page.text)![1]!;
	const style = /<style>([\s\S]*)<\/style>/.exec(page.text)![1]!;
	const sha = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
	assert.ok(csp.includes(`script-src ${sha(script)};`), "the CSP admits exactly the inline script");
	assert.ok(csp.includes(`style-src ${sha(style)};`), "and exactly the inline style");
	assert.doesNotMatch(page.text, /\bsrc=|\bhref=|localStorage|sessionStorage|indexedDB|document\.cookie/, "no asset, no browser storage");
	assert.match(script, /^\(\(\) => \{\nconst code = location\.hash\.slice\(1\);\nhistory\.replaceState\(null, "", location\.pathname\);/, "the fragment is read, then scrubbed before anything else");
	const claimed = await env.r("/api/pair/claim", claimInit({ code, name: "Phone", level: "view" }, { "cf-connecting-ip": "203.0.113.9" }));
	assert.equal(claimed.status, 200);
	assert.deepEqual(claimed.body, { paired: true, name: "Phone", level: "view", redirect: "/" });
	const cookie = String(claimed.headers["set-cookie"]);
	assert.match(cookie, /^__Host-cp_device=dev-[0-9a-f]{16}\.[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
	const value = cookie.split(";")[0]!;
	assert.equal(claimed.text.includes(value.split(".")[1]!), false, "the session secret is only in the HttpOnly cookie");
	assert.equal((await env.r("/api/overview", { headers: { cookie: value } })).status, 200);
	const lines = journal(env.stateDir).filter((line) => line.type === "device");
	assert.deepEqual(lines.map((line) => line.event), ["code_issued", "paired"]);
	assert.equal(lines[0]!.route, "loopback-dashboard");
	assert.equal(lines[1]!.route, "loopback-dashboard");
	assert.equal(lines[1]!.peer, "203.0.113.9");
	const listedEvents = devices.store.list();
	assert.ok(listedEvents.ok);
	assert.equal(listedEvents.events.length, 1, "one durable pairing event");
	for (const text of [readFileSync(controlJournalFile(env.stateDir), "utf8"), readFileSync(devicesFile(env.dataDir), "utf8"), env.logs.join("")]) {
		assert.equal(text.includes(code), false, "the code is never journaled, stored or logged");
		assert.equal(text.includes(value.split(".")[1]!), false, "nor the session secret");
	}
	const replay = await env.r("/api/pair/claim", claimInit({ code, name: "Other" }));
	assert.equal(replay.status, 403, "single use");
	assert.equal(replay.body.error, "code_invalid");
	assert.equal(journal(env.stateDir).filter((line) => line.event === "paired").length, 1, "a replay is a failure line only, never a second pairing");
});

test("claim refusals: Origin, Sec-Fetch-Site, type, size, shape, level, name, expiry — and the claim never takes a query code", async (t) => {
	const env = await rig(t);
	const code = String((await create(env)).body.link).split("#")[1]!;
	const cases: Array<[string, { method: string; headers: Record<string, string>; body: string }, number]> = [
		["wrong Origin", claimInit({ code, name: "A" }, { origin: "https://evil.example" }), 403],
		["no Origin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "A" }) }, 403],
		["cross-site", claimInit({ code, name: "A" }, { "sec-fetch-site": "cross-site" }), 403],
		["form post", claimInit({ code, name: "A" }, { "content-type": "application/x-www-form-urlencoded" }), 415],
		["too large", claimInit({ code, name: "A".repeat(2000) }), 413],
		["extra field", claimInit({ code, name: "A", device_id: "dev-0000000000000000" }), 400],
		["level differs from the code's", claimInit({ code, name: "A", level: "view" }), 403],
		["blank name", claimInit({ code, name: "   " }), 400],
	];
	for (const [label, init, status] of cases) assert.equal((await env.r("/api/pair/claim", init)).status, status, label);
	assert.equal((await env.r(`/api/pair/claim?code=${code}`, claimInit({ name: "A" }))).status, 401, "a query string is not the public claim");
	env.pair("Phone");
	const taken = await env.r("/api/pair/claim", claimInit({ code: String((await create(env)).body.link).split("#")[1], name: "phone" }));
	assert.equal(taken.status, 409, "names are unique case-insensitively");
	const late = String((await create(env)).body.link).split("#")[1]!;
	env.clock.advance(5 * 60_000 + 1);
	const expired = await env.r("/api/pair/claim", claimInit({ code: late, name: "Late" }, { "cf-connecting-ip": "198.51.100.2" }));
	assert.equal(expired.status, 403);
	assert.equal(expired.body.error, "code_expired");
	assert.equal(journal(env.stateDir).filter((line) => line.event === "paired").length, 1, "only the store-paired Phone");
});

test("the claim limiter: 10 attempts per 10 minutes per client address, successes counted, separate from the cookie limiter", async (t) => {
	const env = await rig(t);
	const bad = claimInit({ code: "A".repeat(43), name: "X" }, { "cf-connecting-ip": "203.0.113.1" });
	for (let i = 0; i < 10; i++) assert.equal((await env.r("/api/pair/claim", bad)).status, 403);
	const limited = await env.r("/api/pair/claim", bad);
	assert.equal(limited.status, 429);
	assert.equal(limited.headers["retry-after"], "600");
	const code = String((await create(env)).body.link).split("#")[1]!;
	assert.equal((await env.r("/api/pair/claim", claimInit({ code, name: "Phone" }, { "cf-connecting-ip": "203.0.113.1" }))).status, 429, "a good code waits out the window too");
	const fresh = await env.r("/api/pair/claim", claimInit({ code, name: "Phone" }, { "cf-connecting-ip": "203.0.113.2" }));
	assert.equal(fresh.status, 200, "another address is unaffected, and the code is still unused");
	const device = String(fresh.headers["set-cookie"]).split(";")[0]!;
	assert.equal((await env.r("/api/overview", { headers: { cookie: device, "cf-connecting-ip": "203.0.113.1" } })).status, 200, "claim failures do not lock out a session");
	env.clock.advance(10 * 60_000);
	assert.equal((await env.r("/api/pair/claim", bad)).status, 403, "the window slides");
});

test("Add device refusals: management token, Origin, Sec-Fetch-Site, body shape, three live codes, no running binding, POST only", async (t) => {
	const env = await rig(t);
	assert.equal((await create(env, {}, { "x-cp-control-token": "0".repeat(64) })).status, 403);
	assert.equal((await create(env, {}, { origin: "https://evil.example" })).status, 403);
	// A proxied Host with its own Origin passes the control routes (viewer.strict_host off), never device management.
	const proxy = { host: "8766--dev--box.coder.example", origin: "https://8766--dev--box.coder.example" };
	const proxied = await create(env, {}, proxy);
	assert.deepEqual([proxied.status, proxied.body.error], [403, `Origin must be ${bindOrigin(env.options)}`]);
	const revoke = await env.l(DEVICES_REVOKE_PATH, { method: "POST", headers: { ...proxy, "content-type": "application/json", "x-cp-control-token": DEVICES_TOKEN }, body: JSON.stringify({ id: "dev-0123456789abcdef" }) });
	assert.deepEqual([revoke.status, revoke.body.error], [403, `Origin must be ${bindOrigin(env.options)}`]);
	assert.equal((await create(env, {}, { "sec-fetch-site": "cross-site" })).status, 403);
	assert.equal((await create(env, { level: "admin" })).status, 400);
	assert.equal((await create(env, { level: "full", name: "x" })).status, 400);
	for (let i = 0; i < 3; i++) assert.equal((await create(env)).status, 201);
	assert.equal((await create(env)).status, 429, "at most three live codes");
	env.bound.current = null;
	env.clock.advance(5 * 60_000 + 1);
	assert.equal((await create(env)).status, 409, "no remote listener: nothing to pair with");
	assert.equal(journal(env.stateDir).filter((line) => line.event === "code_issued").length, 3, "refusals issue nothing");
	assert.equal((await env.l("/api/pair/create", { method: "GET" })).status, 405);
});
