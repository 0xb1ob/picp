import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FAILURE_CLASSES, FAILURE_RECOVERABLE, STATE_WAKEUP_ANNOUNCEMENTS } from "../src/contracts.ts";
import { FAILURE_CLASS_WAKEUP, WAKEUP_CUSTOM_TYPES } from "../src/wakeups.ts";
import { REPO_ROOT } from "./harness/index.ts";

const DOCS = readFileSync(join(REPO_ROOT, "docs/contracts.md"), "utf8");
const AGENTS = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");

test("every announced transition names a wake-up kind, and the docs table lists it", () => {
	const kinds = new Set<string>(Object.keys(WAKEUP_CUSTOM_TYPES));
	const seen = new Set<string>();
	assert.ok(STATE_WAKEUP_ANNOUNCEMENTS.length > 0);
	for (const row of STATE_WAKEUP_ANNOUNCEMENTS) {
		assert.ok(row.event.length > 0, "event name missing");
		assert.ok(row.wakeup === "none" || kinds.has(row.wakeup), `${row.event} has unknown kind ${row.wakeup}`);
		assert.match(DOCS, new RegExp(`\\| \`${row.event}\``), `docs/contracts.md table misses ${row.event}`);
		if (row.wakeup !== "none") seen.add(row.wakeup);
	}
	for (const kind of kinds) {
		assert.ok(seen.has(kind), `wake-up kind ${kind} is never announced`);
	}
});

test("every failed announcement and terminal class names an emitter scenario", () => {
	const classes: Record<string, string> = {
		tool_loop: "S21-intake", budget_exceeded: "S21-budget", settled_without_report: "S21-unreported",
		model_call_failed: "S21-budget", wall_clock_exceeded: "S21-clock", tool_call_cap_exceeded: "S21-bound",
		spawn_failed: "S21-host", script_exit: "script_exit", script_signal: "script_signal",
	};
	const registry = readFileSync(join(REPO_ROOT, "docs/testing-migration/s21.md"), "utf8");
	const scripts = readFileSync(join(REPO_ROOT, "tests/e2e/script-jobs-p8e.test.ts"), "utf8");
	const events: Record<string, string> = {
		worker_death: "S21-intake", hard_bound: "S21-bound", envelope_invalid: "S21-intake",
		budget_exceeded: "S21-budget", model_call_failed: "S21-budget", reconcile_unsalvageable: "S21-restart",
	};
	for (const cls of FAILURE_CLASSES) {
		if (FAILURE_RECOVERABLE[cls]) continue;
		const scenario = classes[cls];
		assert.ok(scenario, `${cls} needs an exercised emitter scenario in S21`);
		assert.ok(scenario.startsWith("S21-") ? registry.includes(`| ${scenario} |`) : scripts.includes(scenario),
			`${cls} emitter evidence is missing`);
		assert.notEqual(FAILURE_CLASS_WAKEUP[cls], "none");
	}
	for (const row of STATE_WAKEUP_ANNOUNCEMENTS) {
		if (!("to" in row) || row.to !== "failed") continue;
		assert.notEqual(row.wakeup, "none");
		assert.ok(events[row.event] && registry.includes(`| ${events[row.event]} |`),
			`${row.event} needs an exercised emitter scenario in S21`);
	}
});

test("markFailed is only called from fleet.ts and the failure announcer", () => {
	const hits: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name === "dist") continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			if (!entry.name.endsWith(".ts")) continue;
			if (readFileSync(path, "utf8").includes("markFailed(")) hits.push(path.slice(REPO_ROOT.length + 1));
		}
	};
	walk(join(REPO_ROOT, "src"));
	walk(join(REPO_ROOT, "extensions"));
	hits.sort();
	assert.deepEqual(hits, ["src/failure-announcer.ts", "src/fleet.ts"]);
});

test("AGENTS.md tells the parent to act on death and recovery wake-ups", () => {
	assert.match(AGENTS, /cp-death/);
	assert.match(AGENTS, /cp-recovery/);
	assert.match(AGENTS, /act on the wake-up/i);
	assert.doesNotMatch(AGENTS, /A worker that died: restart the parent to reconcile/);
});

test("a spent bound's wake-up phrase is unambiguous, and AGENTS.md names it (cur.4.4)", () => {
	assert.match(AGENTS, /bound spent/, "AGENTS.md's cp-bound bullet must name the exhausted phrase");
	assert.match(
		DOCS,
		/one automatic attempt was already made and did not stick/,
		"docs/contracts.md must quote BOUND_SPENT_PHRASE's own wording, not a stale copy",
	);
});

test("no doc or notice claims a previewed attempt 'did not stick' (zh7.4)", () => {
	assert.doesNotMatch(DOCS, /attempted, did not stick/, "docs/contracts.md still quotes the preview-derived claim");
	assert.doesNotMatch(AGENTS, /attempted, did not stick/);
	assert.match(DOCS, /settleBound/, "docs/contracts.md must name the post-outcome bound announcement");
	assert.match(AGENTS, /cp-bound.{0,400}after (its|the) outcome/s, "AGENTS.md must say the cp-bound wake arrives after the outcome");
});
