import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CapacityReader } from "../src/capacity.ts";
import { createScratchHome } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

const providers = ["anthropic", "openai"];

function homeWithConfig(config: object): string {
	const home = createScratchHome();
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "capacity.json"), JSON.stringify(config));
	return home.path;
}

function fleet() {
	return { read: () => ({ jobs: [
		{ phase: "waiting", worker: { model: "anthropic/opus" } },
		{ phase: "waiting", worker: { model: "anthropic/sonnet" } },
		{ phase: "held", worker: { model: "openai/gpt" } },
	] }) } as unknown as ConstructorParameters<typeof CapacityReader>[0]["fleet"];
}

const config = { url: "https://gateway.example", path: "/api/admin/capacity" };
// Shape captured from the live sub2api /api/v1/admin/ops/concurrency (2026-09-26), counts changed.
const row = (max: number, used: number, queued: number) => ({ current_in_use: used, max_capacity: max, load_percentage: 0, waiting_in_queue: queued });
const snapshot = (platform: object, extra: object = {}) => ({ code: 0, message: "success", data: { account: {}, group: {}, enabled: true, timestamp: "2026-09-25T00:00:00.330580943Z", platform, ...extra } });
const valid = snapshot({ anthropic: row(8, 2, 0), openai: row(20, 19, 1), grok: row(10, 0, 0) });

test("admin capacity is numeric per provider, uses only admin key and redacts source", async () => {
	const home = homeWithConfig({ ...config, quota: { five_hour: 90, seven_day: 85 } });
	const reader = new CapacityReader({ home, env: { CP_GATEWAY_ADMIN_KEY: "private-key" }, fetch: async (url, init) => {
		assert.equal(url, "https://gateway.example/api/admin/capacity");
		assert.equal(init?.method, "GET");
		assert.equal(new Headers(init?.headers).get("x-api-key"), "private-key");
		assert.equal(new Headers(init?.headers).has("Authorization"), false);
		assert.equal(init?.signal?.aborted, false);
		return Response.json(valid);
	} });
	assert.deepEqual(await reader.read(providers), { anthropic: { score: 6, source: "admin" }, openai: { score: 0, source: "admin" } });
});

test("malformed, missing provider, disabled and timeout use fleet counts; no key preserves order", async () => {
	const home = homeWithConfig(config);
	const fallback = { anthropic: { score: -2, source: "fleet" }, openai: { score: 0, source: "fleet" } };
	const unreadable = { anthropic: { score: -2, source: "fleet", reason: "capacity response unreadable" }, openai: { score: 0, source: "fleet", reason: "capacity response unreadable" } };
	for (const body of [
		snapshot({ anthropic: row(8, 0, 0) }),
		snapshot({ anthropic: row(8, 0, 0), openai: row(20, 0, 0) }, { enabled: false }),
		snapshot({ anthropic: row(8, 0, 0), openai: row(20, 0, 0) }, { timestamp: "bad" }),
		snapshot({ anthropic: row(8, -1, 0), openai: row(20, 0, 0) }),
		{ code: 0, enabled: true, timestamp: "2026-09-25T00:00:00Z", platforms: { anthropic: { free_slots: 6 }, openai: { free_slots: 0 } } },
		{ ...valid, code: 1 },
	]) {
		const reader = new CapacityReader({ home, fleet: fleet(), env: { CP_GATEWAY_ADMIN_KEY: "private-key" }, fetch: async () => Response.json(body) });
		assert.deepEqual(await reader.read(providers), unreadable);
	}
	const thrown = new CapacityReader({ home, fleet: fleet(), env: { CP_GATEWAY_ADMIN_KEY: "private-key" }, fetch: async () => { throw new Error("private-key failed"); } });
	assert.deepEqual(await thrown.read(providers), fallback);
	assert.deepEqual(await new CapacityReader({ home, fleet: fleet(), env: {}, fetch: async () => { throw new Error("must not fetch"); } }).read(providers), { anthropic: { source: "unknown" }, openai: { source: "unknown" } });
	const timeoutReader = new CapacityReader({ home, fleet: fleet(), env: { CP_GATEWAY_ADMIN_KEY: "private-key" }, fetch: async (_url, init) => new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new Error("private-key timeout")));
		}) });
	assert.deepEqual(await timeoutReader.read(providers), fallback);
	for (const invalid of [{ url: "http://gateway.example", path: config.path }, { ...config, admin_key: "private-key" }, { url: "https://private-key@gateway.example", path: config.path }]) {
		const badHome = homeWithConfig(invalid);
		assert.deepEqual(await new CapacityReader({ home: badHome, fleet: fleet(), env: { CP_GATEWAY_ADMIN_KEY: "private-key" }, fetch: async () => { throw new Error("invalid endpoint was fetched"); } }).read(providers), fallback);
	}
});

test("401 uses fleet counts and names the rejected admin credential", async () => {
	const reader = new CapacityReader({ home: homeWithConfig(config), fleet: fleet(), env: { CP_GATEWAY_ADMIN_KEY: "private-key" }, fetch: async () => new Response("private-key", { status: 401 }) });
	assert.deepEqual(await reader.read(providers), {
		anthropic: { score: -2, source: "fleet", reason: "capacity auth rejected" },
		openai: { score: 0, source: "fleet", reason: "capacity auth rejected" },
	});
});

test("unreadable or missing fleet means unknown, never a fabricated zero", async () => {
	const home = homeWithConfig(config);
	const unreadableFleet = { read: () => { throw new Error("private-key in fleet error"); } } as unknown as ConstructorParameters<typeof CapacityReader>[0]["fleet"];
	assert.deepEqual(await new CapacityReader({ home, env: {}, fleet: unreadableFleet }).read(providers), { anthropic: { source: "unknown" }, openai: { source: "unknown" } });
	assert.deepEqual(await new CapacityReader({ home, env: {} }).read(providers), { anthropic: { source: "unknown" }, openai: { source: "unknown" } });
});
