/**
 * Ask-guard unit no entry point can feed (P10b), moved verbatim from tests/ask-guard.test.ts: pi's
 * agent_before_settle always carries messages, so `undefined` is unreachable; the newest-message read is e2e.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { lastAssistantText } from "../src/ask-guard.ts";

test("lastAssistantText takes the newest assistant message, string or parts", () => {
	assert.equal(lastAssistantText([{ role: "assistant", content: "old" }, { role: "assistant", content: [{ type: "text", text: "new?" }, { type: "toolCall" }] }, { role: "user", content: "x" }]), "new?");
	assert.equal(lastAssistantText(undefined), "");
});
