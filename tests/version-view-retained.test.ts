/**
 * cp-kz20: the version view's units no entry point reaches, moved verbatim from tests/version-view.test.ts (P14).
 * The badge renders only in the viewer page's browser bundle; the updater constants are a cross-module mirror.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { DRAIN_TIMEOUT_RETRY_FACTOR, DRAIN_WAIT_MS, QUIET_MIN_DEFAULT, readUpdateConfig } from "../src/service/update.ts";
import { readVersion, UPDATER } from "../src/viewer/version-view.ts";
import { badgeView } from "../viewer-app/use-version.ts";
import { createScratchHome, createScratchRepo } from "./harness/index.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const ALIVE = new Set([101, 102, 103]);
const SECRET = "f".repeat(64);

function fixture(t: { after(fn: () => void): void }) {
	const home = createScratchHome();
	const repo = createScratchRepo();
	t.after(() => { home.cleanup(); repo.cleanup(); });
	const stateDir = join(home.path, LAYOUT.state);
	mkdirSync(join(stateDir, "operator"), { recursive: true });
	const write = (file: string, value: unknown) => writeFileSync(join(stateDir, file), JSON.stringify(value));
	const read = (extra: Partial<Parameters<typeof readVersion>[0]> = {}) => readVersion({
		home: home.path, stateDir, repo: repo.path, now: () => NOW, alive: (pid) => ALIVE.has(pid),
		self: { pid: 100, started_at: iso(5), commit: repo.head() }, script: "/assets/viewer/app-abc.js", ...extra,
	});
	return { home, repo, stateDir, write, read };
}

/** Every process on HEAD, a fresh up_to_date run: the green baseline each test bends. */
function current(f: ReturnType<typeof fixture>) {
	const head = f.repo.head();
	f.write("update.json", { last_result: "up_to_date", last_run_at: iso(2), since: iso(60) });
	f.write("parent-host.1.json", { version: 1, pid: 999, socket: "/s1", token: SECRET, started_at: iso(90) });
	f.write("parent-host.2.json", { version: 1, pid: 101, socket: "/tmp/host.sock", token: SECRET, started_at: iso(30), commit: head });
	f.write("parent.lock", { schema_version: 1, pid: 102, started_at: iso(30), home: f.home.path, commit: head });
	f.write("operator/dashboard.json", { version: 1, pid: 103, socket: "/tmp/dash.sock", token: SECRET, csrf: SECRET, started_at: iso(20), commit: head });
}

test("#325: the sentence's drain wait, retry factor and defaults match the updater's own constants", (t) => {
	// Mirrored, not imported (the updater imports the viewer server); this fails when either side drifts.
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const config = readUpdateConfig(join(home.path, "no-data"));
	assert.ok(typeof config !== "string");
	assert.deepEqual(UPDATER, { drainWaitMin: DRAIN_WAIT_MS / 60_000, retryFactor: DRAIN_TIMEOUT_RETRY_FACTOR, intervalMin: config.interval_min, quietMin: QUIET_MIN_DEFAULT });
});

test("badge: an outdated page lifts ok/unknown to amber with a reload; alert stays red; loading and errors are grey", async (t) => {
	const f = fixture(t);
	current(f);
	const view = await f.read();
	assert.deepEqual(badgeView({ view, error: null }, "/assets/viewer/app-abc.js"), { level: "ok", short: "✓", label: view.overall.label, headline: view.overall.headline, pageStale: false });
	const old = badgeView({ view, error: null }, "/assets/viewer/app-old.js");
	assert.deepEqual([old.level, old.pageStale, old.label.startsWith("page outdated — reload")], ["warn", true, true]);
	const red = { ...view, overall: { level: "alert" as const, label: "update failed", headline: "update failed" } };
	assert.equal(badgeView({ view: red, error: null }, "/assets/viewer/app-old.js").level, "alert");
	assert.deepEqual(badgeView({ view: null, error: "HTTP 500" }, null), { level: "unknown", short: "?", label: "version unavailable (HTTP 500)", headline: "version unavailable (HTTP 500)", pageStale: false });
});
