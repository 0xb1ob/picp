/**
 * The Reports page: the read-only `/api/reports` projection (newest first,
 * invalid boards skipped, newest revision per job set), the `/boards/` 302 to `/#reports`, and the screen
 * that lists a published board's title, description and job ids.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { reportsView } from "../src/viewer/reports-view.ts";
import { createViewer, type ViewerOptions } from "../src/viewer/server.ts";
import type { ReportsResponse } from "../src/viewer/api-types.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

const AT = "2026-09-04T00:00:00Z";

/** Two valid boards (beta newer) and one whose `board.json` lacks `created_at`. */
function fixture(t: { after(fn: () => void): void }): ViewerOptions {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	const boards = join(stateDir, "boards");
	const make = (slug: string, meta: unknown): void => {
		mkdirSync(join(boards, slug, "site"), { recursive: true });
		writeFileSync(join(boards, slug, "board.json"), JSON.stringify(meta));
	};
	make("alpha", { title: "Alpha report", description: "the first", job_ids: ["cp-1", 7], created_at: "2026-09-01T00:00:00Z" });
	make("beta", { title: "Beta report", description: "the second", job_ids: ["cp-2"], created_at: "2026-09-03T00:00:00Z" });
	make("broken", { title: "No timestamp" });
	return { home: home.path, stateDir, host: "127.0.0.1", port: 0 };
}

test("reports view lists valid boards newest first with their href, skipping invalid ones", (t) => {
	const state = fixture(t);
	const data = reportsView(state, () => {}, Date.parse(AT));
	assert.equal(data.generated_at, "2026-09-04T00:00:00.000Z");
	assert.deepEqual(data.reports.map((r) => r.slug), ["beta", "alpha"]);
	assert.deepEqual(data.reports.map((r) => r.href), ["/boards/beta/", "/boards/alpha/"]);
	assert.equal(data.reports[1]?.title, "Alpha report");
	assert.equal(data.reports[1]?.description, "the first");
	assert.deepEqual(data.reports[1]?.job_ids, ["cp-1"], "job_ids keeps its strings");
	assert.deepEqual(reportsView({ home: "/nonexistent", stateDir: "/nonexistent/state" }).reports, []);
});

test("reports view keeps only the newest revision per job set; a board naming no job is always listed", (t) => {
	const state = fixture(t);
	const make = (slug: string, meta: unknown): void => {
		mkdirSync(join(state.stateDir, "boards", slug, "site"), { recursive: true });
		writeFileSync(join(state.stateDir, "boards", slug, "board.json"), JSON.stringify(meta));
	};
	make("beta-rev2", { title: "Beta report v2", description: "revised", job_ids: ["cp-2"], created_at: "2026-09-03T12:00:00Z" });
	make("loose-a", { title: "Loose", description: "no job", job_ids: [], created_at: "2026-09-02T00:00:00Z" });
	make("loose-b", { title: "Loose too", description: "no job", job_ids: [], created_at: "2026-09-02T01:00:00Z" });
	assert.deepEqual(reportsView(state, () => {}, Date.parse(AT)).reports.map((r) => r.slug), ["beta-rev2", "loose-b", "loose-a", "alpha"]);
});

test("GET /api/reports serves the projection and /boards/ redirects to the reports page", async (t) => {
	const options = fixture(t);
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, options.host, resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	const url = `http://127.0.0.1:${options.port}`;

	const response = await fetch(`${url}/api/reports`);
	assert.equal(response.status, 200);
	const data = (await response.json()) as ReportsResponse;
	assert.deepEqual(data.reports.map((r) => r.slug), ["beta", "alpha"], "newest first, invalid board skipped");

	const redirect = await fetch(`${url}/boards/`, { redirect: "manual" });
	assert.equal(redirect.status, 302);
	assert.equal(redirect.headers.get("location"), "/#reports");
});

test("Reports renders each report's link and job id, no copy-URL box, or the empty line", async () => {
	const built = await build({
		stdin: {
			contents: 'import {h} from "preact"; import render from "preact-render-to-string"; import {Reports} from "./viewer-app/screens/Reports.tsx"; export const screen=d=>render(h(Reports,{data:d}));',
			loader: "tsx",
			resolveDir: REPO_ROOT,
		},
		bundle: true, write: false, platform: "node", format: "esm", jsx: "automatic", jsxImportSource: "preact", loader: { ".css": "empty" },
	});
	const { screen } = (await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`)) as {
		screen(data: ReportsResponse): string;
	};

	assert.match(screen({ generated_at: AT, reports: [] }), /No published reports yet/);

	const html = screen({
		generated_at: AT,
		reports: [{ slug: "alpha", title: "Alpha report", description: "the first", created_at: "2026-09-01T00:00:00Z", job_ids: ["cp-1"], href: "/boards/alpha/" }],
	});
	assert.match(html, /href="\/boards\/alpha\/"/);
	assert.match(html, /target="_blank"/);
	assert.match(html, /the first/);
	assert.match(html, /href="#job\/cp-1"/);
	assert.match(html, /<div class="reports-grid"><article class="job-row"/, "cards sit in the grid container desktop lays out");
	assert.doesNotMatch(html, /overview-reply|<code[^>]*>[^<]*\/boards\/alpha\/<\/code>|Copy/, "no copy-URL box: the title already links");
	assert.doesNotMatch(html, /<script|style=|onclick=/i);
});
