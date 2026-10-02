/**
 * cp-project-grouped-reporting: every wake-up and escalation message opens
 * with its bracketed project, and anything spanning several projects is split
 * into one section per project.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAnsweredNotice } from "../src/answered.ts";
import { type CiObservation, formatCiNotice } from "../src/ci-watch.ts";
import type { AnsweredDecision, Escalation } from "../src/contracts.ts";
import { escalateToolText } from "../extensions/command-post/index.ts";
import {
	durableWakeupProjects,
	groupByProject,
	projectResolver,
	projectTag,
	UNKNOWN_PROJECT,
	withProjectTag,
} from "../src/project-report.ts";
import { formatWedgedNotice, type WedgedToolCall } from "../src/wedged.ts";
import {
	formatRecoveryNotice,
	type JobWakeupFacts,
	reviewWakeups,
	STALE_WAKEUP_HEADLINE,
	type WakeupCarrier,
	type WakeupKind,
	type WakeupMessage,
	WakeupNotifier,
	type WakeupStamp,
} from "../src/wakeups.ts";

const PROJECTS: Record<string, string> = {
	"cp-78vu": "demo-app",
	"cp-78vw": "demo-app",
	"cp-atl1": "atlas",
};
const projectOf = (jobId: string) => PROJECTS[jobId];
const T = "2026-09-20T10:00:00Z";

/** Every job is fresh for the kind the test sends about it. */
function facts(overrides: Record<string, Partial<JobWakeupFacts>> = {}) {
	return {
		job: (jobId: string): JobWakeupFacts => ({
			phase: "held",
			generation: 1,
			alive: true,
			run_phase: "working",
			...overrides[jobId],
		}),
	};
}

function notifier(sent: WakeupMessage[], f = facts()) {
	return new WakeupNotifier({ facts: f, send: (message) => sent.push(message), projectOf, now: () => new Date(T) });
}

test("tag helpers: bracketed, deduplicated, idempotent, unknown named", () => {
	assert.equal(projectTag(["a"]), "[a]");
	assert.equal(projectTag(["a", "b", "a"]), "[a, b]");
	assert.equal(projectTag([undefined]), `[${UNKNOWN_PROJECT}]`);
	assert.equal(withProjectTag(["a"], "cp-1: done"), "[a] cp-1: done");
	assert.equal(withProjectTag(["a"], "[a] cp-1: done"), "[a] cp-1: done");
	assert.deepEqual(
		groupByProject(["x1", "y1", "x2"], (id) => (id.startsWith("x") ? "x" : "y")),
		[["x", ["x1", "x2"]], ["y", ["y1"]]],
	);
});

test("resolver: fleet record, then project: label, then the mandate naming the job, then the only active mandate project", () => {
	const resolve = projectResolver({
		fleet: (id) => (id === "cp-f" ? "from-fleet" : undefined),
		ledger: (id) => (id === "cp-f" || id === "cp-l" ? "from-label" : undefined),
		mandates: () => [
			{ projects: ["named"], job_ids: ["cp-m"], status: "paused" },
			{ projects: ["solo"], status: "active" },
		],
	});
	assert.equal(resolve("cp-f"), "from-fleet");
	assert.equal(resolve("cp-l"), "from-label");
	assert.equal(resolve("cp-m"), "named");
	assert.equal(resolve("cp-other"), "solo");
	const ambiguous = projectResolver({ mandates: () => [{ projects: ["a", "b"], status: "active" }] });
	assert.equal(ambiguous("cp-x"), undefined);
	const broken = projectResolver({
		fleet: () => {
			throw new Error("unreadable");
		},
		ledger: () => "label",
	});
	assert.equal(broken("cp-x"), "label");
});

test("every single-job wake-up kind opens with its project", () => {
	const sent: WakeupMessage[] = [];
	const f = facts({
		"cp-78vu": { reported_at: T },
		"cp-78vw": { run_phase: "idle" },
	});
	const cases: Array<[WakeupKind, string, Partial<WakeupStamp>]> = [
		["envelope", "cp-78vu", { generation: 1, reported_at: T }],
		["verdict", "cp-atl1", {}],
		["ci", "cp-atl1", {}],
		["bound", "cp-atl1", {}],
		["death", "cp-atl1", {}],
		["wedged", "cp-atl1", {}],
		["unreported", "cp-78vw", {}],
		["answered", "cp-atl1", { keys: ["aw-1"] }],
		// Mandate 80%/cap notices travel as a durable `recovery` wake-up with a job_id.
		["recovery", "cp-atl1", {}],
	];
	for (const [kind, jobId, extra] of cases) {
		const result = notifier(sent, f).send({ kind, job_id: jobId, ...extra }, `${jobId}: ${kind} happened`);
		assert.equal(result.sent, true, `${kind} was sent`);
		const content = sent.at(-1)?.content ?? "";
		assert.ok(content.startsWith(`[${PROJECTS[jobId]}] ${jobId}: ${kind} happened`), `${kind}: ${content}`);
		assert.deepEqual(result.stamp.projects, [PROJECTS[jobId]]);
	}
	notifier(sent).send({ kind: "death", job_id: "cp-nobody" }, "cp-nobody: died");
	assert.equal(sent.at(-1)?.content, `[${UNKNOWN_PROJECT}] cp-nobody: died`);
});

test("a multi-project wake-up opens with every project and splits its rows into one section per project", () => {
	const observations = [
		{ job_id: "cp-78vu", event: "ci_green", head_sha: "a".repeat(40), reason: "green" },
		{ job_id: "cp-atl1", event: "ci_failed", head_sha: "b".repeat(40), reason: "red" },
		{ job_id: "cp-78vw", event: "ci_green", head_sha: "c".repeat(40), reason: "green" },
	] as CiObservation[];
	const text = formatCiNotice(observations, projectOf);
	const sent: WakeupMessage[] = [];
	notifier(sent).send({ kind: "ci", projects: ["demo-app", "atlas"] }, text);
	const lines = (sent[0]?.content ?? "").split("\n");
	assert.match(lines[0]!, /^\[demo-app, atlas\] CI\/PR OBSERVED/);
	assert.equal(lines[1], "  [demo-app]");
	assert.match(lines[2]!, /^ {4}cp-78vu: CI green/);
	assert.match(lines[3]!, /^ {4}cp-78vw: CI green/);
	assert.equal(lines[4], "  [atlas]");
	assert.match(lines[5]!, /^ {4}cp-atl1: CI RED/);
});

test("wedged, answered and recovery notices group by project; one project renders unsectioned", () => {
	const call = (job_id: string) =>
		({ job_id, tool: "bash", running_seconds: 3600, idle_seconds: 3600, worktree: "/w", branch: job_id, model: "m", threshold_seconds: 1800 }) as WedgedToolCall;
	const wedged = formatWedgedNotice([call("cp-78vu"), call("cp-atl1")], projectOf).split("\n");
	assert.deepEqual([wedged[1], wedged[3]], ["  [demo-app]", "  [atlas]"]);
	assert.equal(formatWedgedNotice([call("cp-78vu"), call("cp-78vw")], projectOf).includes("[demo-app]"), false);

	const decision = (id: string, job_id: string) =>
		({ id, type: "approval", job_id, decision: "merge?", answer: "approve", answered_by: "operator", answered_at: T }) as AnsweredDecision;
	const answered = formatAnsweredNotice([decision("aw-1", "cp-atl1"), decision("aw-2", "cp-78vu")], projectOf).split("\n");
	assert.deepEqual([answered[1], answered[3]], ["  [atlas]", "  [demo-app]"]);

	const recovery = formatRecoveryNotice(
		[
			{ job_id: "cp-78vu", outcome: "revivable", detail: "d", resumable: true },
			{ job_id: "cp-atl1", outcome: "orphan", detail: "d", resumable: false },
		],
		projectOf,
	).split("\n");
	assert.deepEqual([recovery[1], recovery[3]], ["  [demo-app]", "  [atlas]"]);
});

test("a stale or replayed rewrite keeps the project tag of the wake-up it replaces", () => {
	const stamp = (kind: WakeupKind, extra: Partial<WakeupStamp> = {}): WakeupStamp => ({
		kind,
		job_id: "cp-78vu",
		projects: ["demo-app"],
		issued_at: T,
		...extra,
	});
	const carrier = (s: WakeupStamp): WakeupCarrier => ({
		role: "custom",
		customType: "x",
		content: "[demo-app] cp-78vu: news",
		details: { cp_wakeup: s },
	});
	// The envelope was archived (no reported_at): stale.
	const stale = reviewWakeups([carrier(stamp("envelope", { generation: 1 }))], facts(), new Date(T));
	assert.ok(
		String(stale.messages[0]?.content).startsWith(`[demo-app] ${STALE_WAKEUP_HEADLINE} (cp-78vu)`),
		String(stale.messages[0]?.content),
	);
	const answered = stamp("answered", { keys: ["aw-9"] });
	const replay = reviewWakeups([carrier(answered), carrier(answered)], facts(), new Date(T));
	assert.match(String(replay.messages[1]?.content), /^\[demo-app\] REPLAYED WAKE-UP/);
});

const MANDATES: Record<string, string[]> = { "md-demo": ["demo-app"], "md-pair": ["demo-app", "atlas"] };
const mandateProjects = (id: string) => MANDATES[id];

test("a jobless mandate 80%/cap notice is tagged with its mandate's own projects, not its keys", () => {
	const entry = { id: "mandate-usage:md-demo:cap", kind: "recovery", keys: ["not-a-job"], content: "MANDATE CAP — md-demo paused (spend_cap)" };
	const projects = durableWakeupProjects(entry, projectOf, mandateProjects);
	assert.deepEqual(projects, ["demo-app"]);
	const sent: WakeupMessage[] = [];
	const result = notifier(sent).send({ kind: "recovery", keys: entry.keys, ...(projects ? { projects } : {}) }, entry.content);
	assert.equal(result.sent, true);
	assert.equal(sent[0]?.content.startsWith("[demo-app] MANDATE CAP — md-demo"), true, sent[0]?.content);
	assert.deepEqual(durableWakeupProjects({ id: "mandate-usage:md-pair:warn-usd", kind: "recovery" }, projectOf, mandateProjects), ["demo-app", "atlas"]);
	// A notice with a job_id is the notifier's to resolve; restart recovery still names its jobs.
	assert.equal(durableWakeupProjects({ id: "mandate-usage:md-demo:cap", kind: "recovery", job_id: "cp-atl1" }, projectOf, mandateProjects), undefined);
	assert.deepEqual(durableWakeupProjects({ id: "recovery:cp-78vu,cp-atl1", kind: "recovery", keys: ["cp-78vu", "cp-atl1"] }, projectOf, mandateProjects), ["demo-app", "atlas"]);
});

test("cp_escalate's result opens with its jobs' project, else its mandate's projects", () => {
	const raised = (job_ids: string[], mandate_id: string) =>
		({ id: "esc-1", kind: "scope_expansion", status: "open", question: "widen it?", job_ids, mandate_id }) as unknown as Escalation;
	assert.equal(escalateToolText(raised(["cp-atl1"], "md-demo"), projectOf, mandateProjects), "[atlas] esc-1 [scope_expansion] open: widen it?");
	assert.equal(escalateToolText(raised([], "md-demo"), projectOf, mandateProjects), "[demo-app] esc-1 [scope_expansion] open: widen it?");
	assert.equal(escalateToolText(raised(["cp-nobody"], "md-pair"), projectOf, mandateProjects), "[demo-app, atlas] esc-1 [scope_expansion] open: widen it?");
	assert.equal(escalateToolText(raised([], "no mandate"), projectOf, mandateProjects), `[${UNKNOWN_PROJECT}] esc-1 [scope_expansion] open: widen it?`);
});
