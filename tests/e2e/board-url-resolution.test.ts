/**
 * cp-board-url-proxy: the one board-link resolver (tunnel, public_url, host, tailnet, relative) through the real parent's
 * intake, `responseReportUrl` and the settings write. Cases (a) no address and (f) artifact_path live in intake-p9f.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { responseReportUrl } from "../../src/response-reports.ts";
import { tunnelConfigFile, tunnelRuntimeFile } from "../../src/service/daemon-tunnel-files.ts";
import { applySettings } from "../../src/settings-write.ts";
import { readSettings } from "../../src/settings.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, readFleet, startRpc, waitFor } from "../harness/index.ts";

const DEAD_PID = 2147483600;

test("board-url-resolution: tunnel beats public_url beats the pinned host, for intake and responseReportUrl; bad public URLs are refused", { timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	const agent = createAgentDir();
	t.after(() => { agent.cleanup(); home.cleanup(); });
	const store = new FleetStore({ home: home.path });
	const bin = join(home.path, "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "tailscale"), "#!/bin/sh\nexit 1\n");
	chmodSync(join(bin, "tailscale"), 0o755);
	const board = async (id: string) => {
		await store.add({ job_id: id, project: "demo", kind: "research", delivery: "board", origin: DEFAULT_ORIGIN, phase: "waiting", branch: id,
			worktree: join(home.path, "wt"), dispatched_at: isoTimestamp(), usage: EMPTY_USAGE, worker: { pid: DEAD_PID, session_id: "s",
				session_file: join(home.path, "s.jsonl"), profile: "planner", role: "planner", model: "mock/model", started_at: isoTimestamp() } } as FleetRecord);
		const source = join(home.path, paths.artifactDir(id));
		mkdirSync(join(source, "site"), { recursive: true });
		writeFileSync(join(source, "board.json"), JSON.stringify({ title: "Status", description: "Current jobs", job_ids: [id], created_at: isoTimestamp() }));
		writeFileSync(join(source, "site/index.html"), "<h1>Status</h1>");
		mkdirSync(join(home.path, paths.runDir(id)), { recursive: true });
		writeFileSync(join(home.path, paths.envelopeFile(id)), JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: id, received_at: isoTimestamp(), attempt: 1,
			envelope: { job_id: id, kind: "research", status: "done", summary: "Status board published.", artifact_path: join(source, "board.json") } }));
	};
	/** One parent start takes the settled envelope; returns its board receipt url. */
	const intake = async (id: string, env: Record<string, string> = {}) => {
		await board(id);
		const rpc = startRpc({ cwd: home.path, env: { ...agent.env, CP_HOME: home.path, PATH: `${bin}:${process.env.PATH ?? ""}`, ...env },
			args: ["--no-extensions", "-e", COMMAND_POST_EXTENSION, "--no-session"] });
		const job = () => readFleet(home.path).jobs.find((j) => j.job_id === id);
		try {
			await waitFor(() => job()?.reported_at, (stamped) => stamped !== undefined, { timeoutMs: 60_000, what: `${id} accepted` });
			return job()?.receipts?.find((r) => r.kind === "board")?.url;
		} finally { rpc.endInput(); await rpc.close(); }
	};
	const set = (changes: Record<string, unknown>, dry_run = false) => applySettings(home.path, { request: { mode: "set", changes }, dry_run,
		expected_revision: dry_run ? null : readSettings(home.path).revision, request_id: "board-url-1", peer: null, actor: "dashboard" });

	// (c) An explicit loopback host is trusted as configured: no tailnet, no public URL.
	assert.equal(await intake("cp-loopback", { CP_VIEWER_HOST: "127.0.0.1", CP_VIEWER_PORT: "9912" }), "http://127.0.0.1:9912/boards/cp-loopback/");

	// (b) viewer.public_url, set through the audited settings write, beats the host for intake and responseReportUrl alike.
	assert.equal(set({ "viewer.public_url": "https://dash.example.test/" }).state, "applied");
	assert.equal(await intake("cp-public", { CP_VIEWER_HOST: "127.0.0.1", CP_VIEWER_PORT: "9912" }), "https://dash.example.test/boards/cp-public/");
	assert.deepEqual(responseReportUrl(home.path, "cp-public", { viewerHost: "127.0.0.1" }), { url: "https://dash.example.test/boards/cp-public/" });
	assert.equal(set({ "viewer.public_url": "https://dash.example.test/apps/cp//" }).state, "applied");
	assert.equal(responseReportUrl(home.path, "cp-public").url, "https://dash.example.test/apps/cp/boards/cp-public/", "a path prefix is kept verbatim");

	// (d) A live tunnel origin still wins over public_url.
	const dataDir = join(home.path, LAYOUT.data), stateDir = join(home.path, LAYOUT.state);
	writeFileSync(tunnelConfigFile(dataDir), JSON.stringify({ schema_version: 1, enabled: true, mode: "quick", port: 40123, binary: "/opt/cf/cloudflared", revision: 2 }));
	writeFileSync(tunnelRuntimeFile(stateDir), JSON.stringify({ schema_version: 1, origin: "https://amber-otter.trycloudflare.com", generation: 3, revision: 2,
		state: "running", mode: "quick", port: 40123, updated_at: isoTimestamp() }));
	assert.equal(await intake("cp-tunnel"), "https://amber-otter.trycloudflare.com/boards/cp-tunnel/");
	assert.equal(responseReportUrl(home.path, "cp-tunnel").url, "https://amber-otter.trycloudflare.com/boards/cp-tunnel/");

	// (e) Userinfo, a query, a fragment, ftp: and a relative value are refused with a plain reason; nothing is written.
	for (const [value, reason] of [["https://user:pw@dash.example.test/", /no user name, password/], ["https://dash.example.test/?a=1", /query/],
		["https://dash.example.test/#top", /fragment/], ["ftp://dash.example.test/", /ftp: is not allowed/], ["/boards", /is not an absolute URL/]] as const) {
		const refused = set({ "viewer.public_url": value }, true);
		assert.equal(refused.status, 400, value);
		assert.match(refused.errors?.join("\n") ?? "", reason, value);
	}
	// Deleting it restores today's behaviour: the configured host again.
	writeFileSync(tunnelConfigFile(dataDir), JSON.stringify({ schema_version: 1, enabled: false, mode: "quick", port: 40123, binary: "/opt/cf/cloudflared", revision: 2 }));
	assert.equal(set({ "viewer.public_url": null }).state, "applied");
	assert.equal(responseReportUrl(home.path, "cp-public", { viewerHost: "127.0.0.2", viewerPort: 9911 }).url, "http://127.0.0.2:9911/boards/cp-public/");
});
