import assert from "node:assert/strict";
import { test } from "node:test";
import { parentDiagnostic } from "../src/parent-diagnostics.ts";
import type { WorkerProcess } from "../src/worker-process.ts";

test("cp_parent drain path: parentDiagnostic sends /cp-drain <seconds> and returns the parent's immediate answer", async () => {
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	const prompts: string[] = [];
	const proc = {
		onEvent: (listener: (event: Record<string, unknown>) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
		request: async (type: string, payload: { message?: string }) => {
			if (type === "get_commands") return { success: true, data: { commands: [{ name: "cp-drain", source: "extension" }] } };
			prompts.push(payload.message ?? "");
			for (const listener of listeners) listener({ type: "extension_ui_request", method: "notify", notifyType: "info", message: "DRAIN: draining since 2026-09-27T12:00:00Z: waiting" });
			return { success: true };
		},
	} as unknown as WorkerProcess;
	const result = await parentDiagnostic(proc, "drain", 5_000, "30");
	assert.deepEqual(prompts, ["/cp-drain 30"]);
	assert.match(result.text, /^DRAIN: draining since/);
	assert.equal(result.level, "info");
	assert.equal(listeners.size, 0, "the listener is released");
	await parentDiagnostic(proc, "drain", 5_000, "cancel"); // CpBridge.drainCancel, the host's drainCancel op
	assert.deepEqual(prompts, ["/cp-drain 30", "/cp-drain cancel"]);
});

test("cp_parent version path: parentDiagnostic accepts the new picp line and the pre-rename pi-command-post line", async () => {
	for (const message of ["picp 0.1.0 (root: /app)", "pi-command-post 0.1.0 (root: /app)"]) {
		const listeners = new Set<(event: Record<string, unknown>) => void>();
		const proc = {
			onEvent: (listener: (event: Record<string, unknown>) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
			request: async (type: string) => {
				if (type === "get_commands") return { success: true, data: { commands: [{ name: "cp-version", source: "extension" }] } };
				for (const listener of listeners) listener({ type: "extension_ui_request", method: "notify", notifyType: "info", message });
				return { success: true };
			},
		} as unknown as WorkerProcess;
		const result = await parentDiagnostic(proc, "version", 5_000);
		assert.equal(result.text, message);
	}
});
