/**
 * Dashboard load probe: `node tests/harness/dashboard-probe.ts --url <viewer> --hashes '<h1>,<h2>' [--seconds 60]`.
 * One desktop linkedom tab per hash with real streams (GETs only), `/healthz` sampled at 10 Hz; one JSON line on stdout.
 */
import { parseArgs } from "node:util";
import { openTab, type Tab } from "./dashboard.ts";

const { values } = parseArgs({ options: { url: { type: "string" }, hashes: { type: "string" }, seconds: { type: "string", default: "60" } } });
const seconds = Number(values.seconds);
if (!values.url || !values.hashes || !Number.isFinite(seconds) || seconds <= 0) {
	process.stderr.write("usage: node tests/harness/dashboard-probe.ts --url <viewer> --hashes '<h1>,<h2>' [--seconds 60]\n");
	process.exit(2);
}
const origin = new URL(values.url).origin;
const port = Number(new URL(origin).port || 80);
const fail = (error: string) => {
	process.stdout.write(`${JSON.stringify({ ok: false, url: origin, error })}\n`);
	process.exit(1);
};
await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(5_000) }).then((reply) => {
	if (reply.status !== 200) fail(`/healthz answered ${reply.status}`);
}, (error: Error) => fail(`unreachable: ${error.cause instanceof Error ? error.cause.message : error.message}`));

const after: Array<() => unknown> = [];
const context = { after: (fn: () => unknown) => void after.push(fn) };
const startedAt = performance.now();
const tabs: Array<[string, Tab]> = [];
for (const hash of values.hashes.split(",").map((h) => h.trim()).filter(Boolean)) {
	tabs.push([hash, await openTab(context, port, hash, new Map(), undefined, {}, true, { liveStream: true, origin, getOnly: true })]);
}

const health: number[] = [];
let healthFailures = 0, inFlight = false, maxStreams = 0;
const sampler = setInterval(() => {
	maxStreams = Math.max(maxStreams, tabs.reduce((sum, [, tab]) => sum + tab.openStreams(), 0));
	if (inFlight) return;
	inFlight = true;
	const at = performance.now();
	fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(5_000) })
		.then(async (reply) => { await reply.arrayBuffer(); if (reply.ok) health.push(performance.now() - at); else healthFailures++; })
		.catch(() => { healthFailures++; })
		.finally(() => { inFlight = false; });
}, 100);
await new Promise((done) => setTimeout(done, seconds * 1000));
clearInterval(sampler);
const streamsAtEnd = tabs.reduce((sum, [, tab]) => sum + tab.openStreams(), 0);
for (const fn of after.reverse()) await fn();
const minutes = (performance.now() - startedAt) / 60_000;

const percentile = (list: number[], p: number) => {
	const sorted = [...list].sort((a, b) => a - b);
	return sorted.length ? round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!) : null;
};
const round = (n: number) => Math.round(n * 10) / 10;
const rows = tabs.flatMap(([, tab]) => tab.requests);
const paths: Record<string, { requests_per_min: number; bytes_per_min: number; statuses: Record<string, number> }> = {};
for (const row of rows) {
	const key = row.path.split("?")[0]!;
	const entry = (paths[key] ??= { requests_per_min: 0, bytes_per_min: 0, statuses: {} });
	entry.requests_per_min += 1 / minutes;
	entry.bytes_per_min += row.bytes / minutes;
	entry.statuses[row.status] = (entry.statuses[row.status] ?? 0) + 1;
}
for (const entry of Object.values(paths)) Object.assign(entry, { requests_per_min: round(entry.requests_per_min), bytes_per_min: Math.round(entry.bytes_per_min) });
const streams = tabs.flatMap(([, tab]) => tab.streams);
const control = tabs.flatMap(([, tab]) => tab.requests.filter((row) => row.path.startsWith("/api/operator/control")))[0];
process.stdout.write(`${JSON.stringify({
	ok: true, url: origin, hashes: tabs.map(([hash]) => hash), seconds: round(minutes * 60),
	requests_per_min: round(rows.length / minutes), bytes_per_min: Math.round(rows.reduce((sum, row) => sum + row.bytes, 0) / minutes),
	paths,
	streams: { opened: streams.length, open_at_end: streamsAtEnd, max_open: maxStreams, events_per_min: round(streams.reduce((sum, s) => sum + s.events, 0) / minutes), bytes_per_min: Math.round(streams.reduce((sum, s) => sum + s.bytes, 0) / minutes) },
	healthz: { samples: health.length, failures: healthFailures, p50_ms: percentile(health, 50), p99_ms: percentile(health, 99), max_ms: health.length ? round(Math.max(...health)) : null },
	control_ttfb_ms: control ? round(control.ms) : null,
	refused_writes: tabs.flatMap(([, tab]) => tab.refused),
})}\n`);
process.exit(0);
