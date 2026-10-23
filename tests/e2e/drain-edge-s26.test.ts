import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, startPiChild, waitFor } from "../harness/index.ts";
import { drainFile, readDrain } from "../../src/drain.ts";
import { DurableWakeupOutbox } from "../../src/wakeup-outbox.ts";

async function stack(t: TestContext) {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	const model = provider.addScript("edge", [{ kind: "text", text: "Acknowledged." }], { onExhausted: "repeat" });
	agent.writeModels(provider);
	const children: ReturnType<typeof startPiChild>[] = [];
	const start = () => {
		const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
		children.push(child);
		return child;
	};
	t.after(async () => { for (const child of children) await child.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	const command = async (child: ReturnType<typeof start>, text: string) => {
		const before = child.records().length;
		await child.prompt(text);
		return String((await child.waitFor((r) => child.records().indexOf(r) >= before && r.type === "extension_ui_request" && String(r.message).startsWith("DRAIN:"), 20_000)).message);
	};
	return { home: home.path, start, command };
}

test("S26: a second real session cannot clear, cancel or start the lock owner's drain", { timeout: 60_000 }, async (t) => {
	const s = await stack(t);
	const owner = s.start();
	assert.match(await s.command(owner, "/cp-drain 30"), /drained: safe to restart/);
	const saved = readFileSync(drainFile(s.home), "utf8");
	const other = s.start();
	assert.match(await s.command(other, "/cp-drain 0"), /does not hold the parent lock/);
	assert.match(await s.command(other, "/cp-drain cancel"), /does not hold the parent lock/);
	assert.equal(readFileSync(drainFile(s.home), "utf8"), saved);
	await owner.close();
	writeFileSync(drainFile(s.home), JSON.stringify({ state: "draining", started_at: "2026-09-27T12:00:00Z", deadline: "2099-01-01T00:00:00Z", timeout_s: 600, jobs: [] }));
	await other.prompt("/status");
	assert.equal(readDrain(s.home)?.state, "draining", "a read-only status render never decides another parent's drain");
});

test("S26: public drain commands round-trip auto-update and legacy causes and cancel a foreign completed drain", { timeout: 60_000 }, async (t) => {
	const s = await stack(t);
	const child = s.start();
	assert.match(await s.command(child, "/cp-drain status"), /no drain is running/);
	const base = { state: "draining", started_at: "2026-09-27T12:00:00Z", deadline: "2099-01-01T00:00:00Z", timeout_s: 600, jobs: [] };
	for (const cause of [{ reason: "auto-update", target_sha: "0123456789abcdef0123456789abcdef01234567" }, { reason: "manual" }, undefined, { reason: "bogus" }]) {
		writeFileSync(drainFile(s.home), JSON.stringify({ ...base, cause }));
		const text = await s.command(child, "/cp-drain status");
		if (cause?.reason === "auto-update") assert.match(text, /cause: auto-update to 0123456789ab in progress, drain timeout 2099-01-01T00:00:00Z; it restarts the parent by itself/);
		else if (cause?.reason === "manual") assert.match(text, /cause: manual \/cp-drain/);
		else assert.doesNotMatch(text, /cause:/);
	}
	writeFileSync(drainFile(s.home), JSON.stringify({ ...base, state: "drained", reported: true }));
	assert.match(await s.command(child, "/cp-drain cancel"), /cancelled.*\(drained\).*withdrawn/);
	assert.equal(existsSync(drainFile(s.home)), false);
	assert.match(await s.command(child, "/cp-drain cancel"), /no drain to cancel/);
	assert.match(await s.command(child, "/cp-drain 600 auto-update abcdef0123"), /drained: safe to restart/);
	assert.deepEqual(readDrain(s.home)?.cause, { reason: "auto-update", target_sha: "abcdef0123" });
	assert.equal(readDrain(s.home)?.timeout_s, 600);
});

test("S26: actual session delivery drops stale outcomes and preserves cancellation across replacement drains", { timeout: 90_000 }, async (t) => {
	const s = await stack(t);
	const child = s.start();
	await s.command(child, "/cp-drain status");
	const outbox = new DurableWakeupOutbox({ home: s.home });
	const A = "2026-09-27T12:00:00.000Z";
	const B = "2026-09-27T13:00:00.000Z";
	const live = (started_at: string, state: string) => writeFileSync(drainFile(s.home), JSON.stringify({ state, started_at, deadline: "2099-01-01T00:00:00Z", timeout_s: 600, jobs: [], reported: true }));
	const enqueue = (id: string) => outbox.enqueue({ id, kind: "recovery", content: `DRAIN: ${id}` });
	const delivered = async (id: string) => {
		await child.waitFor((r) => r.type === "message_start" && JSON.stringify(r).includes(id), 15_000);
		assert.equal(child.records().filter((r) => r.type === "message_start" && JSON.stringify(r).includes(id)).length, 1);
	};
	live(A, "timeout");
	enqueue(`drain:${A}:timeout`);
	await delivered(`drain:${A}:timeout`);
	for (const [index, file] of [undefined, { started: A, state: "timeout" }, { started: B, state: "timeout" }].entries()) {
		const id = `drain:2026-09-27T14:00:0${index}.000Z:drained`;
		if (file) live(index === 2 ? "2026-09-27T14:00:02.000Z" : file.started, file.state); else {
			const { rmSync } = await import("node:fs");
			rmSync(drainFile(s.home));
		}
		enqueue(id);
		await waitFor(() => outbox.read().discarded?.some((item) => item.id === id), Boolean, { timeoutMs: 15_000, what: "stale outcome is discarded" });
		assert.equal(child.records().filter((r) => r.type === "message_start" && JSON.stringify(r).includes(id)).length, 0);
	}
	live(B, "timeout");
	enqueue(`drain:${A}:cancelled`);
	await delivered(`drain:${A}:cancelled`);
});
