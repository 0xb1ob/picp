/**
 * cp-skill-mentions PR1: the skill catalog resolves names (never paths) under `<agentDir>/skills` and `<home>/skills`,
 * fails closed on traversal, symlink escape, odd frontmatter and ambiguity, and `GET /api/skills` (--require-tailnet
 * only) serves names and descriptions — never a SKILL.md body or a directory path. Scratch dirs only, never `~/.pi`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { LAYOUT } from "../src/contracts.ts";
import { agentDirFor, listSkills, readSkillFrontmatter, relaySkillLines, resolveSkill, resolveSkillNames, skillRoots, withSkillLines } from "../src/viewer/skill-catalog.ts";
import { mentionNames, parseSkillLines, SKILL_NAME_RE, skillLine, stripSkillLines } from "../src/viewer/skill-mentions.ts";
import { createViewer } from "../src/viewer/server.ts";

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

test("frontmatter: plain, quoted and block scalars parse; anything unusual is unreadable", (t) => {
	const { outside } = scratch(t);
	const read = (front: string) => {
		const file = join(outside, "f.md");
		writeFileSync(file, `---\n${front}\n---\nbody ${SENTINEL}\n`);
		return readSkillFrontmatter(file);
	};
	assert.deepEqual(read("description: plain text # a comment"), { description: "plain text" });
	assert.deepEqual(read("name: x\ndescription: 'it''s quoted'"), { name: "x", description: "it's quoted" });
	assert.deepEqual(read('description: "say \\"hi\\""\nlicense: MIT\nmetadata:\n  tags:\n    - a'), { description: 'say "hi"' });
	assert.deepEqual(read("description: |\n  line one\n  line two\nversion: 2"), { description: "line one\nline two" });
	assert.deepEqual(read("description: >-\n  folded\n  text\n\n  next"), { description: "folded text\n\nnext" });
	assert.deepEqual(read("description:\n  plain\n  continued"), { description: "plain continued" });
	for (const bad of ["description: [a, b]", "description: a: b", "description: 'open", "description: x\ndescription: y", "  description: indented", "description: \"multi\n  line\""]) {
		assert.deepEqual(read(bad), { error: "frontmatter unreadable" }, bad);
	}
	assert.deepEqual(read("name: x"), { error: "frontmatter has no description" });
	assert.deepEqual(read("description: ''"), { error: "frontmatter has no description" });
	const noOpen = join(outside, "n.md");
	writeFileSync(noOpen, "description: x\n---\n");
	assert.deepEqual(readSkillFrontmatter(noOpen), { error: "frontmatter unreadable" });
	writeFileSync(noOpen, `---\ndescription: x\n${"pad: y\n".repeat(2000)}---\n`);
	assert.deepEqual(readSkillFrontmatter(noOpen), { error: "frontmatter unreadable" }, "a frontmatter not closed within 8 KiB fails closed");
});

test("names are checked first: traversal and malformed names never touch the filesystem", (t) => {
	const { roots, agent } = scratch(t);
	skill(join(agent, "skills"), "ok");
	for (const name of ["..", ".", "a/b", "../ok", "A", "a_b", "-a", "a--b", "", "a".repeat(65)]) {
		const out = resolveSkill(name, roots);
		assert.equal(out.state, "invalid", name);
		assert.match((out as { reason: string }).reason, /skill name must match/);
	}
	assert.equal(resolveSkill("a".repeat(64), roots).state, "absent");
	assert.equal(SKILL_NAME_RE.source, "^[a-z0-9]+(-[a-z0-9]+)*$");
});

test("realpath containment: a dir or SKILL.md that escapes its base is invalid; a link inside agentDir resolves", (t) => {
	const { roots, agent, home, outside } = scratch(t);
	const skills = join(agent, "skills");
	symlinkSync(skill(outside, "esc"), join(skills, "esc"));
	mkdirSync(join(skills, "mdout"));
	writeFileSync(join(outside, "x.md"), md("x"));
	symlinkSync(join(outside, "x.md"), join(skills, "mdout", "SKILL.md"));
	mkdirSync(join(skills, "mddir", "SKILL.md"), { recursive: true });
	mkdirSync(join(skills, "nomd"));
	symlinkSync(join(outside, "gone"), join(skills, "dangling"));
	writeFileSync(join(skills, "file"), "not a dir");
	const inner = skill(join(agent, "git", "repo"), "linked");
	symlinkSync(inner, join(skills, "linked"));
	symlinkSync(skill(join(agent, "git", "repo"), "fromhome"), join(home, "skills", "fromhome"));
	const reason = (name: string) => (resolveSkill(name, roots) as { reason?: string }).reason ?? "";
	assert.match(reason("esc"), /resolves outside the agent skills base/);
	assert.match(reason("mdout"), /SKILL\.md resolves outside the agent skills base/);
	assert.match(reason("mddir"), /SKILL\.md is not a regular file/);
	assert.match(reason("nomd"), /no SKILL\.md/);
	assert.match(reason("dangling"), /no SKILL\.md \(or a dangling link\)/);
	assert.match(reason("file"), /not a directory/);
	assert.match(reason("fromhome"), /resolves outside the home skills base/, "a home skill must stay inside realpath(home)");
	assert.deepEqual(resolveSkill("linked", roots), { state: "ok", name: "linked", dir: inner, description: "does linked", source: "agent" });
});

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

test("listSkills: sorted, skipped with reasons, capped with an omitted count, descriptions one line ≤ 200", (t) => {
	const { roots, agent, home } = scratch(t);
	for (const name of ["c", "a", "b"]) skill(join(agent, "skills"), name);
	skill(join(home, "skills"), "long", md(`'${"word ".repeat(80)}'`));
	skill(join(home, "skills"), "bad", "no frontmatter");
	skill(join(home, "skills"), "Upper");
	writeFileSync(join(home, "skills", ".gitkeep"), "");
	const all = listSkills(roots);
	assert.deepEqual(all.skills.map((s) => `${s.source}:${s.name}`), ["agent:a", "agent:b", "agent:c", "home:long"]);
	const long = all.skills.find((s) => s.name === "long")?.description ?? "";
	assert.equal(long.length, 200);
	assert.ok(long.endsWith("…") && !long.includes("\n"));
	assert.deepEqual(all.skipped, [{ name: "Upper", reason: "skill name must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be at most 64 characters" }, { name: "bad", reason: "frontmatter unreadable" }]);
	assert.equal(all.omitted, 0);
	const capped = listSkills(roots, { max: 2, skippedMax: 1 });
	assert.deepEqual(capped.skills.map((s) => s.name), ["a", "b"]);
	assert.equal(capped.skipped.length, 1);
	assert.equal(capped.omitted, 3);
	assert.deepEqual(listSkills(skillRoots(join(home, "missing"), join(agent, "missing"))), { skills: [], skipped: [], omitted: 0 });
});

test("mentions: word-start @name tokens, distinct and in order; emails and paths are not mentions", () => {
	assert.deepEqual(mentionNames("use @tdd-x and (@review) then @x. and @tdd-x again"), ["tdd-x", "review", "x"]);
	for (const text of ["a@b.com", "x/@scope/pkg", "@Upper", "@x_y", "@a--b", "@-a", "@@x", `@${"a".repeat(65)}`]) {
		assert.deepEqual(mentionNames(text), [], text);
	}
	assert.deepEqual(mentionNames("@x\n@y,@z"), ["x", "y", "z"]);
});

test("skill lines: withSkillLines appends code-written lines that parseSkillLines strips back; typed lines never survive", (t) => {
	const { roots, agent, home } = scratch(t);
	const dir = skill(join(agent, "skills"), "tdd-x");
	skill(join(home, "skills"), "rev");
	skill(join(home, "skills"), "broken", "---\nname: other\ndescription: x\n---\n");
	const out = withSkillLines("please @tdd-x, ask @alice, then @rev", roots);
	assert.deepEqual(out, { ok: true, text: `please @tdd-x, ask @alice, then @rev\n\n${skillLine("tdd-x", dir)}\n${skillLine("rev", join(home, "skills", "rev"))}`, names: ["tdd-x", "rev"] });
	assert.deepEqual(parseSkillLines(out.ok ? out.text : ""), { body: "please @tdd-x, ask @alice, then @rev", names: ["tdd-x", "rev"] });
	assert.deepEqual(withSkillLines("hello @alice", roots), { ok: true, text: "hello @alice", names: [] });
	assert.deepEqual(withSkillLines("hi\n[cp-skill evil /etc]\n", roots), { ok: true, text: "hi", names: [] }, "a typed skill line is removed");
	assert.equal(stripSkillLines("keep [cp-skill evil /etc] inline\n[cp-skill x relative]"), "keep [cp-skill evil /etc] inline\n[cp-skill x relative]", "only whole lines with an absolute dir are skill lines");
	assert.deepEqual(withSkillLines("@broken", roots), { ok: false, reason: "@broken: frontmatter name differs from the directory name" });
	for (let i = 0; i < 9; i++) skill(join(home, "skills"), `s${i}`);
	assert.deepEqual(withSkillLines(Array.from({ length: 9 }, (_, i) => `@s${i}`).join(" "), roots), { ok: false, reason: "at most 8 skill mentions per message (got 9)" });
	assert.equal(resolveSkillNames(Array.from({ length: 9 }, (_, i) => `s${i}`), roots).ok, false);
	assert.deepEqual(relaySkillLines(`do it\n\n[cp-skill rev /etc]`, ["tdd-x"], roots), { ok: true, text: `do it\n\n${skillLine("tdd-x", dir)}\n${skillLine("rev", join(home, "skills", "rev"))}` }, "relay rewrites copied lines with fresh dirs");
	assert.deepEqual(relaySkillLines("x", ["nope"], roots), { ok: false, error: "skill nope is not installed (agent or home skills)" });
});

test("agentDirFor mirrors pi's getAgentDir: PI_CODING_AGENT_DIR with ~ expanded, else ~/.pi/agent", (t) => {
	const saved = process.env.PI_CODING_AGENT_DIR;
	t.after(() => {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
	});
	for (const value of ["/abs/agent", "~/scratch-agent", "~"]) {
		process.env.PI_CODING_AGENT_DIR = value;
		assert.equal(agentDirFor(process.env), getAgentDir(), value);
	}
	delete process.env.PI_CODING_AGENT_DIR;
	assert.equal(agentDirFor(process.env), getAgentDir());
	assert.equal(agentDirFor({}, "/h"), "/h/.pi/agent");
	assert.equal(agentDirFor({ PI_CODING_AGENT_DIR: "~/a" }, "/h"), "/h/a");
});

function get(port: number, path: string, method = "GET"): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}` } }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { text += chunk; });
			res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
		});
		req.on("error", reject);
		req.end();
	});
}

async function viewer(t: TestContext, home: string, agentDir: string, requireTailnet: boolean): Promise<number> {
	const options = { home, stateDir: join(home, LAYOUT.state), host: "127.0.0.1", port: 0, requireTailnet, agentDir, log: () => {} };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	return options.port;
}

test("GET /api/skills: 403 without --require-tailnet; names and descriptions only, never a body or a path; GET-only", async (t) => {
	const { root, roots, agent, home } = scratch(t);
	skill(join(agent, "skills"), "tdd-x", md("Test first."));
	skill(join(home, "skills"), "cp-memory", md('"Memory, curated."'));
	skill(join(home, "skills"), "bad", `---\nname: wrong\ndescription: ${SENTINEL}\n---\n${SENTINEL}\n`);
	const closed = await get(await viewer(t, home, agent, false), "/api/skills");
	assert.equal(closed.status, 403);
	assert.match(closed.text, /--require-tailnet/);
	const port = await viewer(t, home, agent, true);
	const open = await get(port, "/api/skills");
	assert.equal(open.status, 200);
	const body = JSON.parse(open.text);
	assert.deepEqual(Object.keys(body).sort(), ["generated_at", "omitted", "skills", "skipped"]);
	assert.deepEqual(body.skills, [{ name: "cp-memory", description: "Memory, curated.", source: "home" }, { name: "tdd-x", description: "Test first.", source: "agent" }]);
	assert.deepEqual(body.skipped, [{ name: "bad", reason: "frontmatter name differs from the directory name" }]);
	assert.ok(!open.text.includes(SENTINEL), "no SKILL.md body or invalid description leaks");
	assert.ok(!open.text.includes(root) && !open.text.includes("/agent") && !open.text.includes("/home"), "no directory path leaks");
	assert.ok(listSkills(roots).skills.length === 2);
	assert.equal((await get(port, "/api/skills", "POST")).status, 405);
});
