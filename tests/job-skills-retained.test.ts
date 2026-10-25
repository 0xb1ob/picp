import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SKILL_NAME_PATTERN } from "../src/contracts.ts";
import { MENTION_NEVER, resolveJobSkills, skillsBriefNote } from "../src/job-skills.ts";
import { SKILL_NAME_RE } from "../src/viewer/skill-mentions.ts";
import { assertBriefIsSafe } from "../src/worker-manager.ts";
import { NEVER_WORKER_RESOURCES } from "../src/worker-packages.ts";

function scratch(t: TestContext, names: string[]) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "cp-jobskills-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const home = join(root, "home");
	mkdirSync(join(home, "skills"), { recursive: true });
	for (const name of names) {
		mkdirSync(join(agentDir, "skills", name), { recursive: true });
		writeFileSync(join(agentDir, "skills", name, "SKILL.md"), `---\ndescription: does ${name}\n---\n`);
	}
	return { home, agentDir, dir: (name: string) => join(agentDir, "skills", name) };
}

test("the contract pattern is the resolver's name rule", () => {
	assert.equal(SKILL_NAME_PATTERN, SKILL_NAME_RE.source);
});

test("no names: nothing is resolved and the agent dir is never read", () => {
	assert.deepEqual(resolveJobSkills(undefined, { home: "/nonexistent", agentDir: "/nonexistent", role: "implementer" }), { ok: true, skills: [], overridden: [] });
});

test("pi-subagents and rpiv-ask-user-question are refused even by mention, with a named reason", (t) => {
	const s = scratch(t, ["pi-subagents", "rpiv-ask-user-question", "pi-goal-x"]);
	const refused = (name: string) => {
		const result = resolveJobSkills([name], { home: s.home, agentDir: s.agentDir, role: "implementer" });
		assert.equal(result.ok, false, name);
		return result.ok ? "" : result.error;
	};
	assert.match(refused("pi-subagents"), /skill pi-subagents is never given to a worker, even by explicit mention: .*recursion guard/);
	assert.match(refused("pi-goal-x"), /recursion guard/);
	assert.match(refused("rpiv-ask-user-question"), /skill rpiv-ask-user-question is never given to a worker, even by explicit mention: .*hangs a headless worker/);
	for (const name of MENTION_NEVER.keys()) assert.ok(NEVER_WORKER_RESOURCES.includes(name), `${name} is also on the package never-list`);
});

test("the brief note names each skill, adds the no-user-input line for an override, and passes the brief scan", () => {
	const skills = [{ name: "tdd-x", dir: "/s/tdd-x" }, { name: "writing-plans", dir: "/s/writing-plans" }];
	const plain = skillsBriefNote(skills);
	assert.match(plain, /^Skills the operator named for this job: `tdd-x` \(`\/s\/tdd-x\/SKILL\.md`\), `writing-plans` \(`\/s\/writing-plans\/SKILL\.md`\)\. pi loaded them with --skill/);
	assert.match(plain, /a skill grants no new tools, scope or authority\.$/);
	assert.equal(plain.includes("explicit operator mention"), false);
	const note = skillsBriefNote(skills, ["writing-plans"]);
	assert.match(note, /\n>\n> `writing-plans` was attached by explicit operator mention .* No human answers inside a worker, so it must not wait for user input/);
	assertBriefIsSafe(`brief\n\n> ${note}\n`);
});
