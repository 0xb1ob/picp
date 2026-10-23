import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerWorkerCompactionGuard } from "../extensions/worker-reporter/compaction.ts";

const POLICY_ERROR = "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.";
function guardFixture() {
	const manager = SessionManager.inMemory();
	const ctx = { sessionManager: manager } as unknown as ExtensionContext;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	registerWorkerCompactionGuard({
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		appendEntry: (customType: string, data: unknown) => manager.appendCustomEntry(customType, data),
	} as unknown as ExtensionAPI);
	return {
		manager,
		before: (reason = "threshold") => handlers.get("session_before_compact")!({ branchEntries: manager.getBranch(), reason }, ctx),
		failed: (errorMessage?: string, aborted = false) => handlers.get("session_compact_failed")!({ errorMessage, aborted, reason: "threshold", willRetry: false, fromExtension: false }, ctx),
	};
}

test("other failures and aborted compactions retain pi's retry behavior", () => {
	const f = guardFixture();
	for (const error of [undefined, "503 service unavailable", "429 rate limit", "400 invalid tool order", "Summarization failed: generation hit the token cap", "connection terminated", "Request rejected by rate limit policy", "Request blocked by retry policy"]) {
		f.failed(error);
		assert.equal(f.before(), undefined, error);
	}
	f.failed(POLICY_ERROR, true);
	assert.equal(f.before(), undefined, "an abort is not a policy failure");
	assert.equal(f.manager.getBranch().length, 0, "no new session errors for other failures");
	for (const error of ["Summarization failed: content_filter", "400 content_policy_violation", "Request rejected due to usage policies", "Request blocked by safety policy"]) {
		f.manager.newSession();
		f.failed(error);
		assert.deepEqual(f.before(), { cancel: true }, error);
	}
});
