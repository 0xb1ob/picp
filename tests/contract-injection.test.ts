/**
 * The parent's operating contract reaches the model even when pi did not load
 * it (D8): a persisted `operating_contract` prompt section set in before_agent_start,
 * skipped when AGENTS.md is already among the context files.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSessionHooks } from "../extensions/command-post/session-hooks.ts";
import { createSessionPost } from "../extensions/command-post/session-post.ts";
import { createSessionState } from "../extensions/command-post/shared.ts";
import { createWakeupSurfaces } from "../extensions/command-post/wakeup-surfaces.ts";
import { CommandPost } from "../src/command-post.ts";
import type { Runtime } from "../src/contracts.ts";
import { PACKAGE_ROOT } from "../src/home.ts";
import {
	CONTRACT_SECTION,
	contractInjection,
	contractInjectionOrNone,
	ModeError,
	packageContractLoaded,
} from "../src/mode.ts";
import { createScratchHome } from "./harness/index.ts";

const MULTI: Runtime = { mode: "multi", home: "/h", source: "checkout", reason: "r" };

function packageWithContract(text = "# Command Post\n\nYou are the parent.\n"): { root: string; cleanup(): void } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "cp-pkg-")));
	writeFileSync(join(root, "AGENTS.md"), text);
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("returns the contract text when pi did not load it", (t) => {
	const pkg = packageWithContract();
	t.after(pkg.cleanup);
	const result = contractInjection({ contextFiles: [{ path: "/some/project/AGENTS.md" }] }, { packageRoot: pkg.root, runtime: MULTI });
	assert.deepEqual(result, { contract: "# Command Post\n\nYou are the parent.\n" });
});

test("returns undefined when the package's AGENTS.md is already a context file (also through a symlink)", (t) => {
	const pkg = packageWithContract();
	t.after(pkg.cleanup);
	assert.equal(contractInjection({ contextFiles: [{ path: join(pkg.root, "AGENTS.md") }] }, { packageRoot: pkg.root, runtime: MULTI }), undefined);
	const link = join(tmpdir(), `cp-link-${process.pid}`);
	symlinkSync(pkg.root, link);
	t.after(() => rmSync(link, { force: true }));
	assert.equal(contractInjection({ contextFiles: [{ path: join(link, "AGENTS.md") }] }, { packageRoot: pkg.root, runtime: MULTI }), undefined);
});

test("a missing contract file injects nothing; readContract is injectable", () => {
	assert.equal(contractInjection({}, { packageRoot: "/nonexistent", runtime: MULTI }), undefined);
	const result = contractInjection({}, { packageRoot: "/nonexistent", runtime: MULTI, readContract: () => "FROM TEST" });
	assert.equal(result?.contract, "FROM TEST");
});

test("a refused runtime injects nothing and never throws (before_agent_start runs on every prompt)", (t) => {
	const pkg = packageWithContract("CONTRACT");
	t.after(pkg.cleanup);
	let asked = 0;
	const refused = () => {
		asked += 1;
		throw new ModeError("single-project mode was removed; the command post runs multi-project homes only");
	};

	// The regression: the hook called the resolver uncaught, so the refusal that
	// session_start had already reported was raised again from inside the hook.
	assert.doesNotThrow(() => contractInjectionOrNone({}, { packageRoot: pkg.root, runtime: refused }));
	assert.equal(contractInjectionOrNone({}, { packageRoot: pkg.root, runtime: refused }), undefined);
	assert.equal(asked, 2, "the getter is called per hook, and its failure is swallowed each time");

	// A resolved runtime is unchanged: the wrapper only guards the lookup.
	assert.equal(contractInjectionOrNone({}, { packageRoot: pkg.root, runtime: () => MULTI })?.contract, "CONTRACT");
	// It is also skipped for the same reason the direct call is.
	assert.equal(
		contractInjectionOrNone({ contextFiles: [{ path: join(pkg.root, "AGENTS.md") }] }, { packageRoot: pkg.root, runtime: () => MULTI }),
		undefined,
	);
});

test("packageContractLoaded compares realpaths: a project's own AGENTS.md is not this package's", (t) => {
	const pkg = packageWithContract("CONTRACT");
	t.after(pkg.cleanup);
	const project = realpathSync(mkdtempSync(join(tmpdir(), "cp-proj-")));
	t.after(() => rmSync(project, { recursive: true, force: true }));
	writeFileSync(join(project, "AGENTS.md"), "# the project's own contract\n");

	assert.equal(packageContractLoaded(undefined, pkg.root), false);
	assert.equal(packageContractLoaded([], pkg.root), false);
	// The bug this replaces: `endsWith("/AGENTS.md")` said true here, which both
	// skipped the injection and silenced the missing-contract warning.
	assert.equal(packageContractLoaded([{ path: join(project, "AGENTS.md") }], pkg.root), false);
	assert.equal(packageContractLoaded([{ path: join(pkg.root, "AGENTS.md") }], pkg.root), true);

	const link = join(tmpdir(), `cp-pkglink-${process.pid}`);
	symlinkSync(pkg.root, link);
	t.after(() => rmSync(link, { force: true }));
	assert.equal(packageContractLoaded([{ path: join(link, "AGENTS.md") }], pkg.root), true, "through a symlink too");

	// And the injection agrees: a project AGENTS.md never suppresses it.
	const injected = contractInjection({ contextFiles: [{ path: join(project, "AGENTS.md") }] }, { packageRoot: pkg.root, runtime: MULTI });
	assert.equal(injected?.contract, "CONTRACT");
});

// N1 (cp-c1ur): a returned systemPrompt applied to user prompts only; wake turns (sendMessage, no hook) ran on a
// different prefix and rebuilt the prompt cache inside its TTL. The hook now writes a persisted section and returns
// nothing, so every turn replays the same section bytes.
test("N1: before_agent_start persists the contract as a prompt section and returns no systemPrompt", async (t) => {
	const home = createScratchHome();
	const previous = { home: process.env.CP_HOME, mode: process.env.CP_MODE };
	process.env.CP_HOME = home.path;
	process.env.CP_MODE = "multi";
	const post = new CommandPost({ home: home.path, packageRoot: PACKAGE_ROOT });
	t.after(async () => {
		await post.shutdown();
		for (const [key, value] of [["CP_HOME", previous.home], ["CP_MODE", previous.mode]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		home.cleanup();
	});
	let hook: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
	const pi = {
		on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) { if (name === "before_agent_start") hook = handler; },
		registerEntryRenderer() {},
	} as unknown as ExtensionAPI;
	const state = createSessionState();
	state.post = post;
	const wakeups = createWakeupSurfaces(pi, state, { commandPost: () => post, repaintWidget: () => {} });
	registerSessionHooks(pi, state, createSessionPost(pi, state, wakeups), wakeups);
	assert.ok(hook);
	const turn = async () => {
		const event = { systemPrompt: "BASE", systemPromptOptions: { contextFiles: [], sections: {} as Record<string, string> } };
		assert.equal(await hook!(event, { hasUI: false }), undefined, "no per-turn systemPrompt override");
		return event.systemPromptOptions.sections;
	};
	const first = await turn();
	assert.equal(first[CONTRACT_SECTION], readFileSync(join(PACKAGE_ROOT, "AGENTS.md"), "utf8"));
	assert.deepEqual(await turn(), first, "byte-identical on every turn");
	assert.match(CONTRACT_SECTION, /^[a-z][a-z0-9_-]*$/, "a name pi accepts for a section");
});
