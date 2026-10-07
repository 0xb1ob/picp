import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadProfile } from "../src/profiles.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { activePackagesForRole, resolveWorkerPackages } from "../src/worker-packages.ts";
import type { WorkerEvent } from "../src/worker-process.ts";
import { createAgentDir, MockProvider, WORKER_REPORTER_EXTENSION } from "./harness/index.ts";

// Report the installed boundary, rather than pretending optional packages are pinned here.
function packageVersion(extension: string): string {
	for (let dir = dirname(extension); ; dir = dirname(dir)) {
		const file = join(dir, "package.json");
		if (existsSync(file)) {
			const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
			if (pkg.name && pkg.version) return `${pkg.name} ${pkg.version}`;
		}
		if (dirname(dir) === dir) return `version unknown: ${extension}`;
	}
}

for (const mode of ["manual", "threshold"] as const) {
	for (const changed of [false, true]) {
		test(`${mode} compaction: original anchor ${changed ? "rejects a changed target line" : "edits an unchanged file"}`, { timeout: 300_000 }, async (t) => {
			// Resolve the real host's configured packages BEFORE isolating the child.
			const detected = await resolveWorkerPackages(getAgentDir());
			if (!detected["pi-hashline-edit-pro"]?.extensions.length) {
				assert.notEqual(process.env.CP_REQUIRE_HASHLINE_TESTS, "1", "required pi-hashline-edit-pro is not installed/configured");
				t.skip("pi-hashline-edit-pro is not installed/configured in this home");
				return;
			}
			const active = activePackagesForRole(detected, "implementer");
			t.diagnostic(`pi ${spawnSync("pi", ["--version"], { encoding: "utf8" }).stdout.trim()}; ${active.extensions.map(packageVersion).join("; ")}`);

			const provider = await MockProvider.start();
			let agent: ReturnType<typeof createAgentDir> | undefined;
			let manager: WorkerManager | undefined;
			t.after(async () => {
				try { await manager?.shutdownAll(); }
				finally { agent?.cleanup(); await provider.stop(); }
			});
			let anchor = "";
			const name = `hashline-${mode}-${changed ? "changed" : "unchanged"}`;
			const replacement = 'export const value = "after";';
			const model = provider.addScript(name, [
				{ kind: "tool_calls", calls: [{ name: "read", args: { path: "target.ts" } }] },
				{ kind: "text", text: "Read complete", ...(mode === "threshold" ? { usage: { prompt_tokens: 199000, completion_tokens: 1 } } : {}) },
				{ kind: "text", text: "Summary of the completed read." },
				{ kind: "tool_calls", calls: [{ name: "replace", args: () => ({ remove_from: anchor, remove_to: anchor, text: replacement }) }] },
				{ kind: "text", text: "Finished" },
			]);
			agent = createAgentDir({ provider, settings: { compaction: { enabled: mode === "threshold", keepRecentTokens: 1, reserveTokens: 16384 } } });
			chmodSync(agent.path, 0o700);
			const target = join(agent.path, "target.ts");
			const sessionFile = join(agent.path, "session.jsonl");
			writeFileSync(target, 'export const value = "before";\n');
			manager = new WorkerManager({ home: agent.path, workerReporterPath: WORKER_REPORTER_EXTENSION, optionalPackages: detected });
			await manager.ready();
			const { worker, plan } = manager.spawn({
				identity: { jobId: name, kind: "ship", delivery: "local", runDir: agent.path, worktree: agent.path },
				profile: loadProfile(join(import.meta.dirname, "../profiles"), "implementer"), model, sessionFile,
				parentEnv: { ...process.env, ...agent.env },
				extraEnv: { PI_HASHLINE_DIR: join(agent.path, "hashline"), PI_LENS_HOME: join(agent.path, "lens"), XDG_CONFIG_HOME: join(agent.path, "config") },
				extraArgs: ["--no-context-files"],
			});
			const extensions = plan.args.flatMap((arg, index) => arg === "-e" ? [plan.args[index + 1]] : []);
			assert.deepEqual(extensions, [WORKER_REPORTER_EXTENSION, ...active.extensions], "production implementer extension order");
			const events: WorkerEvent[] = [];
			worker.onEvent((event) => {
				events.push(event);
				if (event.type === "tool_execution_end" && event.toolName === "read") {
					anchor = /([A-Za-z]{4})│export const value/.exec(JSON.stringify(event.result))?.[1] ?? "";
				}
			});
			await worker.getState(90_000);
			// Waiters only see future events: register before each prompt.
			const firstSettled = worker.waitForSettled(120_000);
			await worker.prompt("Read target.ts and stop.");
			await firstSettled;
			assert.match(anchor, /^[A-Za-z]{4}$/, "anchor must come from the original real read output");
			if (mode === "manual") {
				const compact = await worker.request("compact", {}, 120_000);
				assert.equal(compact.success, true, JSON.stringify(compact));
			} else {
				const compact = events.find((event) => event.type === "compaction_end" && event.reason === "threshold");
				assert.ok(compact?.result, `real threshold compaction must complete: ${JSON.stringify(events.filter((event) => event.type.includes("compaction")))}`);
				assert.equal(compact.aborted, false);
			}
			assert.ok(existsSync(sessionFile), "use a persisted session, not --no-session");
			const entries = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string });
			assert.equal(entries.filter((entry) => entry.type === "compaction").length, 1, "one real compaction persisted");
			const originalAnchor = anchor;
			const external = 'export const value = "external";\n';
			if (changed) writeFileSync(target, external);
			const nextSettled = worker.waitForSettled(120_000);
			await worker.prompt("Replace the previously read line using its original anchor, without reading again.");
			await nextSettled;
			const reads = events.filter((event) => event.type === "tool_execution_end" && event.toolName === "read");
			assert.equal(reads.length, 1, "no post-compaction read or anchor substitution");
			assert.equal(anchor, originalAnchor);
			const calls = events.filter((event) => event.type === "tool_execution_start" && event.toolName === "replace");
			assert.equal(calls.length, 1, "no retry");
			assert.deepEqual(calls[0]?.args, { remove_from: originalAnchor, remove_to: originalAnchor, text: replacement });
			const result = events.find((event) => event.type === "tool_execution_end" && event.toolName === "replace");
			assert.ok(result, "replace must execute");
			assert.equal(result.isError, changed, JSON.stringify(result));
			if (changed) assert.match(JSON.stringify(result.result), /E_STALE_ANCHOR/);
			assert.equal(readFileSync(target, "utf8"), changed ? external : `${replacement}\n`);
			assert.equal(provider.remaining(name), 0, "all scripted steps consumed");
		});
	}
}
