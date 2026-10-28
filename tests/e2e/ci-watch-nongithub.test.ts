/** gh CI readers skip a non-GitHub project with no forge declared; GitHub projects keep every wake. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { git, waitFor } from "../harness/index.ts";
import { SKIP, type Route, run, startStack } from "./landing-helpers.ts";

const DISABLED = "CI watch disabled: non-GitHub remote, no forge declared";

test("main CI watch: a non-GitHub project is skipped once, a GitHub project still latches and wakes on read failures", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t, { github: true });
	// The reported case: origin on a self-hosted GitLab, no `cp_project forge`; every tick used to wake on its gh failure.
	await s.project("lab", { cloneUrl: "https://gitlab.invalid/stakefish/lab.git" });
	const tip = git(s.remote, "rev-parse", "main");
	const routes: Route[] = [{ match: "api user --jq .login", replies: [{ stdout: "e2e" }] }];
	const reads = () => s.ghCalls().filter((call) => call.includes(`head_sha=${tip}`)).length;
	const journal = () => (existsSync(join(s.home, LAYOUT.state, "wakeups.json")) ? readFileSync(join(s.home, LAYOUT.state, "wakeups.json"), "utf8") : "");
	s.post.mandates.issue({ projects: ["demo", "lab"], objective: "non-GitHub CI watch e2e", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 10, tokens: 1_000_000 }, job_cap: 10 });
	s.setGh({ routes, runs: [] });
	await s.parent("Observe the CI timer.", [{ kind: "text", text: "Observing." }], async (_events, stderr) => {
		const ticks = async (count: number) => {
			const before = reads();
			await waitFor(reads, (value) => value >= before + count, { timeoutMs: 30_000, what: `${count} main CI timer reads` });
		};
		await ticks(3);
		s.setGh({ routes, runs: [run(106, tip, "completed", "failure", { event: "push", triggering_actor: { login: "e2e" } })] });
		const red = await waitFor(s.parentMessages, (body) => body.includes("MAIN IS RED — demo"), { timeoutMs: 30_000, what: "GitHub main red wakes the parent" }).catch(s.parentMessages);
		assert.ok(red.includes("MAIN IS RED — demo"), "the GitHub project still latches and wakes");
		s.setGh({ routes: [...routes, { match: "actions/runs?", replies: [{ code: 1, stderr: "HTTP 403: forbidden" }] }], runs: [] });
		const denied = await waitFor(journal, (body) => body.includes("main CI (demo)") && body.includes("403"), { timeoutMs: 30_000, what: "GitHub read failure is journaled" }).catch(journal);
		assert.ok(denied.includes("main CI (demo)") && denied.includes("403"), "a GitHub read failure still wakes");
		s.setGh({ routes: [...routes, { match: "actions/runs?", replies: [{ stdout: "not json" }] }], runs: [] });
		const changed = await waitFor(journal, (body) => body.includes("main CI (demo)") && body.includes("malformed"), { timeoutMs: 30_000, what: "a changed GitHub read failure is journaled" }).catch(journal);
		assert.ok(changed.includes("malformed"), "a changed GitHub error wakes again");
		await ticks(2);
		assert.ok(!journal().includes("main CI (lab)"), "the non-GitHub project never journals a CI failure");
		assert.ok(!s.parentMessages().includes("main CI (lab)"), "the non-GitHub project never wakes the parent");
		assert.equal(stderr().split(DISABLED).length - 1, 1, "one disabled line per project per process");
		assert.ok(stderr().includes(`lab: ${DISABLED}`), "the line names the project");
	});
});

test("held-PR, foreign-PR and merge-ask CI readers skip a non-GitHub project, a GitHub project in the same tick is read", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t, { github: true });
	// The reported shape: GitHub holds a stale copy (clone_url), the clone's origin moved to a self-hosted GitLab.
	await s.project("stale", { cloneUrl: "https://github.com/example/stale" });
	git(s.post.registry.pathOf("stale"), "remote", "set-url", "origin", "https://gitlab.invalid/stakefish/stale.git");
	const held = await s.seed("held PR on a non-GitHub project", { project: "stale", prUrl: "https://github.com/example/stale/pull/41" });
	const github = await s.seed("held PR on GitHub", { prUrl: "https://github.com/example/demo/pull/42" });
	const calls = (needle: string) => s.ghCalls().filter((call) => call.includes(needle)).length;
	const tick = await s.post.ciTick();
	assert.ok(tick.checked.includes(github.jobId), "the GitHub held PR is still read");
	assert.ok(calls("pulls/42") > 0, "gh is asked about the GitHub PR");
	assert.ok(!tick.checked.includes(held.jobId) && !tick.skipped.includes(held.jobId), "the non-GitHub held PR is not watched");
	assert.equal(calls("pulls/41"), 0, "gh is never asked about the non-GitHub held PR");
	assert.deepEqual(tick.errors.filter((error) => error.job_id === held.jobId), [], "no failure to wake on");
	assert.deepEqual(tick.observations.filter((fact) => fact.job_id === held.jobId), [], "no CI fact to wake on");
	const create = (project: string, ref: string) => s.post.ledger().create({ title: `foreign ${ref}`, project, delivery: "local", kind: "research", externalRef: ref, labels: ["schedule:sch-e2e"] });
	const foreignStale = await create("stale", "https://github.com/example/stale/pull/51");
	const foreignDemo = await create("demo", "https://github.com/example/demo/pull/52");
	const foreign = await s.post.foreignCiTick();
	assert.ok(foreign.checked.includes(foreignDemo.id), "the GitHub foreign PR is still read");
	assert.ok(calls("pulls/52") > 0, "gh is asked about the GitHub foreign PR");
	assert.ok(!foreign.checked.includes(foreignStale.id), "the non-GitHub foreign PR is not selected");
	assert.equal(calls("pulls/51"), 0, "gh is never asked about the non-GitHub foreign PR");
	assert.deepEqual(foreign.errors.filter((error) => error.job_id === foreignStale.id), []);
	const events = await s.parent("Render the requested status.", [
		{ kind: "tool_calls", calls: [{ name: "cp_status_block", args: { width: 200, awaiting: [{ type: "approval", decision: "Merge PR #41", why: "delivery", blocks: "delivery", job_id: held.jobId }] } }] },
		{ kind: "text", text: "Rendered." },
	], undefined, true);
	assert.match(JSON.stringify(events), /non-GitHub remote, no forge declared, so CI is unknown/, "the merge ask defers as unknown");
});
