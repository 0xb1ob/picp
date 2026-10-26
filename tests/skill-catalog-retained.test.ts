/**
 * Retained from tests/skill-catalog.test.ts (P16b, narrowed in P16c): `resolveSkillNames`'s "named twice" and `never`
 * refusals are unreachable, since the bridge dedupes names and no product caller passes `never`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { resolveSkillNames, skillRoots } from "../src/viewer/skill-catalog.ts";

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

test("resolveSkillNames refuses a name given twice and a name on the never list", (t) => {
	const { roots, home } = scratch(t);
	const homeOnly = skill(join(home, "skills"), "mine", md("mine", "name: mine\n"));
	assert.deepEqual(resolveSkillNames(["mine", "mine"], roots), { ok: false, error: "skill mine is named twice" });
	assert.deepEqual(resolveSkillNames(["mine"], roots, ["mine"]), { ok: false, error: "skill mine is never given to workers" });
	assert.deepEqual(resolveSkillNames(["mine"], roots), { ok: true, skills: [{ name: "mine", dir: homeOnly }] });
});
