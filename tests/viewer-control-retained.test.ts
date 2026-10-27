/**
 * Retained (P17b): units no e2e surface reaches: readControl's delta fallback, the client's dead-home and status lines,
 * herdrCommand's words, restart helper states, a tailnet bind's own origin (the harness binds 127.0.0.1).
 * The rest: tests/e2e/viewer-control.test.ts.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { type AddressInfo, createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import type { ControlStatusResponse } from "../src/viewer/api-types.ts";
import { herdrCommand } from "../src/viewer/launchers.ts";
import { viewerConfigFile } from "../src/viewer/host-config.ts";
import { pushConfigFile, pushDataDir } from "../src/viewer/push-files.ts";
import { createViewer } from "../src/viewer/server.ts";
import { controlLine, deliveryLine, readControl, sendControl, startOperator } from "../viewer-app/control.ts";
import { restartDisabled, restartOperator } from "../viewer-app/restart-control.ts";
import { deliverySummary } from "../viewer-app/use-device-notices.ts";
import { send, write } from "./harness/conversations.ts";
import { createScratchHome } from "./harness/index.ts";

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

test("client: sendControl's unreachable home, controlLine's 403 and deliveryLine's lines", async () => {
	assert.deepEqual(await sendControl(async () => { throw new Error("offline"); }, "tok", { kind: "abort" }), { error: "Could not reach this home", status: 0 });
	assert.deepEqual(await startOperator(async () => { throw new Error("x"); }, "tok", "herdr"), { error: "Could not reach this home" });
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

test("restart and notice helpers: an older viewer's status, control off (restartShown needs a running session), an unreachable home and an empty push list", async () => {
	assert.match(restartDisabled(status({ restart: undefined })) ?? "", /did not report whether the session can restart/, "an older viewer's status: disabled, never guessed");
	assert.equal(restartDisabled(status({ enabled: false })), "no operator session is running");
	assert.deepEqual(await restartOperator(async () => { throw new Error("down"); }, "tok"), { error: "Could not reach this home", status: 0 });
	assert.equal(deliverySummary([], null), "push: no recipients");
});

test("no HTTPS origin configured: a tailnet bind's own http:// origin holds a message and a click; others are refused; a configured origin keeps its old rule", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const probe = createServer().listen(0, "127.0.0.1");
	await once(probe, "listening");
	const port = (probe.address() as AddressInfo).port, host = `100.64.0.9:${port}`;
	await new Promise((done) => probe.close(done));
	const options = { home: home.path, stateDir: join(home.path, LAYOUT.state), host: "100.64.0.9", port, requireTailnet: true, log: () => {}, operatorStart: { tmux: null, herdr: null } };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
	t.after(() => server.close());
	const inbox = String((await send(port, "/api/operator/control", { headers: { host } })).body.inbox_token);
	const at = (origin: string, body: unknown) => send(port, "/api/operator/message", { method: "POST", body: JSON.stringify(body), headers: { host, origin, "content-type": "application/json", "x-cp-control-token": inbox } });
	assert.equal((await at(`http://${host}`, { kind: "message", text: "over http" })).status, 202);
	assert.equal((await at(`http://${host}`, { kind: "answer", ask_id: "ask-abcd", label: "Keep" })).status, 202, "and a click");
	for (const foreign of ["https://evil.example", `http://100.64.0.9:${port + 1}`, `http://127.0.0.1:${port}`]) {
		assert.match(String((await at(foreign, { kind: "message", text: "x" })).body.error), /^Origin must be http:\/\/100\.64\.0\.9:\d+ \(no HTTPS/, foreign);
	}
	write(pushConfigFile(pushDataDir(options.stateDir)), { origin: "https://cp.example.ts.net", subject: "mailto:op@example.com", public_key: Buffer.alloc(65, 4).toString("base64url"), created_at: "2026-09-27T08:00:00Z" });
	write(viewerConfigFile(options.stateDir), { strict_host: true });
	assert.match(String((await at(`http://${host}`, { kind: "message", text: "x" })).body.error), /^Origin must be https:\/\/cp\.example\.ts\.net$/, "configured: the old rule");
});
