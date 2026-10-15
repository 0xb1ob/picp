import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { applyDelta } from "../src/viewer/json-delta.ts";
import { createViewer } from "../src/viewer/server.ts";
import { viewVersions } from "../src/viewer/view-versions.ts";
import { createScratchHome } from "./harness/index.ts";

test("screen GETs carry x-cp-version; a held base gets a keyed delta, an unknown or pre-restart base the full body", async (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const at = "2026-09-26T12:00:00Z";
	const put = (file: string, value: unknown) => { const path = join(home.path, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
	const ids = Array.from({ length: 200 }, (_, i) => `cp-run-${i}`);
	put(".pi-command-post/jobs.json", { jobs: ids.map((id) => ({ id, title: id, status: "in_progress", labels: ["project:demo", "kind:ship"] })) });
	put(LAYOUT.fleetFile, { jobs: ids.map((id) => ({ job_id: id, project: "demo", kind: "ship", phase: "held", dispatched_at: at })) });
	// Exited runs have a fixed elapsed time, so only the rewritten row differs between two GETs.
	const status = (cost: number) => ({ phase: "idle", started_at: at, exited_at: at, usage: { cost_usd: cost, total_tokens: 100 } });
	for (const id of ids) put(`${LAYOUT.runs}/${id}/status.json`, status(1));
	const options = { home: home.path, stateDir: join(home.path, LAYOUT.state), host: "127.0.0.1", port: 0 };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, options.host, resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	const get = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: options.port, path, headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("error", reject); req.end();
	});
	const strip = (value: Record<string, unknown>) => { const { generated_at: _, ...rest } = value; return rest; };

	const first = await get("/api/jobs");
	const v1 = String(first.headers["x-cp-version"]);
	assert.match(v1, /^[0-9a-f]+-\d+$/);
	assert.equal(first.headers["x-cp-delta-base"], undefined);
	put(`${LAYOUT.runs}/cp-run-7/status.json`, status(42));

	const delta = await get("/api/jobs", { "x-cp-delta-base": v1 });
	assert.equal(delta.status, 200);
	assert.equal(delta.headers["x-cp-delta-base"], v1);
	assert.notEqual(delta.headers["x-cp-version"], v1);
	assert.ok(delta.text.length < 5000, `delta must be small, got ${delta.text.length} vs full ${first.text.length}`);
	const fresh = JSON.parse((await get("/api/jobs")).text);
	assert.deepEqual(strip(applyDelta(JSON.parse(first.text), JSON.parse(delta.text))), strip(fresh));

	const bogus = await get("/api/jobs", { "x-cp-delta-base": "bogus-1" });
	assert.equal(bogus.headers["x-cp-delta-base"], undefined, "an unknown base gets the full body");
	assert.deepEqual(strip(JSON.parse(bogus.text)), strip(fresh));
	assert.equal((await get("/api/board", { "x-cp-delta-base": v1 })).headers["x-cp-delta-base"], undefined, "a base is per URL");

	viewVersions.reset();
	const restarted = await get("/api/jobs", { "x-cp-delta-base": v1 });
	assert.equal(restarted.headers["x-cp-delta-base"], undefined, "a pre-restart base never matches");
	assert.deepEqual(strip(JSON.parse(restarted.text)), strip(fresh));

	const missing = await get("/api/job/nope");
	assert.equal(missing.status, 404);
	assert.equal(missing.headers["x-cp-version"], undefined);
});
