/**
 * Retained from tests/settings.test.ts (P16b): `readOwnerConsistently` needs a loader that rewrites its own file mid-read,
 * the import guard is structural, and `loadBudgetConfig`'s bad-JSON ContractError has no e2e consumer that surfaces it.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { loadBudgetConfig } from "../src/budget-config.ts";
import { ContractError, DEFAULT_BUDGET_CONFIG, LAYOUT, type SettingFileOwner } from "../src/contracts.ts";
import { readOwnerConsistently } from "../src/settings.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const OWNER_FILE: Record<SettingFileOwner, string> = {
	"mandate-defaults": LAYOUT.mandateDefaultsFile,
	budgets: LAYOUT.budgetsFile,
	"worker-bounds": LAYOUT.workerBoundsFile,
	parent: `${LAYOUT.data}/parent.json`,
	operator: `${LAYOUT.data}/operator.json`,
	gate: LAYOUT.gateConfigFile,
	quality: `${LAYOUT.data}/quality.json`,
	capacity: `${LAYOUT.data}/capacity.json`,
	update: `${LAYOUT.data}/update.json`,
	routing: LAYOUT.routingFile,
	viewer: `${LAYOUT.data}/viewer.json`,
};

function scratch(t: TestContext): string {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	return home.path;
}

const ownerFile = (home: string, owner: SettingFileOwner) => join(home, OWNER_FILE[owner]);
const write = (home: string, owner: SettingFileOwner, body: unknown) =>
	writeFileSync(ownerFile(home, owner), typeof body === "string" ? body : JSON.stringify(body));
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test("(i) readOwnerConsistently: one rewrite mid-load is retried to valid; a file that never settles is unstable", (t) => {
	const home = scratch(t);
	const file = join(home, "owner.json");
	writeFileSync(file, "a");
	let calls = 0;
	const once = readOwnerConsistently(file, () => {
		if (calls++ === 0) writeFileSync(file, "b");
		return readFileSync(file, "utf8");
	});
	assert.deepEqual({ state: once.state, sha256: once.sha256, result: once.result }, { state: "valid", sha256: sha("b"), result: "b" });
	let n = 0;
	const never = readOwnerConsistently(file, () => writeFileSync(file, String(n++)));
	assert.equal(never.state, "unstable");
	assert.match(never.error ?? "", /changed while it was read/);
});


function sourceFiles(dir: string): string[] {
	return readdirSync(join(REPO_ROOT, dir), { recursive: true, encoding: "utf8" })
		.filter((name) => name.endsWith(".ts") && !name.includes("node_modules"))
		.map((name) => join(REPO_ROOT, dir, name));
}

const specifiers = (text: string) => [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1] as string);

test("(l) import guard: only src/settings-control.ts and src/settings-write.ts import src/settings.ts; the contract imports only siblings", () => {
	const target = join(REPO_ROOT, "src/settings.ts");
	const allowlist: string[] = ["src/settings-control.ts", "src/settings-write.ts"];
	const importers = [...sourceFiles("src"), ...sourceFiles("extensions")].filter((file) =>
		specifiers(readFileSync(file, "utf8")).some((spec) => spec.startsWith(".") && resolve(dirname(file), spec) === target),
	);
	assert.deepEqual(importers.map((file) => relative(REPO_ROOT, file)).sort(), allowlist, "PR2's importers, named explicitly");
	const contract = specifiers(readFileSync(join(REPO_ROOT, "src/contracts/settings.ts"), "utf8"));
	assert.ok(contract.length > 0);
	for (const spec of contract) {
		assert.ok(spec === "typebox" || spec === "@earendil-works/pi-ai" || /^\.\/[\w-]+\.ts$/.test(spec), `src/contracts/settings.ts imports ${spec}`);
	}
});

test("(m) loadBudgetConfig keeps CommandPost.budgets()'s outcomes: default, ContractError, contract violation", (t) => {
	const home = scratch(t);
	assert.equal(loadBudgetConfig(home), DEFAULT_BUDGET_CONFIG);
	write(home, "budgets", "{nope");
	assert.throws(() => loadBudgetConfig(home), ContractError);
	write(home, "budgets", { ...DEFAULT_BUDGET_CONFIG, spawn_cap: 0 });
	assert.throws(() => loadBudgetConfig(home), (error: Error) => !(error instanceof ContractError) && error.message.includes("violates the budget contract"));
});
