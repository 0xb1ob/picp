/**
 * Retained from tests/skill-catalog.test.ts (P16b): `resolveSkill`/`resolveSkillNames` called directly; "named twice"
 * and the `never` list are unreachable, since the bridge dedupes names and no product caller passes `never`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { resolveSkill, resolveSkillNames, skillRoots } from "../src/viewer/skill-catalog.ts";

const SENTINEL = "BODY-SENTINEL-7f3c do not leak";

function scratch(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "cp-skills-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agent = join(root, "agent");
	const home = join(root, "home");
	const outside = join(root, "outside");
	for (const dir of [join(agent, "skills"), join(home, "skills"), outside]) mkdirSync(dir, { recursive: true });
	return { root, agent, home, outside, roots: skillRoots(home, agent) };
}

const md = (description: string, extra = "") => `---\n${extra}description: ${description}\n---\n\n# Body\n\n${SENTINEL}\n`;
function skill(dir: string, name: string, text = md(`does ${name}`)): string {
	mkdirSync(join(dir, name), { recursive: true });
	writeFileSync(join(dir, name, "SKILL.md"), text);
	return join(dir, name);
}

test("ambiguity, name mismatch and an empty description are refused with a named reason", (t) => {
	const { roots, agent, home } = scratch(t);
	skill(join(agent, "skills"), "both");
	skill(join(home, "skills"), "both");
	skill(join(home, "skills"), "mismatch", md("x", "name: other\n"));
	skill(join(home, "skills"), "empty", "---\ndescription:\n---\n");
	const homeOnly = skill(join(home, "skills"), "mine", md("mine", "name: mine\n"));
	assert.match((resolveSkill("both", roots) as { reason: string }).reason, /ambiguous/);
	assert.match((resolveSkill("mismatch", roots) as { reason: string }).reason, /frontmatter name differs/);
	assert.match((resolveSkill("empty", roots) as { reason: string }).reason, /no description/);
	assert.deepEqual(resolveSkill("mine", roots), { state: "ok", name: "mine", dir: homeOnly, description: "mine", source: "home" });
	assert.deepEqual(resolveSkill("nope", roots), { state: "absent" });
	assert.deepEqual(resolveSkillNames(["mine", "both"], roots), { ok: false, error: "skill both: present under both the agent and home skills roots (ambiguous)" });
	assert.deepEqual(resolveSkillNames(["nope"], roots), { ok: false, error: "skill nope is not installed (agent or home skills)" });
	assert.deepEqual(resolveSkillNames(["mine", "mine"], roots), { ok: false, error: "skill mine is named twice" });
	assert.deepEqual(resolveSkillNames(["mine"], roots, ["mine"]), { ok: false, error: "skill mine is never given to workers" });
	assert.deepEqual(resolveSkillNames(["../x"], roots).ok, false);
	assert.deepEqual(resolveSkillNames(["mine"], roots), { ok: true, skills: [{ name: "mine", dir: homeOnly }] });
});
