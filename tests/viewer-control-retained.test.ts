/**
 * Retained (P17b): dashboard-control client units no e2e surface reaches: readControl's delta fallback, the client's
 * stale-token, unreachable-home and status lines, herdrCommand's `--session <id>` words and the restart helpers'
 * older-viewer and control-off lines. The rest: tests/e2e/viewer-control.test.ts.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import type { ControlStatusResponse } from "../src/viewer/api-types.ts";
import { herdrCommand } from "../src/viewer/launchers.ts";
import { controlLine, deliveryLine, readControl, sendControl } from "../viewer-app/control.ts";
import { restartDisabled, restartOperator } from "../viewer-app/restart-control.ts";
import { deliverySummary } from "../viewer-app/use-device-notices.ts";

const status = (over: Partial<ControlStatusResponse>): ControlStatusResponse => ({ generated_at: "2026-09-27T08:30:00Z", enabled: true, running: true, reason: null, token: "t".repeat(64), busy: false, pending: false, session_file: "op.jsonl", recent: [], offline: false, held: 0, inbox_token: null, start_unavailable: null, launchers: { tmux: true, herdr: false }, resume: { tmux: false, herdr: false }, restart: { supported: true, blockers: [], reason: null }, ...over });

// readControl holds one version per URL; a delta for another base refetches in full once, a refusal drops the base.
test("readControl sends x-cp-delta-base per URL, applies the delta, and falls back to a full read", async () => {
	const lean = "/api/operator/control?sends=0", full = "/api/operator/control";
	const reply = (body: unknown, headers: Record<string, string> = {}, code = 200) => new Response(JSON.stringify(body), { status: code, headers });
	const replies = [
		reply(status({}), { "x-cp-version": "n-1" }),
		reply(status({}), { "x-cp-version": "m-1" }),
		reply({ set: { busy: true } }, { "x-cp-version": "n-2", "x-cp-delta-base": "n-1" }),
		reply({ set: { busy: false } }, { "x-cp-version": "n-3", "x-cp-delta-base": "n-0" }),
		reply(status({ held: 3 }), { "x-cp-version": "n-4" }),
		reply({}, {}, 401),
		reply(status({})),
	];
	const seen: Array<[string, string | undefined]> = [];
	const fetcher = (url: string, init?: RequestInit) => (seen.push([url, (init?.headers as Record<string, string> | undefined)?.["x-cp-delta-base"]]), Promise.resolve(replies.shift()!));
	await readControl(fetcher, undefined, false);
	await readControl(fetcher);
	assert.deepEqual(await readControl(fetcher, undefined, false), status({ busy: true }));
	assert.deepEqual(await readControl(fetcher, undefined, false), status({ held: 3 }), "a mismatched base is refetched in full");
	assert.deepEqual(await readControl(fetcher, undefined, false), { error: "HTTP 401" });
	await readControl(fetcher, undefined, false);
	assert.deepEqual(seen, [[lean, undefined], [full, undefined], [lean, "n-1"], [lean, "n-2"], [lean, undefined], [lean, "n-4"], [lean, undefined]]);
});

test("client: sendControl's stale token and unreachable home, controlLine's 403 and deliveryLine", async () => {
	const reply = (code: number, body: unknown) => async () => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
	assert.deepEqual(await sendControl(reply(403, { error: "stale" }), "tok", { kind: "abort" }), { error: "stale", status: 403 });
	assert.deepEqual(await sendControl(async () => { throw new Error("offline"); }, "tok", { kind: "abort" }), { error: "Could not reach this home", status: 0 });
	assert.equal(controlLine(null), "Checking dashboard control");
	assert.equal(controlLine({ error: "HTTP 403" }), "Not available: HTTP 403");
	assert.equal(deliveryLine({ id: "dc-1", state: "queued", reason: null, ask_id: null }), "Queued · dc-1");
	assert.equal(deliveryLine({ id: "dc-1", state: "delivered", reason: null, ask_id: null }), "Delivered to the session · dc-1");
	assert.equal(deliveryLine({ id: null, state: "failed", reason: "boom", ask_id: null }), "Failed: boom");
});

test("herdr launch args: the pane command is one argv element herdr cannot parse flags from; the pane's shell splits it back into the exact words (--session <id> included)", () => {
	const words = ["/home/u/my home/.local/bin/cp-operator", "--session", "0198-ab'cd", "$(touch /tmp/x)"];
	const command = herdrCommand(words);
	assert.ok(!command.startsWith("-"), "never an option to herdr's own parser");
	const split = execFileSync("/bin/sh", ["-c", `for w in ${command}; do printf '%s\\n' "$w"; done`], { encoding: "utf8" });
	assert.deepEqual(split.trimEnd().split("\n"), words, "the shell gets every word verbatim, nothing expanded");
});

test("restart and notice helpers: an older viewer's status, control off, an unreachable home and a delivered push", async () => {
	assert.match(restartDisabled(status({ restart: undefined })) ?? "", /did not report whether the session can restart/, "an older viewer's status: disabled, never guessed");
	assert.equal(restartDisabled(status({ enabled: false })), "no operator session is running");
	assert.deepEqual(await restartOperator(async () => { throw new Error("down"); }, "tok"), { error: "Could not reach this home", status: 0 });
	const at = "2026-09-27T09:00:00.000Z";
	const recipients = [{ device_id: "dev-aaaaaaaaaaaaaaaa", name: "Laptop", state: "delivered" as const, attempts: 1, updated_at: at, last_error: null }, { device_id: "dev-0123456789abcdef", name: "Phone", state: "unsubscribed" as const, attempts: 0, updated_at: at, last_error: "no push subscription on this device" }];
	assert.equal(deliverySummary(recipients, null), "push: 1 delivered to push service · 1 not subscribed");
	assert.equal(deliverySummary([], null), "push: no recipients");
});
