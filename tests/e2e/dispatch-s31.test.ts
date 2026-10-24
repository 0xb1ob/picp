import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { paths } from "../../src/contracts.ts";
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import { readRunEvents, waitFor } from "../harness/index.ts";

for (const state of ["stale", "missing", "current", "no-lock", "failed"] as const) {
	test(`S31 dependencies: ${state} reaches a worker with its persisted outcome`, { timeout: 120_000 }, async (t) => {
		const lock = JSON.stringify({ packages: { "": {}, "node_modules/x": { version: "2.0.0" } } });
		const b = await dispatchS29(t, { files: { ".gitignore": "node_modules/\n", ...(state === "no-lock" ? {} : { "package-lock.json": lock }) } });
		const bin = join(b.home, "bin");
		mkdirSync(bin);
		const log = join(b.home, "npm-calls");
		writeFileSync(join(bin, "npm"), `#!/bin/sh\nprintf '%s %s\\n' "$PWD" "$*" >> '${log}'\n${state === "failed" ? "echo EINTEGRITY >&2; exit 1" : "exit 0"}\n`, { mode: 0o700 });
		writeFileSync(join(bin, "git"), `#!/bin/sh\n/usr/bin/git "$@" || exit $?\ncase "$*" in\n"switch --no-track -c "*) ${state === "stale" || state === "current" ? `mkdir -p node_modules; printf '%s' '${JSON.stringify({ packages: { "node_modules/x": { version: state === "stale" ? "1.0.0" : "2.0.0" } } })}' > node_modules/.package-lock.json` : ":"};;\nesac\n`, { mode: 0o700 });
		const job = await b.ledger.create({ title: state, project: "demo", delivery: "local", kind: "ship" });
		const model = b.provider.addScript(`worker-${state}`, [{ kind: "text", text: "received" }]);
		const ends = await b.run([{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Inspect dependencies.", model, queue: false, when_ready: false } }] }], { PATH: `${bin}:${process.env.PATH}` });
		assert.notEqual(ends[0]?.isError, true, JSON.stringify(ends));
		const result = ends[0]?.result.details;
		assert.equal(result?.state, "dispatched");
		assert.equal(result?.receipt, "accepted");
		const expected = state === "stale" || state === "missing" ? "installed" : state === "no-lock" ? "skipped" : state;
		const event = readRunEvents(b.home, job.id).find((event) => event.type === "deps_prepared");
		assert.equal((event?.payload as { outcome?: string } | undefined)?.outcome, expected, `dependency outcome for ${state}`);
		if (["stale", "missing", "failed"].includes(state)) assert.equal(readFileSync(log, "utf8"), `${result?.worktree} ci\n`);
		else assert.equal(existsSync(log), false, "current and no-lock dispatches must not run npm");
		await waitFor(() => b.provider.requests(`worker-${state}`), (requests) => requests.length > 0);
		const brief = readFileSync(join(b.home, paths.briefFile(job.id)), "utf8");
		if (state === "failed") {
			assert.match(brief, /Dependencies in this worktree may be stale/);
			assert.match(brief, /EINTEGRITY/);
		} else assert.doesNotMatch(brief, /Dependencies in this worktree may be stale/);
	});
}

for (const skill of ["empty", "planner", "implementer", "pi-subagents", "pi-goal-x", "rpiv-ask-user-question", "unknown", "ambiguous"] as const) {
	test(`S31 skills: ${skill}`, { timeout: 120_000 }, async (t) => {
		const b = await dispatchS29(t);
		for (const root of [b.agent.path, b.home]) {
			const dir = join(root, "skills", "dup"); mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "SKILL.md"), "---\ndescription: duplicate\n---\n");
		}
		for (const name of ["writing-plans", "pi-caveman", "tdd-x"]) {
			const dir = join(b.agent.path, "skills", name); mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n`);
		}
		const job = await b.ledger.create({ title: skill, project: "demo", delivery: "local", kind: skill === "planner" ? "research" : "ship" });
		const model = b.provider.addScript(`skill-${skill}`, [{ kind: "text", text: "received" }]);
		const names = skill === "empty" ? [] : skill === "planner" || skill === "implementer" ? ["writing-plans", "pi-caveman", "tdd-x"] : [skill === "ambiguous" ? "dup" : skill];
		const ends = await b.run([{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Inspect fixture.", model, ...(names.length ? { skills: names } : {}), queue: false, when_ready: false } }] }]);
		if (["empty", "planner", "implementer"].includes(skill)) {
			assert.equal(ends[0]?.result.details?.receipt, "accepted", JSON.stringify(ends));
			const brief = readFileSync(join(b.home, paths.briefFile(job.id)), "utf8");
			for (const name of names) assert.ok(brief.includes(join(b.agent.path, "skills", name, "SKILL.md")), name);
			const requests = await waitFor(() => b.provider.requests(`skill-${skill}`), (requests) => requests.length > 0);
			for (const name of names) assert.ok(JSON.stringify(requests[0]?.body).includes(join(b.agent.path, "skills", name)), name);
			if (skill === "planner") assert.match(brief, /`pi-caveman` was attached by explicit operator mention/);
			if (skill === "implementer") assert.doesNotMatch(brief, /`pi-caveman` was attached by explicit operator mention/);
			if (skill !== "empty") assert.match(brief, /No human answers inside a worker/);
		} else {
			assert.equal(ends[0]?.isError, true, JSON.stringify(ends));
			assert.match(JSON.stringify(ends[0]?.result), skill === "ambiguous" ? /ambiguous/ : skill === "unknown" ? /not installed/ : skill === "rpiv-ask-user-question" ? /hangs a headless worker/ : /recursion guard/);
		}
	});
}
