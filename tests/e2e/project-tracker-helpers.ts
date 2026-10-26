/**
 * Behavior 13 bench: a scratch home and a real pi parent with the command-post extension on the mock provider;
 * each model turn plays one tool call, and a function args is read when that turn's request arrives.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Job } from "../../src/contracts.ts";
import { readJobsDocument } from "../../src/ledger.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, type PiChild, startPiChild, waitFor } from "../harness/index.ts";
import type { RecordedRequest } from "../harness/mock-provider.ts";

export type Args = Record<string, unknown> | (() => Record<string, unknown>);
export interface Call { id: string; name: string; args: Args }
export const call = (id: string, name: string, args: Args): Call => ({ id, name, args });
export const job = (id: string, args: Args): Call => call(id, "cp_job", args);
export const project = (id: string, args: Args): Call => call(id, "cp_project", args);

export interface End { isError?: boolean; result?: unknown }
export type Ends = Map<string, End>;
export const said = (ends: Ends, id: string): string => JSON.stringify(ends.get(id)?.result);
export const text = (ends: Ends, id: string): string =>
	((ends.get(id)?.result as { content?: Array<{ text?: string }> } | undefined)?.content ?? []).map((part) => part.text ?? "").join("\n");
export const details = <T = Record<string, unknown>>(ends: Ends, id: string): T => (ends.get(id)?.result as { details: T }).details;

export function ok(ends: Ends, id: string, pattern?: RegExp): string {
	assert.ok(ends.has(id), `${id} never ran`);
	assert.notEqual(ends.get(id)?.isError, true, `${id}: ${said(ends, id)}`);
	if (pattern) assert.match(text(ends, id), pattern, id);
	return text(ends, id);
}

export function failed(ends: Ends, id: string, pattern: RegExp): string {
	assert.ok(ends.has(id), `${id} never ran`);
	assert.equal(ends.get(id)?.isError, true, `${id} should be refused: ${said(ends, id)}`);
	assert.match(text(ends, id) || said(ends, id), pattern, id);
	return text(ends, id) || said(ends, id);
}

export const notesOf = (child: PiChild): string[] =>
	child.records().filter((record) => record.type === "extension_ui_request" && record.method === "notify").map((record) => String(record.message));

/** A scripted `gh` first on the parent's PATH: `answer` is shell `case` arms over `$*`; every call is logged. */
export function scriptedGh(t: TestContext, answer: string): { path: string; calls: () => string[] } {
	const bin = mkdtempSync(join(tmpdir(), "p15-gh-"));
	const log = join(bin, "calls");
	writeFileSync(log, "");
	writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$*" in\n${answer}\nesac\necho "gh stub: unscripted $*" >&2\nexit 1\n`, { mode: 0o755 });
	t.after(() => rmSync(bin, { recursive: true, force: true }));
	return {
		path: `${bin}:${process.env.PATH ?? ""}`,
		calls: () => (readFileSync(log, "utf8").split("\n").filter(Boolean)),
	};
}


/**
 * One prompt: a model turn playing `calls`, or a slash command (no calls) answered by a notice matching `until`.
 * `before` runs in the test process first: it seeds or breaks state on the scratch home mid-session.
 */
export interface Step { prompt: string; calls?: readonly Call[]; until?: RegExp; before?: () => unknown }

export interface Bench {
	home: string;
	/** Boots one parent, runs every step in order, closes it. */
	run(steps: readonly Step[], env?: NodeJS.ProcessEnv): Promise<{ ends: Ends; notes: string[] }>;
	session(prompt: string, calls: readonly Call[], env?: NodeJS.ProcessEnv): Promise<{ ends: Ends; notes: string[] }>;
	jobs(): Job[];
	idOf(title: string): string;
	/** Every request the mock provider answered, in order. */
	requests(): readonly RecordedRequest[];
}

export async function bench(t: TestContext, name: string, env: NodeJS.ProcessEnv = {}): Promise<Bench> {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	t.after(async () => {
		await provider.stop();
		agentDir.cleanup();
		home.cleanup();
	});
	let runs = 0;
	const jobs = () => readJobsDocument(home.path).jobs;
	const run: Bench["run"] = async (steps, extra = {}) => {
		const model = provider.addScript(`${name}-${(runs += 1)}`, steps.filter((step) => step.calls).flatMap((step) => [
			...(step.calls ?? []).map((entry) => ({ kind: "tool_calls" as const, calls: [{ id: entry.id, name: entry.name, args: entry.args }] })),
			{ kind: "text" as const, text: "noted" },
		]));
		agentDir.writeModels(provider);
		const child = startPiChild({ cwd: home.path, model, env: { ...agentDir.env, CP_HOME: home.path, ...env, ...extra }, extensions: [COMMAND_POST_EXTENSION] });
		try {
			let turns = 0;
			for (const step of steps) {
				await step.before?.();
				const notes = notesOf(child).length;
				await child.prompt(step.prompt);
				const what = `${name}: ${step.prompt}`;
				if (step.calls) await waitFor(() => child.eventsOfType("agent_settled").length, (settled) => settled > turns, { timeoutMs: 120_000, what });
				else await waitFor(() => notesOf(child).slice(notes), (fresh) => fresh.some((note) => (step.until ?? /./).test(note)), { timeoutMs: 60_000, what });
				if (step.calls) turns += 1;
			}
			const ends: Ends = new Map(child.eventsOfType("tool_execution_end").map((end) => [String(end.toolCallId), end as End]));
			return { ends, notes: notesOf(child) };
		} finally {
			await child.close();
		}
	};
	return {
		home: home.path,
		requests: () => provider.requests(),
		jobs,
		idOf(title) {
			const found = jobs().filter((entry) => entry.title === title);
			assert.equal(found.length, 1, `exactly one job titled ${title}`);
			return found[0]!.id;
		},
		run,
		session: (prompt, calls, extra) => run([{ prompt, calls }], extra),
	};
}
