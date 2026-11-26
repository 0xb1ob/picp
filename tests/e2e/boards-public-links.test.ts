/**
 * cp-boards-public-url-reports: the dashboard's board links (Reports, Schedules `board_href` and run cards, decision
 * and session `read`) through a real `bin/cp-view`, before and after Settings writes `boards_public_url`, no restart.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import { publishResponseReport, responseReportSlug } from "../../src/response-reports.ts";
import { openScheduleRunStore } from "../../src/schedule-runs.ts";
import { applySettings } from "../../src/settings-write.ts";
import { readSettings } from "../../src/settings.ts";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import { readScheduleFile } from "../../src/viewer/schedule-core.ts";
import { policyFromLegacy } from "../../src/viewer/schedule-policy.ts";
import { dashboard } from "../harness/dashboard.ts";

const SCHEDULE = "sch-abc123", JOB = "cp-sched1", SOURCE = "legacy:ans-0123456789ab", AT = "2026-09-01T00:00:00Z";
const RUN = "run-20260921040001-abcdef";
const OPERATOR = "#sessions?view=you&transcript=1";
const TEMPLATE = {
	seed_mandate_id: "md-seed1", channel: "operator_chat", objective: "nightly", expiry_hours: 24, spend_usd: 10,
	spend_tokens: 500000, job_cap: 2, allowed_actions: ["plan"], ask_on: ["merge", "risk:high"],
	approval: { operator_quote: "Yes, nightly.", decided_by: "operator-quote", approved_at: AT },
};
type Json = Record<string, any>;

/** A board for a scheduled job, a response report, an ask and a bridge notice citing the board, all on disk. */
function seed(stateDir: string, home: string) {
	const board = join(stateDir, "boards", "alpha");
	mkdirSync(join(board, "site"), { recursive: true });
	writeFileSync(join(board, "board.json"), JSON.stringify({ title: "Alpha", job_ids: [JOB], created_at: AT }));
	writeFileSync(join(board, "site", "index.html"), "<h1>Alpha</h1>");
	publishResponseReport(home, { project: "demo", question: "q", answer: "a long answer", source: SOURCE, time: AT });
	const schedule = {
		id: SCHEDULE, name: "nightly", project: "demo", mandate_id: "md-abcdef", trigger: { type: "manual" },
		job: { title: "nightly", kind: "research", delivery: "board" }, enabled: true, created_at: AT,
		grant_template: TEMPLATE,
	};
	writeFileSync(join(stateDir, "schedules.json"), JSON.stringify({ schema_version: 1, schedules: [schedule] }));
	const job = { id: JOB, title: "nightly", status: "closed", labels: [`schedule:${SCHEDULE}`], created_at: AT };
	writeFileSync(join(home, LAYOUT.jobsFile), JSON.stringify({ schema_version: 1, jobs: [job] }));
	new OperatorAsks(join(stateDir, "operator", "asks.jsonl")).open({ project: "demo", question: "Ship it?",
		options: [{ label: "yes", consequence: "go" }], recommendation: "yes", evidence_paths: ["state/boards/alpha/"] });
	const notice = ["[cp-bridge wake job=cp-sched1 receipt=owner_observed]", "The nightly board is up.", "paths:",
		`- ${stateDir}/boards/alpha/`].join("\n");
	const session = join(home, "pi-sessions", "chat.jsonl");
	mkdirSync(join(home, "pi-sessions"), { recursive: true });
	writeFileSync(session, `${JSON.stringify({ type: "custom_message", timestamp: "2026-09-02T14:00:00Z",
		customType: "cp-bridge", display: true, content: notice })}\n`);
	mkdirSync(join(stateDir, "sessions"), { recursive: true });
	const registry = operatorSessionsFile(join(stateDir, "sessions"));
	writeFileSync(registry, `${JSON.stringify({ at: AT, session_file: session })}\n`);
}

/** One closed run whose delivered result card links the response report, through the run store's own writes. */
async function runCard(home: string, stateDir: string, report: string) {
	const saved = readScheduleFile(join(stateDir, "schedules.json"))[0]!;
	const runs = openScheduleRunStore(home);
	const policy = policyFromLegacy(saved, saved.grant_template!);
	const provenance = { channel: "migration" as const, legacy_seed: policy.provenance.legacy_seed };
	await runs.savePolicyRevision(policy, { at: "2026-09-20T00:00:00Z", provenance });
	await runs.createRun({ schema_version: 1, id: RUN, schedule_id: SCHEDULE, policy_revision: 1, policy,
		trigger: { via: "slot", at: "2026-09-21T04:00:01Z" }, anchor_job_id: null, members: [], phase: "accepted",
		outcome: null, started_at: "2026-09-21T04:00:01Z", deadline_at: "2026-09-22T04:00:10Z", risk_preapproved: [],
		authority_log: [], cap_notices: [] });
	await runs.closeRun(RUN, "completed", "2026-09-21T04:06:00Z");
	runs.editRun(RUN, (row) => {
		row.result = { source_key: "k1", job_id: null, generation: 1, outcome: "completed", headline: "done", links: [],
			at: "2026-09-21T04:05:00Z", answer_id: null, delivered_at: "2026-09-21T04:05:30Z", report_href: report };
	});
}

test("boards-public-links: Reports, Schedules, decision and session read links follow boards_public_url per request",
	{ timeout: 180_000 }, async (t) => {
		const d = await dashboard(t, { seed }); // --require-tailnet: the operator transcript is served only under it
		const report = `/boards/${responseReportSlug(SOURCE)}/`;
		await runCard(d.home, d.stateDir, report);
		const links = async () => {
			const reports = (await d.get("/api/reports")).body as Json;
			const schedules = (await d.get("/api/schedules")).body as Json;
			const decisions = (await d.get("/api/decisions")).body as Json;
			const item = schedules.schedules?.[0];
			const row = item?.history?.find((j: Json) => j.id === JOB);
			return {
				reports: (reports.reports as Json[]).map((r) => r.href).sort(),
				board_href: row?.board_href ?? `no history row: ${JSON.stringify(schedules)}`,
				card: item?.runs?.find((r: Json) => r.run_id === RUN)?.card?.report_href ?? `no card: ${JSON.stringify(item)}`,
				read: (decisions.items as Json[])[0]?.evidence?.[0]?.read ?? `no evidence: ${JSON.stringify(decisions.items)}`,
			};
		};
		const on = (origin: string) => ({
			reports: [`${origin}/boards/alpha/`, `${origin}${report}`].sort(),
			board_href: `${origin}/boards/alpha/`, card: `${origin}${report}`, read: `${origin}/boards/alpha/`,
		});
		/** The rendered `read` links: the decision card's, then the session notice's, as [href, target, rel]. */
		const readLinks = async () => {
			const attrs = (a: Element) => [a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")];
			const decisions = await d.open("#decisions");
			const decision = await decisions.find(".decision-card-evidence a", (a) => a.textContent === "read");
			const chat = await d.open(OPERATOR);
			chat.click(await chat.find(".session-notice-line"));
			const session = await chat.find(".session-notice-paths a", (a) => a.textContent === "read");
			return [attrs(decision), attrs(session)];
		};
		const set = (value: string | null) => applySettings(d.home, {
			request: { mode: "set", changes: { "boards.public_url": value } }, dry_run: false,
			expected_revision: readSettings(d.home).revision, request_id: "boards-links-1", peer: null, actor: "dashboard",
		});
		const viewerFile = join(d.home, LAYOUT.data, "viewer.json");
		const viewerJson = (value: object) => writeFileSync(viewerFile, JSON.stringify(value));

		assert.deepEqual(await links(), on(""), "unset: every board link stays relative");
		const relative = ["/boards/alpha/", null, null];
		assert.deepEqual(await readLinks(), [relative, relative], "a relative board read link keeps today's same tab");

		assert.equal(set("https://boards.example.test").state, "applied");
		assert.deepEqual(await links(), on("https://boards.example.test"), "no trailing slash: one slash joins");
		const away = ["https://boards.example.test/boards/alpha/", "_blank", "noopener noreferrer"];
		assert.deepEqual(await readLinks(), [away, away], "a read link on the boards origin opens a new tab");

		assert.equal(set("https://boards2.example.test/x/").state, "applied");
		assert.deepEqual(await links(), on("https://boards2.example.test/x"), "trailing slash and a path: one slash");

		// A run card's report_href is only ever a /boards/ path: the run store refuses any other value, and one written
		// by hand fails the whole projection by name rather than reaching a card (so it is never re-based either).
		const runsFile = join(d.stateDir, "schedule-runs.json"), runs = readFileSync(runsFile, "utf8");
		writeFileSync(runsFile, runs.replace(report, `https://elsewhere.example.test${report}`));
		const refused = (await d.get("/api/schedules")).body as Json;
		assert.deepEqual([refused.schedules, /report_href/.test(String(refused.error))], [[], true], String(refused.error));
		writeFileSync(runsFile, runs);

		viewerJson({ boards_public_url: "ftp://boards.example.test/" });
		assert.deepEqual(await links(), on(""), "an invalid value: relative, as unset");
		viewerJson({});
		assert.equal(set("https://boards.example.test/").state, "applied");
		assert.equal(set(null).state, "applied");
		assert.deepEqual(await links(), on(""), "cleared through Settings: relative again");
	});
