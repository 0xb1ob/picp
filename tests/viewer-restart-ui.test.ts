/** Restart session (cp-aqxl), the page: the control's states (SSR via preact-render-to-string), its client, and its 390 px CSS. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import type { ControlStatusResponse } from "../src/viewer/api-types.ts";
import type { ControlView } from "../viewer-app/control.ts";
import { type Restarting, restartDisabled, restartInFlight, restartLine, restartOperator } from "../viewer-app/restart-control.ts";
import { REPO_ROOT } from "./harness/index.ts";

const status = (over: Partial<ControlStatusResponse>): ControlStatusResponse => ({ generated_at: "2026-01-01T08:30:00Z", enabled: true, running: true, reason: null, token: "t".repeat(64), busy: false, pending: false, session_file: "2026-01-01T00-00-00-000Z_0123abcd.jsonl", recent: [], offline: false, held: 0, inbox_token: null, start_unavailable: null, launchers: { tmux: true, herdr: false }, resume: { tmux: false, herdr: false }, restart: { supported: true, blockers: [], reason: null }, session_started_at: "2026-01-01T08:00:00.000Z", ...over });
const restarting = (state: Restarting["state"], reason: string | null = null): Restarting => ({ state, reason, started_at: "2026-01-01T08:00:00.000Z", session_file: "2026-01-01T00-00-00-000Z_0123abcd.jsonl" });
const view = (s: ControlStatusResponse, r: Restarting | null = null): ControlView => ({ status: s, delivery: null, send: () => {}, restarting: r, restart: () => {} });

async function renderer() {
	const built = await build({ stdin: { contents: 'import {h} from "preact"; import render from "preact-render-to-string"; import {RestartSession} from "./viewer-app/components/RestartSession.tsx"; export const draw=(control)=>render(h(RestartSession,{control}));', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact" });
	return (await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`) as { draw: (control: ControlView) => string }).draw;
}

test("RestartSession: enabled when supported and clear; disabled with the blocker or the manual way; hidden offline; busy and failed states speak", async () => {
	const draw = await renderer();
	const ready = draw(view(status({})));
	assert.match(ready, /<button type="button" class="operator-restart-button">Restart session<\/button>/, "one tap opens the confirm; nothing is sent yet");
	assert.match(ready, /Restart stops this session and resumes the same session file in its terminal/);

	const busy = draw(view(status({ restart: { supported: true, blockers: ["the session is busy with a turn"], reason: "not now: the session is busy with a turn" } })));
	assert.match(busy, /<button type="button" class="operator-restart-button" disabled title="not now: the session is busy with a turn">Restart session<\/button>/);

	const manual = draw(view(status({ restart: { supported: false, blockers: [], reason: "this session was not started by a cp-operator that relaunches it; restart it once by hand: /quit, then cp-operator -c" } })));
	assert.match(manual, /disabled/);
	assert.match(manual, /\/quit, then cp-operator -c/);
	assert.match(draw(view(status({ restart: undefined }))), /did not report whether the session can restart/, "an older viewer's status: disabled, never guessed");

	assert.equal(draw(view(status({ running: false, token: null }))), "", "offline and not restarting: Start/Resume own the space");
	const relaunching = draw(view(status({ running: false, token: null }), restarting("relaunching")));
	assert.match(relaunching, /<button type="button" class="operator-restart-button" disabled>Restarting…<\/button>/);
	assert.match(relaunching, /Relaunching · resumes 2026-01-01T00-00-00-000Z_0123abcd\.jsonl/);
	const failed = draw(view(status({ running: false, token: null }), restarting("failed", "the session has not come back within 90 s")));
	assert.match(failed, /<p class="operator-restart-line operator-restart-failed" role="alert">Failed: the session has not come back within 90 s<\/p>/);
	assert.doesNotMatch(ready + failed, /start-session/, "its own classes: the composer's no-Start-while-running check stays meaningful");
});

test("restart client: posts exactly {restart:true} with the CSRF token; 202 is restarting, a refusal keeps its status; in-flight states hold the composer", async () => {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const reply = (code: number, body: unknown) => async (url: string, init?: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status: code }); };
	assert.deepEqual(await restartOperator(reply(202, { state: "restarting", id: "dc-20260101000000-0123abcd", session_file: "x.jsonl" }), "tok"), { state: "restarting", id: "dc-20260101000000-0123abcd", session_file: "x.jsonl" });
	assert.equal(calls[0]!.url, "/api/operator/restart");
	assert.equal(calls[0]!.init?.body, '{"restart":true}');
	assert.equal((calls[0]!.init?.headers as Record<string, string>)["x-cp-control-token"], "tok");
	assert.deepEqual(await restartOperator(reply(409, { state: "refused", error: "not now: x" }), "tok"), { error: "not now: x", status: 409 });
	assert.deepEqual(await restartOperator(async () => { throw new Error("down"); }, "tok"), { error: "Could not reach this home", status: 0 });

	assert.equal(restartDisabled(status({})), null);
	assert.equal(restartDisabled(status({ enabled: false })), "no operator session is running");
	for (const state of ["restarting", "stopping", "relaunching"] as const) assert.equal(restartInFlight(restarting(state)), true, state);
	for (const state of ["restarted", "refused", "failed"] as const) assert.equal(restartInFlight(restarting(state)), false, state);
	assert.equal(restartLine(status({}), restarting("restarted")), "Operator session restarted · 2026-01-01T00-00-00-000Z_0123abcd.jsonl");
});

test("restart CSS: wraps at 390 px (no fixed widths, long file names break), one row at 1440 px", () => {
	const css = readFileSync(join(REPO_ROOT, "viewer-app/components/control.css"), "utf8");
	const rule = (selector: string) => new RegExp(`\\${selector} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
	assert.match(rule(".operator-restart"), /flex-wrap: wrap/);
	assert.match(rule(".operator-restart"), /min-width: 0/);
	assert.match(rule(".operator-restart-button"), /max-width: 100%/);
	assert.match(rule(".operator-restart-button"), /overflow-wrap: anywhere/);
	assert.match(rule(".operator-restart-line"), /overflow-wrap: anywhere/);
	assert.doesNotMatch(rule(".operator-restart-button") + rule(".operator-restart-line"), /white-space: nowrap|[^-]width: \d/);
});
