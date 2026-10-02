import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT, RoutingDecisionSchema, validate } from "../src/contracts.ts";
import { QuotaReader, formatQuota, loadCapacityConfig } from "../src/quota.ts";
import { createScratchHome } from "./harness/index.ts";

const account = (id: number, platform = "anthropic", extra = {}) => ({ id, platform, type: "oauth", status: "active", schedulable: true, temp_unschedulable_until: null, overload_until: null, ...extra });
const usage = (five: number, seven: number) => ({ code: 0, data: { five_hour: { utilization: five }, seven_day: { utilization: seven } } });
function setup(t: { after(fn: () => void): void }, fetch: typeof globalThis.fetch, quota?: object, env = { CP_GATEWAY_ADMIN_KEY: "private-key" }) {
	const home = createScratchHome();
	t.after(home.cleanup);
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "capacity.json"), JSON.stringify({ url: "https://gateway.example", path: "/capacity", ...(quota ? { quota } : {}) }));
	return new QuotaReader({ home: home.path, env, fetch });
}

test("loadCapacityConfig reads <home>/.pi-command-post/data/capacity.json, never a top-level data/ (cp-u3i2)", (t) => {
	const home = createScratchHome();
	t.after(home.cleanup);
	const body = JSON.stringify({ url: "https://gateway.example", path: "/capacity" });
	// Legacy-layout negative fixture: the old top-level file alone is not config.
	mkdirSync(join(home.path, "data"), { recursive: true });
	writeFileSync(join(home.path, "data/capacity.json"), body);
	assert.throws(() => loadCapacityConfig(home.path), /capacity config unreadable/);
	mkdirSync(join(home.path, ".pi-command-post/data"), { recursive: true });
	writeFileSync(join(home.path, ".pi-command-post/data/capacity.json"), body);
	assert.equal(loadCapacityConfig(home.path).endpoint, "https://gateway.example/capacity");
});

test("quota filters accounts, selects the lowest maximum, and coalesces cached reads", async (t) => {
	const calls: string[] = [];
	const reader = setup(t, async (url, init) => {
		assert.equal(new Headers(init?.headers).get("x-api-key"), "private-key");
		const path = new URL(String(url)).pathname;
		calls.push(path);
		if (path.endsWith("/accounts")) return Response.json({ code: 0, data: { items: [
			account(1), account(2, "anthropic", { schedulable: false }), account(3, "grok"),
			account(4, "anthropic", { type: "apikey" }), account(5, "openai"), account(6, "anthropic", { overload_until: "2000-01-01T00:00:00Z" }),
			account(7, "anthropic", { status: "disabled" }), account(8, "anthropic", { overload_until: "2999-01-01T00:00:00Z" }),
			account(9, "anthropic", { temp_unschedulable_until: "2999-01-01T00:00:00Z" }),
		] } });
		return Response.json(path.includes("/1/") ? usage(2, 86) : path.includes("/6/") ? usage(95, 20) : usage(0, 11));
	});
	const [snapshot, concurrent] = await Promise.all([reader.read(["anthropic", "openai"]), reader.read(["anthropic", "openai"])]);
	assert.deepEqual(concurrent, snapshot);
	assert.equal(formatQuota(snapshot), "quota=anthropic:5h=2,7d=86(tight),openai:5h=n/a,7d=11");
	await reader.read(["anthropic", "openai"]);
	assert.equal(calls.length, 4);
	assert.deepEqual(calls.sort(), ["/api/v1/admin/accounts", "/api/v1/admin/accounts/1/usage", "/api/v1/admin/accounts/5/usage", "/api/v1/admin/accounts/6/usage"]);
	assert.deepEqual(reader.latest, snapshot);
	const decision = { model: "openai/gpt", source: "rubric", rule: "r", quota: snapshot };
	assert.ok(validate(RoutingDecisionSchema, decision).ok);
	assert.ok(!validate(RoutingDecisionSchema, { ...decision, quota: { ...snapshot, secret: "private-key" } }).ok);
	assert.ok(!validate(RoutingDecisionSchema, { ...decision, quota: { providers: [], reason: "private-key" } }).ok);
});

test("an unreported 5h window keeps the account on 7d alone; a real 0/0 stays real", async (t) => {
	for (const [five, seven, formatted, tight] of [
		[0, 11, "5h=n/a,7d=11", false],
		[0, 90, "5h=n/a,7d=90", true],
		[2, 86, "5h=2,7d=86", true],
		[0, 0, "5h=0,7d=0", false],
	] as const) {
		const reader = setup(t, async (url) => Response.json(String(url).includes("?")
			? { code: 0, data: { items: [account(1, "openai")] } } : usage(five, seven)));
		const snapshot = await reader.read(["openai"]);
		assert.equal(formatQuota(snapshot), `quota=openai:${formatted}${tight ? "(tight)" : ""}`);
		assert.equal(snapshot.providers[0]?.tight, tight);
	}
});

test("quota accepts a confirmed full page and refuses incomplete or uncertain lists", async (t) => {
	for (const [count, total, complete] of [
		[50, 50, true], [49, undefined, true], [49, 49, true],
		[50, undefined, false], [50, 51, false], [49, 50, false],
		[50, 49, false], [50, "50", false], [50, null, false],
	] as const) {
		let usageCalls = 0;
		const reader = setup(t, async (url) => {
			if (String(url).includes("?")) return Response.json({ code: 0, data: {
				items: Array.from({ length: count }, (_, id) => account(id + 1)),
				...(total === undefined ? {} : { total }),
			} });
			usageCalls++;
			return Response.json(usage(2, 11));
		});
		const snapshot = await reader.read(["anthropic"]);
		assert.equal(formatQuota(snapshot), complete ? "quota=anthropic:5h=2,7d=11" : "quota unavailable: unreadable", `count=${count}, total=${total}`);
		assert.equal(usageCalls, complete ? count : 0, "uncertain lists must not query account usage");
	}
});

test("unsupported shapes and API key accounts are unknown, custom thresholds apply", async (t) => {
	const reader = setup(t, async (url) => Response.json(String(url).includes("?")
		? { code: 0, data: { items: [account(1), account(2, "openai", { type: "apikey" }), account(3, "grok"), account(4, "deepseek")] } }
		: String(url).includes("/1/") ? usage(2, 86) : String(url).includes("/4/") ? { code: 500 } : { code: 0, data: { tokens: 10 } }), { five_hour: 95, seven_day: 90 });
	const snapshot = await reader.read(["anthropic", "openai", "grok", "deepseek"]);
	assert.equal(formatQuota(snapshot), "quota=anthropic:5h=2,7d=86,openai:unknown,grok:unknown,deepseek:unknown");
	assert.ok(snapshot.providers.every((provider) => !provider.tight));
});

test("quota thresholds include their boundary and invalid percentages stay unknown", async (t) => {
	for (const [five, seven, tight] of [[90, 0, true], [89, 84, false], [0, 85, true], [101, 0, false]] as const) {
		const reader = setup(t, async (url) => Response.json(String(url).includes("?")
			? { code: 0, data: { items: [account(1)] } } : usage(five, seven)));
		assert.equal((await reader.read(["anthropic"])).providers[0]?.tight, tight);
	}
});

test("quota names failures without secrets and makes no call without a key", async (t) => {
	for (const [status, reason] of [[401, "auth rejected"], [503, "unreadable"]] as const) {
		const reader = setup(t, async () => new Response("private-key", { status }));
		assert.equal(formatQuota(await reader.read(["anthropic"])), `quota unavailable: ${reason}`);
	}
	const reader = setup(t, async () => { assert.fail("must not call gateway"); }, undefined, { CP_GATEWAY_ADMIN_KEY: "" });
	assert.equal(formatQuota(await reader.read(["anthropic"])), "quota=off:no admin key");
});

test("quota refreshes after 60 seconds and rejects malformed configuration before fetching", async (t) => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	let calls = 0;
	const reader = setup(t, async () => { calls++; return Response.json({ code: 0, data: { items: [] } }); });
	await reader.read(["anthropic"]);
	now += 59_999;
	await reader.read(["anthropic"]);
	assert.equal(calls, 1);
	now++;
	await reader.read(["anthropic"]);
	assert.equal(calls, 2);
	for (const quota of [{ five_hour: -1 }, { seven_day: 101 }, { five_hour: "90" }, { weekly: 85 }, { balance_margin: "10" }, { balance_margin: true }, { balance_margin: {} }]) {
		const invalid = setup(t, async () => { assert.fail("invalid config must not be fetched"); }, quota);
		assert.equal(formatQuota(await invalid.read(["anthropic"])), "quota unavailable: unreadable");
	}
});

test("quota has a total timeout even when fetch ignores the abort signal", async (t) => {
	const reader = setup(t, async () => new Promise(() => {}));
	assert.equal(formatQuota(await reader.read(["anthropic"])), "quota unavailable: timeout");
});
