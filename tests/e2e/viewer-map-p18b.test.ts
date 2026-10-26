/**
 * P18b: the dependency Map, its grants and the app's navigation through `bin/cp-view` on a scratch home.
 * The tab is linkedom (tests/harness/dashboard.ts): DOM, text and served CSS only, never pixels.
 */
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import type { MapResponse } from "../../src/viewer/api-types.ts";
import { dashboard, until } from "../harness/dashboard.ts";

const NOW = "2026-09-26T12:00:00Z";
const LATER = "2099-09-26T12:00:00Z";

type Put = (file: string, value: unknown) => void;
const putter = (home: string): Put => (file, value) => {
	const path = join(home, file);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
};
const grantOf = (put: Put) => (id: string, status: string, project: string, extra: object = {}) => put(join(LAYOUT.mandates, `${id}.json`), {
	id, status, projects: [project], issued_at: "2026-01-01T00:00:00Z", expiry: LATER, objective: `Goal ${id}`,
	spend_cap: { usd: 100, tokens: 10000 }, job_cap: 12, dispatch_parallelism: 4, ask_on: ["risk:high"], ...extra,
});

/** A viewer at `at` (UTC host zone) over a home `seed` wrote; `map()` reads /api/map and requires a 200. */
async function mapView(t: TestContext, seed: (put: Put, home: string) => void, at = NOW) {
	const view = await dashboard(t, { requireTailnet: false, at, env: { TZ: "UTC" }, seed: (_state, home) => seed(putter(home), home) });
	const map = async () => {
		const reply = await view.get("/api/map");
		assert.equal(reply.status, 200, reply.text);
		return JSON.parse(reply.text) as MapResponse;
	};
	return { ...view, put: putter(view.home), map };
}

const snapshot = (dir: string): unknown => readdirSync(dir, { withFileTypes: true })
	.filter((e) => e.name !== "clock-offset-ms")
	.map((e) => [e.name, e.isDirectory() ? snapshot(join(dir, e.name)) : readFileSync(join(dir, e.name), "utf8")]);

test("P18-map-api: /api/map reads grants, spend, closures and blockers from disk, refuses writes and writes nothing", { timeout: 180_000 }, async (t) => {
	// All grants and cross-project blockers, read-only; the old mandates page and stream are gone.
	const v = await mapView(t, (put) => {
		const grant = grantOf(put);
		grant("md-active", "active", "demo");
		grant("md-paused", "paused", "other");
		for (let i = 0; i < 7; i++) grant(`md-rev${i}`, "revoked", `old${i}`);
		put(LAYOUT.jobsFile, { jobs: [
			{ id: "cp-a", title: "Dependent", status: "open", labels: ["project:demo"], blocked_by: ["cp-b", "cp-done", "cp-drop", "cp-missing"] },
			{ id: "cp-b", title: "Blocker", status: "open", labels: ["project:other"], blocked_by: [] },
			{ id: "cp-done", status: "closed", labels: ["project:demo"], blocked_by: [] },
			{ id: "cp-drop", status: "closed", close_reason: "dropped: skipped", labels: ["project:demo"], blocked_by: [] },
		] });
		put(LAYOUT.fleetFile, { jobs: [{ job_id: "cp-b", project: "other", phase: "failed", usage: { cost_usd: 2, total_tokens: 200, cache_read: 50 } }] });
		put(join(LAYOUT.runs, "cp-b/review-1/status.json"), { usage: { cost_usd: 0.5, total_tokens: 30, cache_read: 0 } });
	});
	const before = snapshot(v.home);
	const map = await v.map();
	assert.deepEqual([map.items.length, map.revoked_count], [9, 7], "every grant, revoked ones counted");
	assert.deepEqual(map.items.find((m) => m.id === "md-paused")?.spend, { usd: 2.5, tokens: 180, jobs: 1, inFlight: 0 }, "non-cached tokens plus the reviewer's");
	assert.equal((await v.get("/api/mandates")).status, 404, "the mandates page is gone");
	assert.equal((await v.get("/api/stream?view=mandates", { method: "HEAD" })).status, 404);
	assert.deepEqual([map.nodes.find((n) => n.id === "cp-b")?.phase, map.nodes.find((n) => n.id === "cp-a")?.mandate_id], ["failed", "md-active"]);
	assert.equal(map.edges.find((e) => e.from === "cp-done")?.kind, "satisfied");
	assert.deepEqual(["cp-b", "cp-drop", "cp-missing"].map((id) => map.edges.find((e) => e.from === id)?.kind), ["stranded", "stranded", "stranded"], "failed, dropped and missing blockers strand");
	assert.equal(map.stranded_count, 3);
	assert.ok(map.nodes.some((n) => n.id === "cp-missing" && n.ledger_status === null), "a missing blocker is a node with no ledger status");
	const read = await v.get("/api/map");
	assert.match(String(read.headers["content-type"]), /^application\/json/, "a map read is one JSON body and leaves no refresh stream open");
	assert.equal((await v.get("/api/map", { method: "POST" })).status, 405);
	assert.equal((await v.get("/api/map", { headers: { host: "evil.example" } })).status, 200, "the Host check is off without --require-tailnet");
	assert.equal((await v.get("/api/stream?view=map", { method: "HEAD" })).status, 200);
	assert.deepEqual(snapshot(v.home), before, "the viewer wrote nothing under the home");
	v.put(join(LAYOUT.mandates, "md-bad.json"), { status: "bad" });
	const broken = await v.map();
	assert.deepEqual([broken.stranded_count, broken.availability.mandates], [null, "unavailable"], "a corrupt grant never claims no stranded work");

	// Launching takes a slot, held does not; recorded revoked and expired statuses stay.
	const slots = await mapView(t, (put) => {
		grantOf(put)("md-live", "active", "demo", { expiry: "2099-01-01T00:00:00Z" });
		grantOf(put)("md-old", "revoked", "old");
		put(LAYOUT.fleetFile, { jobs: [{ job_id: "cp-launch", project: "demo", phase: "launching" }, { job_id: "cp-held", project: "demo", phase: "held" }] });
		put(LAYOUT.jobsFile, { jobs: [{ id: "cp-launch", status: "in_progress", labels: ["project:demo"], blocked_by: [] }] });
	});
	const live = (await slots.map()).items.find((m) => m.id === "md-live")?.spend;
	assert.deepEqual([live?.inFlight, live?.jobs], [1, 2], "launching consumes a slot, held does not");
	assert.equal((await slots.map()).nodes.find((n) => n.id === "cp-launch")?.phase, "launching");
	slots.pin("2100-01-01T00:00:00Z");
	const expired = await slots.map();
	assert.deepEqual(["md-live", "md-old"].map((id) => expired.items.find((m) => m.id === id)?.status), ["expired", "revoked"]);
	slots.put(LAYOUT.fleetFile, { jobs: [{ job_id: "../bad", project: "demo", phase: "held" }] });
	assert.equal((await slots.map()).items.find((m) => m.id === "md-live")?.spend, null, "an unsafe fleet id gives no spend, never zero");

	// Closed today needs every named job closed today; titles and PR status are the recorded ones.
	const title = "[c-parent-host] host the parent RPC pipe outside the operator process";
	const closures = await mapView(t, (put) => {
		grantOf(put)("md-broad", "active", "demo");
		for (const [id, status, ids] of [["md-finished", "active", ["cp-one", "cp-two"]], ["md-incomplete", "active", ["cp-one", "cp-missing"]], ["md-paused", "paused", ["cp-one"]], ["md-revoked", "revoked", ["cp-one"]]] as const) {
			put(join(LAYOUT.mandates, `${id}.json`), { id, status, projects: ["demo"], job_ids: ids, issued_at: "2026-01-01T00:00:00Z", expiry: status === "paused" ? "2026-09-25T12:00:00Z" : LATER, spend_cap: { usd: 100, tokens: 1000 } });
		}
		put(LAYOUT.jobsFile, { jobs: [{ id: "cp-one", title, status: "closed", closed_at: "2026-09-26T11:03:00Z", labels: ["project:demo"] }, { id: "cp-two", status: "closed", closed_at: "2026-09-25T12:00:00Z", labels: ["project:demo"] }] });
		put(LAYOUT.fleetFile, { jobs: [{ job_id: "cp-one", project: "demo", phase: "done", receipts: [{ kind: "pr", url: "https://github.com/acme/repo/pull/254", status: "merged" }] }] });
	});
	const closed = await closures.map();
	assert.deepEqual(["md-finished", "md-broad", "md-incomplete", "md-paused", "md-revoked"].map((id) => closed.items.find((m) => m.id === id)?.status), ["closed", "active", "active", "paused", "revoked"]);
	assert.equal(closed.active_count, 2);
	assert.deepEqual([closed.nodes.find((n) => n.id === "cp-one")?.title, closed.nodes.find((n) => n.id === "cp-one")?.pr_status], [title, "merged"], "the recorded title and PR status");

	// Mission-end closes count on the revocation day; ordinary revocations keep their label.
	const ends = await mapView(t, (put) => {
		for (const id of ["md-close", "md-label", "md-old", "md-manual", "md-open", "md-extend", "md-future"]) {
			const revoked = id === "md-old" ? "2026-09-25T11:00:00Z" : id === "md-future" ? "2026-09-26T13:00:00Z" : "2026-09-26T11:00:00Z";
			put(join(LAYOUT.mandates, `${id}.json`), { id, status: "revoked", projects: ["demo"], issued_at: "2026-01-01T00:00:00Z", expiry: LATER, spend_cap: { usd: 10, tokens: 100 }, revoked_at: revoked });
		}
		put(LAYOUT.escalationsFile, { items: ["close", "label", "old", "open", "extend", "future"].map((id) => ({
			id: `es-${id}`, mandate_id: `md-${id}`, kind: "mission_end", status: id === "open" ? "open" : "answered",
			answer: id === "label" ? "Close the mission" : id === "extend" ? "extend" : "close", answered_at: "2026-09-26T10:00:00Z", options: [{ id: "close", label: "Close the mission" }],
		})) });
	});
	const ended = await ends.map();
	assert.deepEqual(ended.items.filter((m) => m.closed_at).map((m) => m.id), ["md-close", "md-label"], "only today's answered closes");
	assert.deepEqual([ended.revoked_count, ended.items.every((m) => m.status === "revoked")], [7, true], "no revocation is relabelled");
	ends.put(LAYOUT.escalationsFile, "{bad");
	assert.equal((await ends.map()).availability.escalations, "unavailable");

	// A flat single-project home: explicit coverage only; an open blocker strands once its grant expires.
	const flat = await mapView(t, (put) => {
		put(".pi-command-post/state/mandates/md-limit.json", { id: "md-limit", status: "active", projects: ["demo"], job_ids: ["cp-b"], issued_at: "2026-01-01T00:00:00Z", expiry: LATER, spend_cap: { usd: 10, tokens: 100 } });
		put(".pi-command-post/jobs.json", { jobs: [{ id: "cp-a", status: "open", labels: ["project:demo"], blocked_by: ["cp-b"] }, { id: "cp-b", status: "open", labels: ["project:demo"], blocked_by: [] }] });
	});
	const single = await flat.map();
	assert.deepEqual(["cp-a", "cp-b"].map((id) => single.nodes.find((n) => n.id === id)?.mandate_id), [null, "md-limit"], "explicit coverage only");
	assert.deepEqual([single.edges[0]?.kind, single.stranded_count], ["open", 0]);
	flat.pin("2100-01-01T00:00:00Z");
	assert.equal((await flat.map()).edges[0]?.kind, "stranded", "an expired grant's open blocker strands");
});

test("P18-nav: every hash, old or unknown, lands on one screen's data and lights one owner in each nav", { timeout: 300_000 }, async (t) => {
	const v = await mapView(t, () => {});
	/** The hash's first screen-data read, and the lit item of the desktop sidebar and the phone tab bar. */
	const visit = async (hash: string, read: string) => {
		const tab = await v.open(hash);
		await tab.find('nav[aria-label="Primary"] a[aria-current="page"]');
		const reads = await until(() => tab.requests.map((r) => r.path).filter((p) => p.startsWith("/api/") && !p.startsWith("/api/stream") && !p.startsWith("/api/control")), (p) => p.some((path) => path === read || path.startsWith(`${read}&`)), `${read} for ${hash}`).catch((error: Error) => [error.message]);
		const lit = (label: string) => tab.$(`nav[aria-label="${label}"] a[aria-current="page"]`)?.getAttribute("href") ?? null;
		const hrefs = (label: string) => tab.$$(`nav[aria-label="${label}"] a`).map((a) => a.getAttribute("href"));
		const seen = { reads, desktop: lit("Desktop primary"), phone: lit("Primary"), sidebar: hrefs("Desktop primary"), tabs: hrefs("Primary") };
		tab.close();
		return seen;
	};
	const home = await visit("#overview", "/api/overview");
	assert.deepEqual(home.sidebar, ["#overview", "#decisions", "#jobs", "#sessions", "#stats", "#reports", "#settings", "#more"], "eight desktop items");
	assert.deepEqual(home.tabs, ["#overview", "#decisions", "#jobs", "#sessions", "#more"], "five phone tabs");
	assert.ok(!home.sidebar.includes("#mandates") && !home.sidebar.includes("#map"), "nothing links to the gone Mandates page");
	// [hash, the screen's data read, lit on desktop, lit on phone]
	const cases: Array<[string, string, string, string]> = [
		["", "/api/overview", "#overview", "#overview"], ["#%E0", "/api/overview", "#overview", "#overview"],
		["#unknown", "/api/overview", "#overview", "#overview"], ["#overview/missing", "/api/overview", "#overview", "#overview"],
		["#mandates", "/api/overview", "#overview", "#overview"], ["#overview/mandates", "/api/overview", "#overview", "#overview"],
		["#overview/awaiting", "/api/overview", "#overview", "#overview"],
		["#job/..%2Fbad", "/api/overview", "#overview", "#overview"], ["#job/cp-a?tab=timeline", "/api/overview", "#overview", "#overview"], ["#job/..%2Fbad?tab=transcript", "/api/overview", "#overview", "#overview"], ["#job/cp-a/..?tab=transcript", "/api/overview", "#overview", "#overview"],
		["#job/cp-a?tab=transcript&x=1", "/api/overview", "#overview", "#overview"], ["#job/?tab=transcript", "/api/overview", "#overview", "#overview"],
		["#more", "/api/overview", "#more", "#more"],
		["#decisions", "/api/decisions", "#decisions", "#decisions"], ["#awaiting", "/api/decisions", "#decisions", "#decisions"],
		["#decided", "/api/decisions", "#decisions", "#decisions"],
		["#jobs", "/api/jobs", "#jobs", "#jobs"], ["#dashboard", "/api/jobs", "#jobs", "#jobs"], ["#board", "/api/board", "#jobs", "#jobs"],
		["#map", "/api/map", "#jobs", "#jobs"], ["#job/cp-a", "/api/job/cp-a", "#jobs", "#jobs"], ["#job/cp-a?tab=transcript", "/api/job/cp-a", "#jobs", "#jobs"],
		["#reports", "/api/reports", "#reports", "#more"], ["#schedules", "/api/schedules", "#more", "#more"],
		["#settings", "/api/settings", "#settings", "#more"], ["#stats?range=7d&project=a", "/api/stats?range=7d&project=a", "#stats", "#more"],
		["#session/cp-parent", "/api/sessions?view=parent", "#sessions", "#sessions"], ["#session/cp-a", "/api/sessions?view=workers&id=cp-a", "#sessions", "#sessions"],
		["#cp-a", "/api/sessions?view=workers&id=cp-a", "#sessions", "#sessions"], ["#sessions?view=workers&id=cp-a", "/api/sessions?view=workers&id=cp-a", "#sessions", "#sessions"],
		["#files/project:demo", "/api/files?root=project%3Ademo&path=&view=screen", "#more", "#more"], ["#files", "/api/files?view=screen", "#more", "#more"], ["#sessions", "/api/sessions?view=you", "#sessions", "#sessions"],
		["#files?root=project%3Ademo&path=a%3Fb", "/api/files?root=project%3Ademo&path=a%3Fb&view=screen", "#more", "#more"], ["#files/project%3Ademo/dir%2Fa%3Fb", "/api/files?root=project%3Ademo&path=dir%2Fa%3Fb&view=screen", "#more", "#more"],
		["#git/project%3Ademo", "/api/files?root=project%3Ademo&path=&view=screen", "#more", "#more"],
	];
	for (const [hash, read, desktop, phone] of cases) {
		const seen = await visit(hash, read);
		assert.ok(seen.reads.some((p) => p === read || p.startsWith(`${read}&`)), `${hash} reads ${read}: ${seen.reads}`);
		assert.deepEqual([seen.desktop, seen.phone], [desktop, phone], `${hash} lights ${desktop} on desktop, ${phone} on phone`);
	}
});
