import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { policyBlockedRefusal, sessionPolicyBlocked, WORKER_COMPACTION_POLICY_BLOCK, WorkerSessionScanError } from "../src/worker-session-policy.ts";
import { createScratchHome } from "./harness/index.ts";

const MARKER = { type: "custom", customType: WORKER_COMPACTION_POLICY_BLOCK, data: { errorMessage: "content_filter" } };
const jsonl = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";

function scratch(t: { after(fn: () => void): void }) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const file = (name: string, text?: string) => {
		const path = join(home.path, name);
		if (text !== undefined) writeFileSync(path, text);
		return path;
	};
	return file;
}

test("only a structural custom entry marks the session; prose naming the marker does not", async (t) => {
	const file = scratch(t);
	const user = { type: "message", message: { role: "user", content: [{ type: "text", text: `customType ${WORKER_COMPACTION_POLICY_BLOCK}` }] } };
	assert.equal(await sessionPolicyBlocked(file("marked.jsonl", jsonl(user, MARKER))), true);
	assert.equal(await sessionPolicyBlocked(file("prose.jsonl", jsonl(user, { type: "custom_message", customType: "other", content: JSON.stringify(MARKER) }))), false);
	assert.equal(await sessionPolicyBlocked(file("message-typed.jsonl", jsonl({ type: "message", customType: WORKER_COMPACTION_POLICY_BLOCK }))), false);
	assert.equal(await sessionPolicyBlocked(file("blank.jsonl", `\n${jsonl(user)}\n  \n`)), false, "blank lines are ignored");
	assert.equal(await sessionPolicyBlocked(file("empty.jsonl", "")), false);
});

test("malformed or unreadable sessions are a named scan error, never healthy", async (t) => {
	const file = scratch(t);
	const broken = file("broken.jsonl", `${jsonl({ type: "session" })}{"type":"cust\n${jsonl(MARKER)}`);
	await assert.rejects(sessionPolicyBlocked(broken), (error: unknown) => {
		assert.ok(error instanceof WorkerSessionScanError);
		assert.ok(error.message.includes(broken) && /line 2 is not valid JSON/.test(error.message), error.message);
		return true;
	});
	const missing = file("missing.jsonl");
	await assert.rejects(sessionPolicyBlocked(missing), (error: unknown) => error instanceof WorkerSessionScanError && error.message.includes(missing) && /ENOENT/.test(error.message));
	const dir = file("a-dir");
	mkdirSync(dir);
	await assert.rejects(sessionPolicyBlocked(dir), (error: unknown) => error instanceof WorkerSessionScanError && error.message.includes(dir));
	assert.match(policyBlockedRefusal("cp-x", "/s.jsonl"), /cp-x's session \/s\.jsonl carries a worker-compaction-policy-block entry.*keep the lease/);
});

test("an early match closes the file", { skip: process.platform !== "linux" && "needs /proc/self/fd" }, async (t) => {
	const file = scratch(t);
	// The marker first, then enough data that an unclosed stream would still hold its fd.
	const marked = file("long.jsonl", jsonl(MARKER, ...Array.from({ length: 5000 }, (_, n) => ({ type: "message", n, pad: "x".repeat(64) }))));
	const fds = () => readdirSync("/proc/self/fd").length;
	const before = fds();
	for (let n = 0; n < 20; n += 1) assert.equal(await sessionPolicyBlocked(marked), true);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.ok(fds() - before < 5, `open fds grew by ${fds() - before}`);
});
