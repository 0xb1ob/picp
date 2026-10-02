/**
 * The parent's operating contract reaches the model even when pi did not load
 * it (D8): injected in before_agent_start,
 * skipped when AGENTS.md is already among the context files.
 */

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Runtime } from "../src/contracts.ts";
import {
	contractInjection,
	contractInjectionOrNone,
	ModeError,
	packageContractLoaded,
} from "../src/mode.ts";

const MULTI: Runtime = { mode: "multi", home: "/h", source: "checkout", reason: "r" };

function packageWithContract(text = "# Command Post\n\nYou are the parent.\n"): { root: string; cleanup(): void } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "cp-pkg-")));
	writeFileSync(join(root, "AGENTS.md"), text);
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("injects the contract when pi did not load it, appended after the chained prompt", (t) => {
	const pkg = packageWithContract();
	t.after(pkg.cleanup);
	const result = contractInjection(
		{ systemPrompt: "SYSTEM", contextFiles: [{ path: "/some/project/AGENTS.md" }] },
		{ packageRoot: pkg.root, runtime: MULTI },
	);
	assert.ok(result);
	assert.ok(result.systemPrompt.startsWith("SYSTEM\n\n"));
	assert.ok(result.systemPrompt.endsWith("# Command Post\n\nYou are the parent.\n"));
});

test("returns undefined when the package's AGENTS.md is already a context file (also through a symlink)", (t) => {
	const pkg = packageWithContract();
	t.after(pkg.cleanup);
	assert.equal(
		contractInjection({ systemPrompt: "S", contextFiles: [{ path: join(pkg.root, "AGENTS.md") }] }, { packageRoot: pkg.root, runtime: MULTI }),
		undefined,
	);
	const link = join(tmpdir(), `cp-link-${process.pid}`);
	symlinkSync(pkg.root, link);
	t.after(() => rmSync(link, { force: true }));
	assert.equal(
		contractInjection({ systemPrompt: "S", contextFiles: [{ path: join(link, "AGENTS.md") }] }, { packageRoot: pkg.root, runtime: MULTI }),
		undefined,
	);
});

test("a missing contract file injects nothing; readContract is injectable", () => {
	assert.equal(contractInjection({ systemPrompt: "S" }, { packageRoot: "/nonexistent", runtime: MULTI }), undefined);
	const result = contractInjection({ systemPrompt: "S" }, { packageRoot: "/nonexistent", runtime: MULTI, readContract: () => "FROM TEST" });
	assert.equal(result?.systemPrompt, "S\n\nFROM TEST");
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
	assert.doesNotThrow(() => contractInjectionOrNone({ systemPrompt: "S" }, { packageRoot: pkg.root, runtime: refused }));
	assert.equal(contractInjectionOrNone({ systemPrompt: "S" }, { packageRoot: pkg.root, runtime: refused }), undefined);
	assert.equal(asked, 2, "the getter is called per hook, and its failure is swallowed each time");

	// A resolved runtime is unchanged: the wrapper only guards the lookup.
	assert.equal(
		contractInjectionOrNone({ systemPrompt: "S" }, { packageRoot: pkg.root, runtime: () => MULTI })?.systemPrompt,
		"S\n\nCONTRACT",
	);
	// It is also skipped for the same reason the direct call is.
	assert.equal(
		contractInjectionOrNone(
			{ systemPrompt: "S", contextFiles: [{ path: join(pkg.root, "AGENTS.md") }] },
			{ packageRoot: pkg.root, runtime: () => MULTI },
		),
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
	const injected = contractInjection(
		{ systemPrompt: "S", contextFiles: [{ path: join(project, "AGENTS.md") }] },
		{ packageRoot: pkg.root, runtime: MULTI },
	);
	assert.equal(injected?.systemPrompt, "S\n\nCONTRACT");
});
