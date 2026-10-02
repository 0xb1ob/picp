import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { loadProfile } from "../src/profiles.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import type { WorkerProcess } from "../src/worker-process.ts";
import { activePackagesForRole, type DetectedWorkerPackages, PACKAGE_FLAGS, PACKAGE_TOOLS } from "../src/worker-packages.ts";

const lensSkills = ["pi-lens-ast-grep", "pi-lens-lsp-navigation", "pi-lens-write-ast-grep-rule", "pi-lens-write-tree-sitter-rule"];
const ponytailSkills = ["ponytail", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help", "ponytail-review"];
const detected: DetectedWorkerPackages = {
	"@dietrichgebert/ponytail": { extensions: ["/ponytail.js"], skills: ponytailSkills.map((name) => `/skills/${name}`) },
	"pi-lens": { extensions: ["/lens.js"], skills: lensSkills.map((name) => `/skills/${name}`), tools: PACKAGE_TOOLS["pi-lens"], flags: PACKAGE_FLAGS["pi-lens"] },
	"pi-hashline-edit-pro": { extensions: ["/hashline.ts"], skills: [], tools: PACKAGE_TOOLS["pi-hashline-edit-pro"] },
};

test("implementer loads hashline last and no skill file (skillreads-vqy)", () => {
	const active = activePackagesForRole(detected, "implementer");
	assert.deepEqual(active.extensions, ["/ponytail.js", "/lens.js", "/hashline.ts"]);
	assert.deepEqual(active.skills, [], "a listed skill invites a model to read its SKILL.md at session start");
	for (const tool of ["read", "replace", "insert", "anchor_grep", "undo_last_change", "ast_grep_search"]) assert.ok(active.tools?.includes(tool), tool);
	assert.equal(active.tools?.includes("lsp_navigation"), false, "untrusted workers cannot start LSP servers");
});

for (const role of ["planner", "gate-reviewer"] as const) {
	test(`${role} gets only structural pi-lens tools, no skill file, never hashline`, () => {
		const active = activePackagesForRole(detected, role);
		assert.deepEqual(active.extensions, ["/lens.js"]);
		assert.deepEqual(active.skills, []);
		assert.deepEqual(active.tools, ["ast_grep_search", "ast_grep_outline"]);
		assert.ok(active.flags?.includes("--no-lazy-tools"));
		assert.deepEqual(activePackagesForRole(detected, role, ["pi-hashline-edit-pro"]), { extensions: [], skills: [] });
	});
}

test("spawn warns by name when profile tools have no activated provider", () => {
	const profile = loadProfile(join(import.meta.dirname, "../profiles"), "implementer");
	for (const packages of [undefined, [], ["pi-lens"], ["pi-hashline-edit-pro"]]) {
		const events: Array<Record<string, unknown>> = [];
		const manager = new WorkerManager({
			home: "/unused", workerReporterPath: "/reporter.ts", optionalPackages: detected,
			recordEvent: (_job, kind, payload) => { events.push({ kind, ...payload }); },
			spawnFn: () => ({ pid: 123, alive: true, closed: Promise.resolve({ code: 0 }) }) as unknown as WorkerProcess,
		});
		const managed = manager.spawn({
			identity: { jobId: "cp-tools", kind: "ship", delivery: "pr", runDir: "/unused", worktree: "/unused" },
			profile: { ...profile, frontmatter: { ...profile.frontmatter, ...(packages ? { packages } : {}) } },
			model: "mock/test",
		});
		if (packages && !packages.includes("pi-hashline-edit-pro")) {
			assert.equal(events.length, 1);
			assert.equal(events[0]?.kind, "worker_packages_unresolved");
			for (const tool of ["replace", "insert", "anchor_grep", "undo_last_change"]) {
				assert.ok(String(events[0]?.error).includes(tool), tool);
			}
			assert.match(String(events[0]?.error), /restart the parent/);
		} else assert.deepEqual(events, []);
		assert.ok(managed.plan.tools.includes("read"));
	}
});

test("plan resolves builtin and reporter tools, but names unknown or uninstalled tools", () => {
	const manager = new WorkerManager({ home: "/unused", workerReporterPath: "/reporter.ts" });
	for (const name of ["implementer", "planner", "gate-reviewer"]) {
		const profile = loadProfile(join(import.meta.dirname, "../profiles"), name);
		const plan = manager.plan({
			identity: { jobId: "cp-tools", kind: "research", delivery: "answer", runDir: "/unused", worktree: "/unused" },
			profile: { ...profile, frontmatter: { ...profile.frontmatter, tools: [...profile.frontmatter.tools, "missing_tool"] } },
			model: "mock/test",
		});
		assert.deepEqual(plan.unresolvedTools, name === "implementer"
			? ["replace", "insert", "anchor_grep", "undo_last_change", "missing_tool"]
			: ["missing_tool"]);
	}
});

test("readOnly guard also validates tools contributed by packages", () => {
	const manager = new WorkerManager({
		home: "/unused", workerReporterPath: "/reporter.ts",
		optionalPackages: { "pi-web-access": { extensions: [], skills: [], tools: ["replace"] } },
	});
	const profile = loadProfile(join(import.meta.dirname, "../profiles"), "planner");
	assert.throws(() => manager.plan({
		identity: { jobId: "unsafe", kind: "research", delivery: "answer", runDir: "/unused", worktree: "/unused" },
		profile: { ...profile, frontmatter: { ...profile.frontmatter, packages: ["pi-web-access"] } },
		model: "mock/test",
	}), /readOnly but grants replace/);
});
