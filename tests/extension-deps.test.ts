/**
 * F1 stage 2: `createdThisTurn` reaches the tool modules through an accessor,
 * like the other session state, so cp_mandate's "all jobs created in this
 * turn" sentinel reads the session's current array — never a copy taken when
 * the tools were registered.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extensionDeps } from "../extensions/command-post/index.ts";
import type { SessionPost } from "../extensions/command-post/session-post.ts";
import { createSessionState, type ExtensionDeps } from "../extensions/command-post/shared.ts";
import { registerMandateTools } from "../extensions/command-post/tools-mandate.ts";
import { MANDATE_JOBS_THIS_TURN } from "../src/mandate.ts";

test("extensionDeps reads createdThisTurn through to the session state, even after it is reassigned", () => {
	const s = createSessionState();
	const deps = extensionDeps(s, {} as SessionPost, () => () => undefined);
	s.createdThisTurn = ["cp-a"];
	assert.deepEqual(deps.createdThisTurn, ["cp-a"]);
	deps.createdThisTurn.push("cp-b");
	assert.deepEqual(s.createdThisTurn, ["cp-a", "cp-b"]);
});

test("cp_mandate issue expands the sentinel from the array current at call time, not at registration", async () => {
	const s = createSessionState();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const pi = { on: () => {}, registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool) };
	let issued: { job_ids?: string[] } | undefined;
	const post = {
		home: "/nonexistent-cp-home",
		fleet: { read: () => ({ jobs: [] }) },
		registry: { get: () => undefined },
		ledger: () => ({}),
		escalations: {},
		mandates: {
			issue: (input: { job_ids?: string[] }) => {
				issued = input;
				return { id: "md-1", expiry: "2099-01-01T00:00:00Z" };
			},
		},
	};
	const deps = {
		commandPost: () => post,
		setLive: () => {},
		refreshWidget: () => {},
		projectOf: () => () => undefined,
		get createdThisTurn() {
			return s.createdThisTurn;
		},
	} as unknown as ExtensionDeps;
	registerMandateTools(pi as unknown as ExtensionAPI, deps);
	// A new turn's array, assigned after registration.
	s.createdThisTurn = ["cp-a", "cp-b"];
	await tools.get("cp_mandate")?.execute(
		"call-1",
		{ action: "issue", projects: ["p"], objective: "ship the backlog", job_ids: [MANDATE_JOBS_THIS_TURN] },
		undefined,
		undefined,
		{},
	);
	assert.deepEqual(issued?.job_ids, ["cp-a", "cp-b"]);
});
