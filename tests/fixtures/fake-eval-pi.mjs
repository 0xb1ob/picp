#!/usr/bin/env node
/**
 * A stand-in for `pi --mode json` in the eval's live transport (do8.7).
 *
 * The live transport spends money, so the free suite points `CP_EVAL_PI_BIN` at
 * this file instead: it asserts it was invoked the way a real headless pi would
 * be and prints the same event stream shape, so argv, stdout capture, usage and
 * tool-call accounting, the timeout and the failure path are all exercised
 * without a model.
 *
 * `CP_FAKE_PI_MODE` picks the behaviour: `json` (default), `slow` (never
 * answers — the timeout's subject), `fail` (non-zero exit with stderr).
 */

const args = process.argv.slice(2);
const modeIndex = args.indexOf("--mode");
const modelIndex = args.indexOf("--model");
const prompt = args[args.length - 1] ?? "";
if (modeIndex === -1 || args[modeIndex + 1] !== "json" || modelIndex === -1 || prompt.startsWith("--")) {
	process.stderr.write(`fake pi: expected --mode json --model <id> ... <prompt>, got ${JSON.stringify(args)}\n`);
	process.exit(2);
}

const behaviour = process.env.CP_FAKE_PI_MODE ?? "json";
if (behaviour === "slow") {
	// Hold the event loop open and answer nothing: the caller's bound is the
	// only thing that can end this run.
	setTimeout(() => process.exit(0), 600_000);
} else if (behaviour === "fail") {
	process.stderr.write("fake pi: model provider returned 401 Unauthorized\n");
	process.exit(3);
} else {
	const report = {
		verdict: "pass",
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: [],
		revisions: [],
	};
	const events = [
		{ type: "agent_start" },
		{ type: "message_update", usage: { input: 400, output: 20, totalTokens: 420 } },
		{ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} },
		{ type: "tool_execution_end", toolCallId: "1", toolName: "read", result: "ok", isError: false },
		{ type: "tool_execution_start", toolCallId: "2", toolName: "read", args: {} },
		{ type: "tool_execution_end", toolCallId: "2", toolName: "read", result: "ok", isError: false },
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: `fake pi read ${prompt.length} prompt chars\n` },
					{ type: "text", text: JSON.stringify(report) },
				],
				usage: { input: 1000, output: 234, cacheRead: 0, cacheWrite: 0, totalTokens: 1234 },
			},
		},
		{ type: "agent_end", messages: [] },
	];
	process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}
