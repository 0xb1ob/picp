/**
 * cp-vvaz: reaching `@juicesharp/rpiv-ask-user-question` and asking one
 * questionnaire with it.
 *
 * Everything here runs with no pi, no terminal and no package: the loader is an
 * injected dependency and the "package" is a fake tool definition whose
 * `execute` returns a `QuestionnaireResult` in `details`, which is exactly the
 * contract the real one satisfies. The resolution half is tested against a
 * fake `node_modules` tree on disk, because that is where cp-4864 actually
 * failed: the bare specifier resolved against this repo's `node_modules`, the
 * operator's copy lives in pi's own package root, and the miss degraded
 * **silently** to the old countdown dialog.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { commandPostSource } from "./harness/pi-child.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	agentDir,
	askQuestionnaire,
	ASK_PACKAGE_SPECIFIER,
	ASK_TOOL_NAME,
	type AskToolDefinition,
	type AskToolLoad,
	type AskToolParams,
	type AskToolQuestionnaireResult,
	askToolCandidates,
	loadAskToolFrom,
	packageRoots,
	publicEntryIn,
} from "../extensions/command-post/questionnaire.ts";
import { buildAwaitingQuestions } from "../src/awaiting-questionnaire.ts";
import type { ResolvedAwaitingItem } from "../src/awaiting.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function item(overrides: Partial<ResolvedAwaitingItem> = {}): ResolvedAwaitingItem {
	return {
		id: "aw-1",
		type: "approval",
		decision: "Ship cp-x, drop it, or open a follow-up?",
		why: "research finished with no PR",
		blocks: "the whole pipeline",
		options: ["ship", "drop", "follow-up"],
		opened_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function questions(items: ResolvedAwaitingItem[]) {
	return buildAwaitingQuestions({ items }).questions;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
	mode?: string;
	hasUI?: boolean;
	/** Resolve a load record with no tool (package absent, or no such tool). */
	load?: AskToolLoad;
	/** Reject the loader outright. */
	loaderRejects?: boolean;
	malformedDetails?: boolean;
	throws?: boolean;
}

class Harness {
	readonly asked: AskToolParams[] = [];
	readonly ctx: ExtensionContext;
	readonly deps: { loadTool: () => Promise<AskToolLoad> };

	constructor(result: AskToolQuestionnaireResult | undefined, options: HarnessOptions) {
		this.ctx = {
			mode: options.mode ?? "tui",
			hasUI: options.hasUI ?? true,
			ui: { select: async () => undefined, input: async () => undefined, notify: () => undefined },
		} as unknown as ExtensionContext;

		const tool: AskToolDefinition = {
			name: ASK_TOOL_NAME,
			execute: async (_id, params) => {
				this.asked.push(params);
				if (options.throws) throw new Error("overlay exploded");
				if (options.malformedDetails) return { details: { nope: true } };
				return { details: result };
			},
		};

		this.deps = {
			loadTool: async () => {
				if (options.loaderRejects) throw new Error("Cannot find package");
				return options.load ?? { tool, source: "test" };
			},
		};
	}
}

function harness(result: AskToolQuestionnaireResult | undefined, options: HarnessOptions = {}): Harness {
	return new Harness(result, options);
}

// ---------------------------------------------------------------------------
// 1. One overlay, every question — the tabbed dialog, not a stack of selects
// ---------------------------------------------------------------------------

test("every question travels in one execute call, with bounded headers", async () => {
	const h = harness({
		answers: [
			{ questionIndex: 0, question: "q0", kind: "option", answer: "ship" },
			{ questionIndex: 1, question: "q1", kind: "custom", answer: "  later  " },
		],
		cancelled: false,
	});
	const built = questions([item(), item({ id: "aw-2" })]);
	const outcome = await askQuestionnaire(h.ctx, built, h.deps);
	assert.equal(h.asked.length, 1, "one overlay, not one per prompt");
	assert.equal(h.asked[0]?.questions.length, 2);
	for (const question of h.asked[0]?.questions ?? []) assert.ok(question.header.length <= 16);
	assert.deepEqual(outcome, {
		kind: "answers",
		answers: [
			{ kind: "option", label: "ship" },
			{ kind: "custom", text: "later" },
		],
	});
});

test("a question with no answer in the result is a skip, not an empty answer", async () => {
	const h = harness({ answers: [{ questionIndex: 1, question: "q1", kind: "option", answer: "drop" }], cancelled: false });
	const outcome = await askQuestionnaire(h.ctx, questions([item(), item({ id: "aw-2" })]), h.deps);
	assert.deepEqual(outcome, {
		kind: "answers",
		answers: [{ kind: "none" }, { kind: "option", label: "drop" }],
	});
});

test("a multi-select commit resolves to its first selected row", async () => {
	const h = harness({
		answers: [{ questionIndex: 0, question: "q", kind: "multi", answer: null, selected: ["drop"] }],
		cancelled: false,
	});
	const outcome = await askQuestionnaire(h.ctx, questions([item()]), h.deps);
	assert.deepEqual(outcome, { kind: "answers", answers: [{ kind: "option", label: "drop" }] });
});

test("blank free text is a skip", async () => {
	const h = harness({ answers: [{ questionIndex: 0, question: "q", kind: "custom", answer: "   " }], cancelled: false });
	const outcome = await askQuestionnaire(h.ctx, questions([item()]), h.deps);
	assert.deepEqual(outcome, { kind: "answers", answers: [{ kind: "none" }] });
});

test("Esc is cancelled, never a decline", async () => {
	const h = harness({ answers: [], cancelled: true });
	assert.deepEqual(await askQuestionnaire(h.ctx, questions([item()]), h.deps), { kind: "cancelled" });
});

// ---------------------------------------------------------------------------
// 2. Every failure is a named reason, never silence and never a throw
// ---------------------------------------------------------------------------

test("non-tui, no UI, no package, no tool, malformed, error and a throw all name a reason", async () => {
	const cases: { name: string; run: () => Promise<{ kind: string; reason?: string }> }[] = [
		{
			name: "rpc",
			run: () => {
				const h = harness(undefined, { mode: "rpc" });
				return askQuestionnaire(h.ctx, questions([item()]), h.deps);
			},
		},
		{
			name: "no ui",
			run: () => {
				const h = harness(undefined, { hasUI: false });
				return askQuestionnaire(h.ctx, questions([item()]), h.deps);
			},
		},
		{
			name: "absent package",
			run: () => {
				const h = harness(undefined, { load: { reason: "not installed anywhere" } });
				return askQuestionnaire(h.ctx, questions([item()]), h.deps);
			},
		},
		{
			name: "loader rejects",
			run: () => {
				const h = harness(undefined, { loaderRejects: true });
				return askQuestionnaire(h.ctx, questions([item()]), h.deps);
			},
		},
		{
			name: "malformed details",
			run: () => {
				const h = harness(undefined, { malformedDetails: true });
				return askQuestionnaire(h.ctx, questions([item()]), h.deps);
			},
		},
		{
			name: "package error",
			run: () => {
				const h = harness({ answers: [], cancelled: true, error: "no_custom_ui" });
				return askQuestionnaire(h.ctx, questions([item()]), h.deps);
			},
		},
		{
			name: "throwing execute",
			run: () => {
				const h = harness(undefined, { throws: true });
				return askQuestionnaire(h.ctx, questions([item()]), h.deps);
			},
		},
		{
			name: "nothing to ask",
			run: () => {
				const h = harness(undefined);
				return askQuestionnaire(h.ctx, [], h.deps);
			},
		},
	];
	for (const testCase of cases) {
		const outcome = await testCase.run();
		assert.equal(outcome.kind, "unavailable", testCase.name);
		assert.ok((outcome.reason ?? "").length > 0, `${testCase.name} must say why`);
	}
});

// ---------------------------------------------------------------------------
// 3. Finding the package where pi actually put it
// ---------------------------------------------------------------------------

test("the candidate list is the bare specifier, then pi's user scope, then the project scope", () => {
	const home = mkdtempSync(join(tmpdir(), "cp-vvaz-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "cp-vvaz-cwd-"));
	const roots = packageRoots({ cwd, env: {}, home });
	assert.deepEqual(roots, [
		join(home, ".pi", "agent", "npm", "node_modules"),
		join(cwd, ".pi", "npm", "node_modules"),
	]);
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/elsewhere/agent" }, home), "/elsewhere/agent");

	// Nothing installed: only the bare specifier is offered.
	assert.deepEqual(askToolCandidates({ cwd, env: {}, home }), [
		{ label: ASK_PACKAGE_SPECIFIER, specifier: ASK_PACKAGE_SPECIFIER },
	]);

	// Now install a fake copy in pi's user scope and it is offered too, at the
	// entry its own manifest declares — never a hand-written subpath.
	const dir = join(home, ".pi", "agent", "npm", "node_modules", ASK_PACKAGE_SPECIFIER);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ exports: { ".": "./index.ts" } }));
	assert.equal(publicEntryIn(join(home, ".pi", "agent", "npm", "node_modules")), join(dir, "index.ts"));
	assert.deepEqual(askToolCandidates({ cwd, env: {}, home }), [
		{ label: ASK_PACKAGE_SPECIFIER, specifier: ASK_PACKAGE_SPECIFIER },
		{ label: join(dir, "index.ts"), specifier: join(dir, "index.ts") },
	]);
});

test("publicEntryIn reads exports conditions, then main, and refuses what is not there", () => {
	const root = mkdtempSync(join(tmpdir(), "cp-vvaz-root-"));
	const dir = join(root, ASK_PACKAGE_SPECIFIER);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ exports: { ".": { import: "./esm/index.js" } } }));
	assert.equal(publicEntryIn(root), join(dir, "esm", "index.js"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ main: "./main.js" }));
	assert.equal(publicEntryIn(root), join(dir, "main.js"));
	assert.equal(publicEntryIn(mkdtempSync(join(tmpdir(), "cp-vvaz-empty-"))), undefined);
});

test("a load that finds nothing says every specifier it tried and how to fix it", async () => {
	const load = await loadAskToolFrom([
		{ label: ASK_PACKAGE_SPECIFIER, specifier: ASK_PACKAGE_SPECIFIER },
		{ label: "/nope/index.ts", specifier: "/nope/index.ts" },
	]);
	assert.equal(load.tool, undefined);
	assert.ok(load.reason?.includes(ASK_PACKAGE_SPECIFIER));
	assert.ok(load.reason?.includes("/nope/index.ts"));
	assert.match(load.reason as string, /npm install|packages/);
});

test("a candidate that loads wins, and the source is reported", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cp-vvaz-pkg-"));
	const entry = join(dir, "index.mjs");
	writeFileSync(
		entry,
		[
			"export default function (pi) {",
			`  pi.registerTool({ name: ${JSON.stringify(ASK_TOOL_NAME)}, execute: async () => ({ details: { answers: [], cancelled: true } }) });`,
			"}",
		].join("\n"),
	);
	const load = await loadAskToolFrom([
		{ label: "/nope/index.ts", specifier: "/nope/index.ts" },
		{ label: entry, specifier: entry },
	]);
	assert.equal(load.source, entry);
	assert.equal(load.tool?.name, ASK_TOOL_NAME);
	assert.equal(load.reason, undefined);
});

test("a module that registers some other tool is a named failure, not a wrong tool", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cp-vvaz-other-"));
	const entry = join(dir, "index.mjs");
	writeFileSync(entry, "export default function (pi) { pi.registerTool({ name: 'something_else', execute: async () => ({}) }); }");
	const load = await loadAskToolFrom([{ label: entry, specifier: entry }]);
	assert.equal(load.tool, undefined);
	assert.match(load.reason as string, /registers no ask_user_question/);
});

// ---------------------------------------------------------------------------
// 4. The adapter never hands the model a second ask_user_question
// ---------------------------------------------------------------------------

test("the adapter is not handed pi: nothing in it can register a tool", () => {
	const source = readFileSync(resolve(HERE, "../extensions/command-post/questionnaire.ts"), "utf8");
	// The only `registerTool` implementation in this file is the shim's own
	// capturing property; every other mention is prose.
	assert.equal([...source.matchAll(/registerTool:/g)].length, 1);
	assert.ok(!source.includes("pi.registerTool"));
	// The real pi API is never imported: the factory is called with the shim.
	assert.ok(!source.includes("import type { ExtensionAPI }"));
	// The package is reached through the entry its manifest declares, never a
	// hand-written subpath of it.
	assert.ok(!source.includes("rpiv-ask-user-question/"), "no deep import into the package");
});

test("index.ts answers via cp_decide, not a TUI overlay; only approved viewer runtime deps exist", () => {
	const source = commandPostSource();
	assert.ok(source.includes('name: "cp_decide"'));
	assert.ok(source.includes('registerCommand("cp-awaiting"'));
	assert.ok(!source.includes('registerCommand("cp-decide"'));
	assert.ok(!source.includes('registerCommand("cp-authorize"'));
	assert.ok(!source.includes('registerCommand("cp-decline"'));
	const pkg = JSON.parse(readFileSync(resolve(HERE, "../package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
		pi?: { extensions?: string[] };
	};
	assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), ["esbuild", "preact"]);
	assert.deepEqual(pkg.pi?.extensions, ["./extensions/command-post/index.ts"]);
});
