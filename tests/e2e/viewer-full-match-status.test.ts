/**
 * Full match S5 (cp-dfm-s5-status-yy1q): the desktop chat's status footer through `bin/cp-view` and the served app,
 * from real scratch run files; layout is the browser fixture's `full-match-status` stage.
 */
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { NATIVE_AUTH_CODES, NATIVE_WINDOWS, OBSERVATION_EVENT, WINDOW_STATUSES } from "../../src/drivers/claude-observation.ts";
import { nativeAvailabilityFile, readNativeAvailability, recordNativeObservation } from "../../src/native-availability.ts";
import { QUOTA_AUTH_CODES, QUOTA_STATUSES, QUOTA_WINDOWS } from "../../src/viewer/native-quota.ts";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import type { Context } from "../harness/conversations.ts";
import { dashboard, openTab, operatorSession, type Tab, until } from "../harness/dashboard.ts";

process.env.TZ = "UTC";
const DAY = new Date().toISOString().slice(0, 10);
const NOON = Date.parse(`${DAY}T12:00:00Z`);
const at = (minutes: number) => new Date(NOON - minutes * 60_000).toISOString();
const CHAT = "#sessions?view=you&transcript=1";
const MIN = 60_000;
/** Minutes before NOON each job closed, and its cost: cp-n is in the UTC day only, cp-y in the rolling 24 h only. */
const CLOSED: Record<string, [minutes: number, usd: number]> = { "cp-m": [120, 1.5], "cp-c": [60, 2], "cp-n": [600, 3], "cp-y": [750, 7], "cp-next": [-721, 0.25] };

function seed(stateDir: string, home: string, observed: boolean) {
	const put = (file: string, value: unknown) => {
		mkdirSync(dirname(join(home, file)), { recursive: true });
		writeFileSync(join(home, file), typeof value === "string" ? value : JSON.stringify(value));
	};
	const chat = join(home, "pi-sessions", "chat.jsonl");
	put("pi-sessions/chat.jsonl", `${JSON.stringify({ type: "message", timestamp: at(10), message: { role: "assistant", content: [{ type: "text", text: "REPLY-CARD" }] } })}\n`);
	mkdirSync(join(stateDir, "sessions"), { recursive: true });
	writeFileSync(operatorSessionsFile(join(stateDir, "sessions")), `${JSON.stringify({ at: at(20), session_file: chat })}\n`);
	const ids = Object.keys(CLOSED);
	const usage = (usd: number) => ({ input: 1, output: 1, cache_read: 0, cache_write: 0, total_tokens: 2, cost_usd: usd });
	put(".pi-command-post/jobs.json", { jobs: ids.map((id) => ({ id, title: id, status: "closed", labels: ["project:picp", "kind:ship"], created_at: at(CLOSED[id]![0] + 30), closed_at: at(CLOSED[id]![0]) })) });
	put(LAYOUT.fleetFile, { jobs: [...ids.map((id) => ({ job_id: id, project: "picp", kind: "ship", phase: "done", dispatched_at: at(CLOSED[id]![0] + 30), closed_at: at(CLOSED[id]![0]) })),
		{ job_id: "cp-work", project: "picp", kind: "ship", phase: "waiting", dispatched_at: at(30) }] });
	for (const id of ids) put(join(LAYOUT.runs, id, "status.json"), { model: "prov/worker-model", usage: usage(CLOSED[id]![1]) });
	put(join(LAYOUT.runs, "cp-m/gate-1/status.json"), { model: "x/rev", usage: usage(0.5), started_at: at(125), exited_at: at(122) });
	put(join(LAYOUT.runs, "cp-m/merge.json"), { job_id: "cp-m", merged_at: at(120), pr_url: "https://github.com/o/r/pull/1", merge_commit_sha: "c".repeat(40) });
	put(join(LAYOUT.runs, "cp-work/status.json"), { phase: "working", started_at: at(30) });
	if (!observed) return;
	const routed = (minutes: number, providers: object[]) => `${JSON.stringify({ source: "cp", ts: at(minutes), type: "routing_resolved", payload: { quota: { providers } } })}\n`;
	put(join(LAYOUT.runs, "cp-m/events.jsonl"), routed(150, [{ provider: "anthropic", five_hour: 99, seven_day: 99, tight: true }]));
	put(join(LAYOUT.runs, "cp-work/events.jsonl"), routed(12, [{ provider: "anthropic", five_hour: 58, seven_day: 41, tight: false }, { provider: "openai-codex", seven_day: 37, tight: false }]));
}

const start = async (t: Context, observed = true) => {
	const d = await dashboard(t, { at: new Date(NOON).toISOString(), seed: (stateDir, home) => seed(stateDir, home, observed) });
	await operatorSession(t, d.stateDir);
	return d;
};
const day = (from: string, to: string, tz: string) => `/api/workspace/status?${new URLSearchParams({ from, to, tz })}`;
/** The footer as a reader scans it: each meter as one phrase, then every other segment's text. */
const footer = (tab: Tab) => tab.$$(".workspace-status > *").map((c) => c.matches(".workspace-status-meter") ? [...c.children].map((x) => x.textContent).filter(Boolean).join(" ") : c.textContent).join(" | ");
const bars = (tab: Tab) => tab.$$(".workspace-status progress").map((p) => `${p.getAttribute("aria-label")}=${(p as unknown as { value?: number }).value ?? p.getAttribute("value")}`);
const snapshot = (dir: string): unknown => readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== "clock-offset-ms" && (e.isFile() || e.isDirectory()))
	.map((e) => [e.name, e.isDirectory() ? snapshot(join(dir, e.name)) : readFileSync(join(dir, e.name)).toString("base64")]);

test("S5-status-http: one local day's spend and finishes, the newest recorded quota and the working count; bad ranges are 400; nothing is written", { timeout: 120_000 }, async (t) => {
	const d = await start(t);
	const before = snapshot(join(d.home, ".pi-command-post"));
	const utc = await d.get(day(`${DAY}T00:00:00Z`, new Date(NOON + 12 * 60 * MIN).toISOString(), "UTC"));
	assert.equal(utc.status, 200, utc.text);
	const body = utc.body as any;
	// A rolling 24 h would add cp-y's $7; the local day counts cp-m (+ its reviewer), cp-c and cp-n only.
	const read = body.generated_at;
	assert.ok(Math.abs(Date.parse(read) - NOON) < 60_000, read);
	assert.deepEqual([body.spend, body.done, body.working, body.day.tz, body.quota.observed_at],
		[{ availability: "ok", observed_at: read, usd: 7 }, { availability: "ok", observed_at: read, count: 3 }, { availability: "ok", observed_at: read, count: 1 }, "UTC", at(12)]);
	assert.deepEqual([body.quota.availability, body.quota.observation.observed_at, body.quota.observation.source_job_id, body.quota.observation.historical, body.quota.observation.providers.map((p: any) => [p.provider, p.five_hour, p.seven_day])],
		["ok", at(12), "cp-work", true, [["anthropic", 58, 41], ["openai-codex", null, 37]]], "the newest observation wins; an unreported 5h window is null, never 0");
	// Bogotá (UTC-5, no DST) ended its previous day at 05:00Z today: cp-y and cp-n, not today's UTC jobs.
	const local = await d.get(day(new Date(NOON - 31 * 60 * MIN).toISOString(), new Date(NOON - 7 * 60 * MIN).toISOString(), "America/Bogota"));
	assert.deepEqual([local.status, (local.body as any).spend?.usd, (local.body as any).done?.count], [200, 10, 2], local.text);
	const refused = async (path: string) => { const reply = await d.get(path); assert.equal(reply.status, 400, path); return reply.body.error; };
	const one = "from and to must span one local calendar day in tz";
	assert.equal(await refused(day(at(0), at(-1440), "UTC")), one, "a rolling 24 h is not a day");
	assert.equal(await refused(day(`${DAY}T00:00:00Z`, new Date(NOON + 36 * 60 * MIN).toISOString(), "UTC")), one, "two days");
	assert.equal(await refused(day(`${DAY}T00:00:00Z`, new Date(NOON + 12 * 60 * MIN).toISOString(), "America/Bogota")), one, "a UTC day in another zone");
	assert.equal(await refused("/api/workspace/status?tz=UTC"), "from, to and tz are required");
	await refused(day(`${DAY}T00:00:00Z`, new Date(NOON + 12 * 60 * MIN).toISOString(), "Mars/Base"));
	await refused(day(DAY, `${DAY}T23:00:00Z`, "UTC"));
	assert.equal((await d.get(day(`${DAY}T00:00:00Z`, new Date(NOON + 12 * 60 * MIN).toISOString(), "UTC"), { method: "POST" })).status, 405);
	assert.deepEqual(snapshot(join(d.home, ".pi-command-post")), before, "the endpoint only reads");
	const missing = await start(t, false);
	const none = await missing.get(day(`${DAY}T00:00:00Z`, new Date(NOON + 12 * 60 * MIN).toISOString(), "UTC"));
	assert.deepEqual([none.status, (none.body as any).quota], [200, { availability: "missing", observed_at: null, observation: null }], "no routing event: no observation");
});

test("S5-status-footer: the desktop footer shows recorded quota with its age, the local day, the counts and viewer connectivity; it follows midnight and staleness", { timeout: 120_000 }, async (t) => {
	const d = await start(t);
	const tab = await openTab(t, d.port, CHAT, new Map(), undefined, {}, true);
	tab.shift(NOON - Date.now());
	await tab.waitText(/REPLY-CARD/);
	tab.signal("open");
	const live = "today | $7.00 | · | 1 working | · | 3 done | viewer connected";
	await until(() => footer(tab), (text) => text === `anthropic 58% 5h · 41% wk | openai-codex — 5h · 37% wk | observed 12m ago | ${live}`, "the current footer");
	assert.deepEqual(bars(tab), ["anthropic 5-hour utilization=58"], "an unrecorded 5h window draws no bar, not an empty one");
	assert.equal(tab.$(".workspace-status time")!.getAttribute("title"), "Recorded at routing by cp-work; not a live feed");
	assert.deepEqual([tab.$(".workspace-status")!.getAttribute("aria-label"), /daemon/i.test(footer(tab))], ["Status", false], "SSE proves this viewer's link, never cp-daemon's");
	tab.signal("error");
	await until(() => footer(tab), (text) => text.endsWith("viewer reconnecting"), "a lost stream");
	tab.signal("open");

	// Local midnight: the next day asks for its own range, so only cp-next (00:01) counts. A new URL opens a new stream.
	d.pin(new Date(NOON + 722 * MIN).toISOString());
	tab.shift(722 * MIN);
	tab.refresh();
	await until(() => footer(tab), (text) => text.endsWith("today | $0.25 | · | 1 working | · | 1 done | viewer reconnecting"), "the next local day");
	tab.signal("open");
	await until(() => footer(tab), (text) => text.endsWith("today | $0.25 | · | 1 working | · | 1 done | viewer connected"), "the next local day");
	const asked = tab.requests.filter((r) => r.path.startsWith("/api/workspace/status")).at(-1)!.path;
	assert.deepEqual(Object.fromEntries(new URL(asked, "http://x").searchParams), { from: new Date(NOON + 12 * 60 * MIN).toISOString(), to: new Date(NOON + 36 * 60 * MIN).toISOString(), tz: "UTC" });
	assert.match(footer(tab), /observed 12h 14m ago/);

	// Stale: three days on, the same observation keeps its values and says how old it is; nothing finished that day.
	d.pin(new Date(NOON + 3 * 1440 * MIN).toISOString());
	tab.shift((3 * 1440 - 722) * MIN);
	tab.refresh();
	await until(() => footer(tab), (text) => text.endsWith("| 0 done | viewer reconnecting"), "the third day");
	tab.signal("open");
	await until(() => footer(tab), (text) => text === "anthropic 58% 5h · 41% wk | openai-codex — 5h · 37% wk | observed 3d ago | today | not recorded | · | 1 working | · | 0 done | viewer connected", "the stale footer");
	assert.equal(tab.requests.filter((r) => r.method !== "GET" && r.method !== "HEAD").length, 0, "the footer only reads");
});

test("S5-status-css: from 900 px the footer is the chat's 37 px second row; the drawer, pane and Context end above it; bars stay neutral", { timeout: 120_000 }, async (t) => {
	const d = await start(t);
	const css = (await d.get(String(/<link rel="stylesheet" href="([^"]+)"/.exec((await d.get("/")).text)?.[1]))).text;
	const rule = (sheet: string, selector: string) => [...sheet.matchAll(/(?<=^|[{}])([^{}@]+)\{([^{}]*)\}/g)].filter((m) => m[1] === selector).map((m) => m[2]).join(";");
	const split = css.indexOf("@media(min-width:900px){.workspace-jobs-open>kbd"), wide = css.indexOf("@media(min-width:1280px){.sessions:has(>.workspace-job)");
	assert.ok(split > 0 && wide > split, "the 900 px switch, then 1280 px");
	const [phone, desktop] = [css.slice(0, split), css.slice(split, wide)];
	assert.equal(rule(phone, ".workspace-status"), "", "phones have no footer rule");
	assert.match(rule(desktop, ".sessions"), /--workspace-status: ?37px/);
	assert.match(rule(desktop, ".workspace-status"), /grid-column:1 ?\/ ?-1;grid-row:2;.*height:var\(--workspace-status\)/, "a full-width second row");
	assert.match(rule(desktop, ".workspace-job"), /grid-row:1 ?\/ ?-1/, "the pane spans the first row only");
	assert.match(rule(desktop, "aside.workspace-context"), /bottom:var\(--workspace-status, ?0px\)/, "Context stops at the footer");
	assert.match(rule(desktop, ".workspace-jobs"), /height:calc\(100% - var\(--workspace-status, ?0px\)\)/, "so does the drawer");
	assert.match(rule(desktop, ".workspace-status-meter>progress::-webkit-progress-value"), /background:var\(--muted\)/, "a neutral fill at any utilization");
});

test("S3-claude-line: a separate Claude item only with the switch on — no snapshot is unknown, a future reset limited, an auth entry blocked", { timeout: 120_000 }, async (t) => {
	assert.deepEqual([QUOTA_WINDOWS, QUOTA_AUTH_CODES, QUOTA_STATUSES], [NATIVE_WINDOWS, NATIVE_AUTH_CODES, WINDOW_STATUSES], "viewer copies match");
	const d = await start(t);
	const url = day(`${DAY}T00:00:00Z`, new Date(NOON + 12 * 60 * MIN).toISOString(), "UTC");
	const claude = async () => ((await d.get(url)).body as any).claude;
	assert.equal(await claude(), undefined, "switch off: no Claude item");
	const switchFile = join(d.home, LAYOUT.data, "native.json");
	mkdirSync(dirname(switchFile), { recursive: true });
	writeFileSync(switchFile, JSON.stringify({ claude_research: true }));
	utimesSync(switchFile, 0, 0); // the viewer runs at NOON; an older switch never voids the entries below
	const label = async () => (await claude())?.label;
	assert.equal(await label(), "Claude unknown", "no snapshot is unknown, never ok or 0%");
	const snapshot = nativeAvailabilityFile(d.home);
	writeFileSync(snapshot, "{not json");
	assert.equal(await label(), "Claude unknown", "a corrupt snapshot is unknown");
	const write = (over: object) => writeFileSync(snapshot, JSON.stringify({ version: 1, windows: {}, seen: [], ...over }));
	write({ windows: { five_hour: { status: "rejected", observed_at: NOON - 60 * MIN, resets_at: NOON + 120 * MIN, utilization: 1 } } });
	assert.deepEqual(await claude(), { state: "limited", label: "Claude limited until 14:00Z", detail: `five_hour rejected until ${DAY}T14:00:00Z` });
	const status = await d.get(url);
	assert.deepEqual((status.body as any).quota.observation.providers.map((p: any) => p.provider), ["anthropic", "openai-codex"], "never merged into gateway quota");
	const tab = await openTab(t, d.port, CHAT, new Map(), undefined, {}, true);
	tab.shift(NOON - Date.now());
	await until(() => footer(tab), (text) => text.includes("observed 12m ago | Claude limited until 14:00Z | today"), "the Claude item after the gateway quota");
	write({ auth: { code: "authentication_failed", observed_at: NOON - 60 * MIN } });
	assert.equal(await label(), "Claude blocked (sign-in)");
	write({});
	assert.equal(await label(), "Claude ok");
	// The S2 writer's own file: a no-reset window it records is what the viewer reads.
	const event = { type: OBSERVATION_EVENT, observed_at: NOON - 30 * MIN, kind: "window", window: "seven_day_opus", status: "rejected" };
	assert.equal(recordNativeObservation(d.home, event), true);
	assert.deepEqual(await claude(), { state: "limited", label: "Claude limited (reset unknown)", detail: "seven_day_opus rejected, reset unknown" });
	// Differential parity: the viewer reads a snapshot (not "no readable snapshot") exactly when S2's SnapshotSchema
	// accepts it; `accepted` pins today's S2 answer so neither side drifts alone.
	const valid = { version: 1, windows: {}, seen: [] }, entry = { status: "allowed", observed_at: NOON };
	const table: [string, unknown, boolean][] = [
		["minimal", valid, true],
		["utilization and claude_version", { ...valid, windows: { five_hour: { ...entry, utilization: 0.5, claude_version: "2.1.0" } } }, true],
		["an unknown window name (ignored, as S2's Partial does)", { ...valid, windows: { weekly: { status: "rejected", observed_at: NOON } } }, true],
		["no seen list", { version: 1, windows: {} }, false],
		["an extra top-level key", { ...valid, extra: true }, false],
		["an extra window-entry key", { ...valid, windows: { five_hour: { ...entry, extra: 1 } } }, false],
		["an extra auth key", { ...valid, auth: { code: "authentication_failed", observed_at: NOON, extra: 1 } }, false],
		["seen with 257 items", { ...valid, seen: Array(257).fill("uuid") }, false],
		["a negative observed_at", { ...valid, windows: { five_hour: { ...entry, observed_at: -1 } } }, false],
		["an unknown status", { ...valid, windows: { five_hour: { ...entry, status: "spent" } } }, false],
		["version 2", { ...valid, version: 2 }, false],
		["an unknown auth code", { ...valid, auth: { code: "expired", observed_at: NOON } }, false],
		["an empty claude_version", { ...valid, windows: { five_hour: { ...entry, claude_version: "" } } }, false],
		// Final fix (operator ask-d563b9af3a3a): non-object containers, wrong-typed fields and length bounds.
		...[null, [], "x", 1].map((windows): [string, unknown, boolean] => [`windows ${JSON.stringify(windows)}`, { ...valid, windows }, false]),
		...["auth", "lockdown"].flatMap((key) => [null, [], "x"].map((value): [string, unknown, boolean] => [`${key} ${JSON.stringify(value)}`, { ...valid, [key]: value }, false])),
		...[null, [], "x"].map((value): [string, unknown, boolean] => [`window entry ${JSON.stringify(value)}`, { ...valid, windows: { five_hour: value } }, false]),
		...[{}, "x", null].map((seen): [string, unknown, boolean] => [`seen ${JSON.stringify(seen)}`, { ...valid, seen }, false]),
		...[1, null, {}].map((item): [string, unknown, boolean] => [`a seen item ${JSON.stringify(item)}`, { ...valid, seen: [item] }, false]),
		["a 65-char seen item", { ...valid, seen: ["u".repeat(65)] }, false],
		["exactly 256 seen items", { ...valid, seen: Array(256).fill("uuid") }, true],
		["utilization as a string", { ...valid, windows: { five_hour: { ...entry, utilization: "0.5" } } }, false],
		["utilization null", { ...valid, windows: { five_hour: { ...entry, utilization: null } } }, false],
		["a negative resets_at", { ...valid, windows: { five_hour: { ...entry, resets_at: -1 } } }, false],
		["resets_at as a string", { ...valid, windows: { five_hour: { ...entry, resets_at: "5" } } }, false],
		["observed_at as a string", { ...valid, windows: { five_hour: { ...entry, observed_at: "5" } } }, false],
		["no observed_at", { ...valid, windows: { five_hour: { status: "allowed" } } }, false],
		["a 41-char claude_version", { ...valid, windows: { five_hour: { ...entry, claude_version: "v".repeat(41) } } }, false],
		["a 40-char claude_version", { ...valid, windows: { five_hour: { ...entry, claude_version: "v".repeat(40) } } }, true],
		["version \"1\"", { ...valid, version: "1" }, false],
		["no version", { windows: {}, seen: [] }, false],
		...[[], null, 1].map((top): [string, unknown, boolean] => [`top level ${JSON.stringify(top)}`, top, false]),
		["auth without a code", { ...valid, auth: { observed_at: NOON } }, false],
		["lockdown without a code", { ...valid, lockdown: { observed_at: NOON } }, false],
		["an infinite observed_at (1e400)", "RAW", false],
	];
	for (const [why, raw, accepted] of table) {
		const text = raw === "RAW" ? `{"version":1,"windows":{"five_hour":{"status":"allowed","observed_at":1e400}},"seen":[]}` : JSON.stringify(raw);
		writeFileSync(snapshot, text);
		assert.equal(readNativeAvailability(d.home) !== undefined, accepted, `S2 on ${why}`);
		assert.equal((await claude())?.detail !== "no readable native-availability snapshot yet", accepted, `viewer on ${why}`);
	}
	writeFileSync(snapshot, JSON.stringify({ version: 1, windows: {} }));
	assert.equal(await label(), "Claude unknown", "a snapshot with no seen list reads unknown with the switch on");
	writeFileSync(snapshot, JSON.stringify({ ...valid, extra: true }));
	assert.equal(await label(), "Claude unknown", "an extra top-level key reads unknown with the switch on");
	writeFileSync(switchFile, JSON.stringify({ claude_research: false }));
	assert.equal(await claude(), undefined, "switch off again: the line is as short as before");
});

test("S5-status-missing-phone: no observation reads as not recorded; a phone has no footer and asks for none", { timeout: 120_000 }, async (t) => {
	const d = await start(t, false);
	const tab = await openTab(t, d.port, CHAT, new Map(), undefined, {}, true);
	tab.shift(NOON - Date.now());
	await tab.waitText(/REPLY-CARD/);
	await until(() => footer(tab), (text) => text.startsWith("quota not recorded | today | $7.00"), "the unobserved footer");
	assert.deepEqual(bars(tab), []);
	const phone = await openTab(t, d.port, CHAT, new Map(), undefined, {}, false);
	await phone.waitText(/REPLY-CARD/);
	await new Promise((done) => setTimeout(done, 200));
	assert.deepEqual([!!phone.$(".workspace-status"), phone.started.some((r) => r.includes("/api/workspace/status"))], [false, false]);
});
