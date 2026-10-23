import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, createScratchLedger, MockProvider, startPiChild, waitFor } from "../harness/index.ts";

for (const [kind, variant, title] of [
	["queue", "stale", "S28: queue startup drops stale requests"],
	["queue", "scheduler-fault", "S28: scheduler ledger fault still drains queue requests"],
	["armed", "scheduler-fault", "S28: scheduler ledger fault still releases armed requests"],
	["queue", "corrupt", "S28: queue startup preserves corrupt requests"],
	["queue", "foreign-owner", "S28: queue startup respects a foreign owner"],
	["armed", "stale", "S28: armed startup drops stale requests and keeps blocked ones"],
	["armed", "corrupt", "S28: armed startup preserves corrupt requests"],
	["armed", "foreign-owner", "S28: armed startup respects a foreign owner"],
] as const) {
		test(title, { timeout: 120_000 }, async (t) => {
			const home = createScratchHome();
			const scratch = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
			const closed = await scratch.ledger.create({ title: "closed", project: "demo", kind: "ship", delivery: "local" });
			await scratch.ledger.close(closed.id, "dropped: superseded");
			const open = await scratch.ledger.create({ title: "preflight refusal", project: "demo", kind: "ship", delivery: "local" });
			const blocked = await scratch.ledger.create({ title: "waiting", project: "demo", kind: "ship", delivery: "local" });
			await scratch.ledger.addDep(blocked.id, closed.id);
			const ids = [closed.id, "cp-missing", open.id, ...(kind === "armed" ? [blocked.id] : [])];
			const file = join(home.path, kind === "queue" ? LAYOUT.dispatchQueueFile : LAYOUT.armedDispatchFile);
			const at = "2026-10-04T15:00:00Z";
			const entries = ids.map((id) => ({ job_id: id, request: { task: "retained task" }, ...(kind === "queue" ? { queued_at: at, attempts: 0 } : { armed_at: at, blockers: [closed.id] }) }));
			mkdirSync(dirname(file), { recursive: true });
			const before = variant === "corrupt" ? "{ not json" : JSON.stringify({ schema_version: 1, entries });
			writeFileSync(file, before);
			if (variant === "foreign-owner") writeFileSync(join(home.path, LAYOUT.parentLock), JSON.stringify({ schema_version: 1, pid: process.pid, started_at: at, home: home.path }));
			if (variant === "scheduler-fault") writeFileSync(join(home.path, LAYOUT.jobsFile), "{ corrupt ledger");
			const provider = await MockProvider.start();
			const model = provider.addScript(`startup-${kind}-${variant}`, [
				...(variant === "corrupt" ? [{ kind: "tool_calls" as const, calls: [{ name: "cp_dispatch", args: { job_id: blocked.id, task: "do not overwrite corrupt state" } }] }] : []),
				{ kind: "text", text: "checked" },
			]);
			const agent = createAgentDir({ provider });
			const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
			t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); scratch.cleanup(); home.cleanup(); });
			await child.prompt("inspect startup");
			await child.waitForSettled(60_000);
			if (variant === "foreign-owner") {
				assert.equal(JSON.parse(readFileSync(join(home.path, LAYOUT.parentLock), "utf8")).pid, process.pid);
				assert.equal(readFileSync(file, "utf8"), before, "foreign owner cannot drain");
				return;
			}
			const wakes = await waitFor(() => {
				try { return readFileSync(join(home.path, LAYOUT.wakeupsFile), "utf8"); } catch { return ""; }
			}, (text) => text.includes(variant === "corrupt" ? "failed:" : open.id), { timeoutMs: 15_000, what: `${kind} startup wake` });
			if (variant === "corrupt") {
				assert.match(wakes, /refusing to read an unparseable/);
				assert.equal(readFileSync(file, "utf8"), before, "corrupt state is never overwritten");
				const end = child.eventsOfType("tool_execution_end").find((event) => event.toolName === "cp_dispatch") as { isError?: boolean; result?: unknown };
				assert.equal(end.isError, true);
				assert.match(JSON.stringify(end.result), /unparseable/);
			} else {
				for (const id of ids.slice(0, variant === "scheduler-fault" ? ids.length : 3)) assert.ok(wakes.includes(`dropped:${id}:`), `terminal outcome for ${id}`);
				const after = JSON.parse(readFileSync(file, "utf8"));
				assert.deepEqual(after.entries.map((entry: { job_id: string }) => entry.job_id), kind === "armed" && variant !== "scheduler-fault" ? [blocked.id] : []);
				assert.equal((wakes.match(/:dropped:/g) ?? []).length, variant === "scheduler-fault" ? ids.length : 3, "one terminal wake per request");
			}
		});
}
