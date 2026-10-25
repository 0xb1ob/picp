/** Ask-guard units no entry point can feed (P10b), moved verbatim from tests/ask-guard.test.ts; the rest is e2e. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AskGuard, lastAssistantText } from "../src/ask-guard.ts";
import { OperatorAsks } from "../src/operator-asks.ts";

function fixture(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "ask-guard-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const store = new OperatorAsks(join(dir, "asks.jsonl"));
	return { store, asks: () => store, guard: new AskGuard() };
}

const askOk = { toolName: "cp_parent", isError: false, result: { details: { id: "ask-0a1b2c", state: "open", question: "A or B?" } } };

test("lastAssistantText takes the newest assistant message, string or parts", () => {
	assert.equal(lastAssistantText([{ role: "assistant", content: "old" }, { role: "assistant", content: [{ type: "text", text: "new?" }, { type: "toolCall" }] }, { role: "user", content: "x" }]), "new?");
	assert.equal(lastAssistantText(undefined), "");
});

test("a failed ask, or an ask_answer result carrying only an id, does not count as an ask", (t) => {
	const { guard, asks } = fixture(t);
	guard.runEnded();
	guard.toolEnded({ ...askOk, isError: true });
	guard.toolEnded({ toolName: "cp_parent", isError: false, result: { details: { id: "ask-0a1b2c" } } });
	guard.toolEnded({ toolName: "bash", isError: false, result: { details: { id: "ask-0a1b2c", state: "open" } } });
	assert.equal(guard.beforeSettle("Should I proceed?", asks)?.continue, true);
});
