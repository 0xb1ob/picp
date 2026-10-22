/** A job-less CI watch error (unreadable fleet.json) keeps its own cause: two causes, two durable notices. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, startPiChild, waitFor } from "../harness/index.ts";

test("rpc: two distinct job-less CI watch errors each reach the parent as their own notice", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("jobless", [{ kind: "text", text: "acknowledged" }], { onExhausted: "repeat" });
	const agentDir = createAgentDir({ provider });
	const child = startPiChild({
		cwd: home.path,
		model,
		env: { ...agentDir.env, CP_HOME: home.path, CP_CI_WATCH_SECONDS: "1" },
		extensions: [COMMAND_POST_EXTENSION],
	});
	t.after(async () => {
		await child.close();
		agentDir.cleanup();
		await provider.stop();
		home.cleanup();
	});
	const fleet = join(home.path, LAYOUT.state, "fleet.json");
	mkdirSync(join(home.path, LAYOUT.state), { recursive: true });
	const seen = (cause: string) => () => new RegExp(`TICK FAILED — [^\\\\]*${cause}`).test(JSON.stringify(provider.requests("jobless").map((r) => r.body.messages)));
	writeFileSync(fleet, "{ not json");
	await waitFor(seen("is not valid JSON"), (found) => found, { timeoutMs: 60_000, what: "the unparsable-fleet notice" });
	writeFileSync(fleet, JSON.stringify({ schema_version: 9999, jobs: [] }));
	await waitFor(seen("is schema_version 9999"), (found) => found, { timeoutMs: 60_000, what: "the newer-schema notice" });
});
