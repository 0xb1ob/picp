import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { referencedMaterial } from "../src/task-references.ts";
import type { CommandRunner } from "../src/merge-ask.ts";

function setup(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "task-refs-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home"), clone = join(root, "clone"), worktree = join(root, "worktree");
	for (const path of [home, clone, worktree, join(home, LAYOUT.state)]) mkdirSync(path, { recursive: true });
	return { home, clone, worktree, project: "demo", prefix: "tracker", root };
}

/** The project's own clone-local DB, as dispatch resolves it; bare bead refs need one. */
function withDb<T extends { clone: string }>(options: T): T & { beadsDb: string } {
	return { ...options, beadsDb: join(options.clone, ".beads", "beads.db") };
}

const exec: CommandRunner = async (_command, args) => {
	assert.ok(args.includes("show"), "prefix selection must not depend on br config");
	const id = args[args.indexOf("show") + 1];
	if (id === "tracker-missing") throw new Error("not found");
	return JSON.stringify([{ id, title: "A title", status: "open", description: "Exact description\nsecond line" }]);
};

test("resolves own-prefix beads and pinned external refs once, preserving text", async (t) => {
	const options = setup(t);
	const material = await referencedMaterial({ ...options, task: "Use tracker-abc twice: tracker-abc; ignore other-abc", externalRef: "br --db '/some path/beads.db' show tracker-abc --json", exec: async (command, args, opts) => {
		if (args.includes("show")) assert.deepEqual(args, ["--db", "/some path/beads.db", "--no-auto-flush", "--no-auto-import", "show", "tracker-abc", "--json"]);
		return exec(command, args, opts);
	} });
	assert.match(material, /Referenced material/);
	assert.match(material, /tracker-abc\nTitle: A title\nStatus: open\nDescription:\nExact description\nsecond line/);
	assert.equal(material.match(/### tracker-abc/g)?.length, 1);
	assert.ok(!material.includes("other-abc"));
});

test("missing beads and unavailable br are explicit nonfatal material", async (t) => {
	const options = withDb(setup(t));
	assert.match(await referencedMaterial({ ...options, task: "tracker-missing", exec }), /tracker-missing:.*not found/);
	assert.match(await referencedMaterial({ ...options, task: "tracker-abc", exec: async () => { throw new Error("ENOENT"); } }), /br unavailable:.*ENOENT/);
});

test("unavailable br names a custom-prefix bead even without another reference", async (t) => {
	const material = await referencedMaterial({ ...withDb(setup(t)), prefix: "custom-tracker", task: "Implement custom-tracker-abc.", exec: async () => {
		throw new Error("spawn br ENOENT");
	} });
	assert.match(material, /## Referenced material/);
	assert.match(material, /custom-tracker-abc: br unavailable: Error: spawn br ENOENT/);
});

test("br down never turns read-only or follow-up prose into references", async (t) => {
	const options = { ...setup(t), exec: async () => { throw new Error("spawn br ENOENT"); } };
	assert.equal(await referencedMaterial({ ...options, task: "Make a read-only view and a follow-up." }), "");
	const material = await referencedMaterial({ ...withDb(options), task: "Make tracker-abc read-only with a follow-up; ignore other-abc." });
	assert.match(material, /tracker-abc: br unavailable: Error: spawn br ENOENT/);
	assert.doesNotMatch(material, /### (read-only|follow-up)|other-abc/);
});

test("external files are inlined; worktree and state paths including symlinks are excluded", async (t) => {
	const options = setup(t);
	const outside = join(options.root, "requirements with spaces.md");
	const local = join(options.worktree, "local.md"), state = join(options.home, ".pi-command-post/state", "secret.md");
	// Legacy-layout negative fixture: a top-level state/ is not the home's state any more (cp-u3i2).
	const legacy = join(options.home, "state", "legacy.md");
	mkdirSync(join(options.home, "state"), { recursive: true });
	writeFileSync(outside, "External requirements\nverbatim.");
	writeFileSync(local, "LOCAL"); writeFileSync(state, "STATE"); writeFileSync(legacy, "LEGACY");
	const alias = join(options.root, "alias.md"); symlinkSync(state, alias);
	const material = await referencedMaterial({ ...options, task: `Read \`${outside}\`, ${local} and ${state} and ${alias} and ${legacy}.`, exec });
	assert.match(material, /External requirements\nverbatim\./);
	assert.ok(!material.includes("LOCAL") && !material.includes("STATE"));
	assert.ok(material.includes("LEGACY"), "a top-level state/ file is an ordinary external reference");
	assert.match(await referencedMaterial({ ...options, task: `${options.root}/missing.md`, exec }), /missing.md:.*ENOENT/);
});

test("reference count and UTF-8 bytes are bounded with explicit truncation", async (t) => {
	const options = withDb(setup(t));
	let calls = 0;
	const material = await referencedMaterial({ ...options, task: Array.from({ length: 12 }, (_, i) => `tracker-${i}`).join(" "), exec: async () => {
		calls++;
		return JSON.stringify({ title: "Title", status: "open", description: "é".repeat(5000) });
	} });
	assert.ok(calls <= 10);
	assert.ok(Buffer.byteLength(material) <= 24 * 1024);
	assert.match(material, /truncated/);
	assert.ok(!material.includes("�"));
	const short = await referencedMaterial({ ...options, task: Array.from({ length: 12 }, (_, i) => `tracker-${i}`).join(" "), exec });
	assert.equal(short.match(/### tracker-/g)?.length, 10);
	assert.match(short, /2 references omitted; 10 reference cap/);
});

test("reads real br show JSON using the configured prefix", async (t) => {
	try {
		execFileSync("br", ["--version"], { stdio: "ignore" });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return t.skip("br must be on PATH");
		throw error;
	}
	const options = setup(t);
	const db = join(options.clone, ".beads", "beads.db");
	const env = { ...process.env, BEADS_DIR: join(options.clone, ".beads") };
	execFileSync("br", ["--db", db, "init", "--prefix", "custom-tracker"], { cwd: options.clone, env });
	const created = JSON.parse(execFileSync("br", ["--db", db, "create", "Real requirement", "--description", "The real description", "--json"], { cwd: options.clone, env, encoding: "utf8" }));
	const material = await referencedMaterial({ ...options, beadsDb: db, prefix: "custom-tracker", task: `Implement ${created.id}` });
	assert.match(material, /Title: Real requirement\nStatus: open\nDescription:\nThe real description/);
});

test("credential-shaped referenced content becomes a diagnostic, not a dispatch refusal", async (t) => {
	const options = setup(t);
	const path = join(options.root, "credentials.md");
	writeFileSync(path, "OPENAI_API_KEY=sk-" + "a".repeat(48));
	const material = await referencedMaterial({ ...options, task: path, exec });
	assert.match(material, /appears to contain/);
	assert.ok(!material.includes("a".repeat(48)));
});

test("no references leaves the task unchanged", async (t) => {
	assert.equal(await referencedMaterial({ ...setup(t), task: "Bump x in src/app.ts.", exec }), "");
});

test("bead responses accept legacy objects and diagnose malformed output", async (t) => {
	const options = withDb(setup(t));
	for (const raw of ["null", "[]", "[null]", "{}", "not JSON"]) {
		assert.match(await referencedMaterial({ ...options, task: "tracker-abc", exec: async () => raw }), /tracker-abc: br unavailable:/);
	}
	assert.match(await referencedMaterial({ ...options, task: "tracker-abc", exec: async () => JSON.stringify({ title: "Legacy", status: "open", description: "Text" }) }), /Title: Legacy\nStatus: open\nDescription:\nText/);
});

test("bare references use only the resolved project database, never the home's", async (t) => {
	const options = setup(t);
	mkdirSync(join(options.home, ".beads"));
	writeFileSync(join(options.home, ".beads", "beads.db"), "");
	const never: CommandRunner = async () => { throw new Error("br must not run without a project database"); };
	const none = await referencedMaterial({ ...options, task: "tracker-abc", externalRef: "br show tracker-def --json", exec: never });
	assert.equal(none, "", "no bead snapshot and no BEADS_DIR line from the home database");
	const projectDb = join(options.root, "connected", "beads.db");
	const local = await referencedMaterial({ ...options, beadsDb: projectDb, task: "tracker-abc", exec: async (command, args, opts) => {
		assert.equal(args[1], projectDb);
		return exec(command, args, opts);
	} });
	assert.match(local, /Title: A title/);
	assert.ok(local.includes(`BEADS_DIR points to \`${join(options.root, "connected")}\``));
});
