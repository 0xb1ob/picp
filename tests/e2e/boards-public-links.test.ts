/**
 * cp-boards-public-url-reports: the dashboard's own board links (Reports, Schedules `board_href`, a decision's evidence
 * `read`) through a real `bin/cp-view`, before and after Settings writes `boards_public_url`, with no viewer restart.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import { publishResponseReport, responseReportSlug } from "../../src/response-reports.ts";
import { applySettings } from "../../src/settings-write.ts";
import { readSettings } from "../../src/settings.ts";
import { dashboard } from "../harness/dashboard.ts";

const SCHEDULE = "sch-abc123", JOB = "cp-sched1", SOURCE = "legacy:ans-0123456789ab", AT = "2026-09-01T00:00:00Z";
type Json = Record<string, any>;

/** A board for a scheduled job, a response report, one open ask citing the board, all on disk before the viewer. */
function seed(stateDir: string, home: string) {
	const board = join(stateDir, "boards", "alpha");
	mkdirSync(join(board, "site"), { recursive: true });
	writeFileSync(join(board, "board.json"), JSON.stringify({ title: "Alpha", job_ids: [JOB], created_at: AT }));
	writeFileSync(join(board, "site", "index.html"), "<h1>Alpha</h1>");
	publishResponseReport(home, { project: "demo", question: "q", answer: "a long answer", source: SOURCE, time: AT });
	const schedule = {
		id: SCHEDULE, name: "nightly", project: "demo", mandate_id: "md-abcdef", trigger: { type: "manual" },
		job: { title: "nightly", kind: "research", delivery: "board" }, enabled: true, created_at: AT,
	};
	writeFileSync(join(stateDir, "schedules.json"), JSON.stringify({ schema_version: 1, schedules: [schedule] }));
	const job = { id: JOB, title: "nightly", status: "closed", labels: [`schedule:${SCHEDULE}`], created_at: AT };
	writeFileSync(join(home, LAYOUT.jobsFile), JSON.stringify({ schema_version: 1, jobs: [job] }));
	new OperatorAsks(join(stateDir, "operator", "asks.jsonl")).open({ project: "demo", question: "Ship it?",
		options: [{ label: "yes", consequence: "go" }], recommendation: "yes", evidence_paths: ["state/boards/alpha/"] });
}

test("boards-public-links: Reports, Schedules and decision read links follow boards_public_url per request",
	{ timeout: 120_000 }, async (t) => {
		const d = await dashboard(t, { requireTailnet: false, seed });
		const report = `/boards/${responseReportSlug(SOURCE)}/`;
		const links = async () => {
			const reports = (await d.get("/api/reports")).body as Json;
			const schedules = (await d.get("/api/schedules")).body as Json;
			const decisions = (await d.get("/api/decisions")).body as Json;
			const row = schedules.schedules?.[0]?.history?.find((j: Json) => j.id === JOB);
			return {
				reports: (reports.reports as Json[]).map((r) => r.href).sort(),
				board_href: row?.board_href ?? `no history row: ${JSON.stringify(schedules)}`,
				read: (decisions.items as Json[])[0]?.evidence?.[0]?.read ?? `no evidence: ${JSON.stringify(decisions.items)}`,
			};
		};
		const on = (origin: string) => ({
			reports: [`${origin}/boards/alpha/`, `${origin}${report}`].sort(),
			board_href: `${origin}/boards/alpha/`, read: `${origin}/boards/alpha/`,
		});
		const set = (value: string | null) => applySettings(d.home, {
			request: { mode: "set", changes: { "boards.public_url": value } }, dry_run: false,
			expected_revision: readSettings(d.home).revision, request_id: "boards-links-1", peer: null, actor: "dashboard",
		});
		const viewerFile = join(d.home, LAYOUT.data, "viewer.json");
		const viewerJson = (value: object) => writeFileSync(viewerFile, JSON.stringify(value));

		assert.deepEqual(await links(), on(""), "unset: every board link stays relative");

		assert.equal(set("https://boards.example.test").state, "applied");
		assert.deepEqual(await links(), on("https://boards.example.test"), "no trailing slash: one slash joins");
		const tab = await d.open("#decisions");
		const read = await tab.find(".decision-card-evidence a", (a) => a.textContent === "read");
		assert.deepEqual([read.getAttribute("href"), read.getAttribute("target"), read.getAttribute("rel")],
			["https://boards.example.test/boards/alpha/", "_blank", "noopener noreferrer"], "a board read opens a new tab");

		assert.equal(set("https://boards2.example.test/x/").state, "applied");
		assert.deepEqual(await links(), on("https://boards2.example.test/x"), "trailing slash and a path: one slash");

		viewerJson({ boards_public_url: "ftp://boards.example.test/" });
		assert.deepEqual(await links(), on(""), "an invalid value: relative, as unset");
		viewerJson({});
		assert.equal(set("https://boards.example.test/").state, "applied");
		assert.equal(set(null).state, "applied");
		assert.deepEqual(await links(), on(""), "cleared through Settings: relative again");
	});
