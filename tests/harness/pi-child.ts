/**
 * Spawn pi RPC children for tests: workers (hermetic, per the T2 trust policy)
 * and parents (extension under test loaded, discovery still off).
 *
 * This is TEST infrastructure. The product's worker runtime is `WorkerProcess`
 * (T3) and must not import from here.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WORKER_REQUIRED_FLAGS } from "../../src/contracts.ts";
import { type RpcRecord, type RpcSession, startRpc } from "./rpc.ts";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
export const COMMAND_POST_EXTENSION = resolve(REPO_ROOT, "extensions/command-post/index.ts");
export const WORKER_REPORTER_EXTENSION = resolve(REPO_ROOT, "extensions/worker-reporter/index.ts");
export const CP_BRIDGE_EXTENSION = resolve(REPO_ROOT, "extensions/cp-bridge/index.ts");

/** The command-post extension's whole source, index.ts first: its tools and commands live in sibling modules. */
export function commandPostSource(): string {
	const dir = resolve(REPO_ROOT, "extensions/command-post");
	const files = readdirSync(dir).filter((name) => name.endsWith(".ts") && name !== "index.ts").sort();
	return ["index.ts", ...files].map((name) => readFileSync(resolve(dir, name), "utf8")).join("\n");
}

export interface PiChildOptions {
	cwd: string;
	/** `provider/model` id, normally from `MockProvider.addScript`. */
	model?: string;
	/** Env additions; pass `AgentDir.env` to stay hermetic. */
	env?: NodeJS.ProcessEnv;
	/** Extension files loaded with `-e`. */
	extensions?: string[];
	/** Tool allowlist (`--tools`). Omit for pi's default set. */
	tools?: string[];
	/** Persist the session under this dir; omitted means `--no-session`. */
	sessionDir?: string;
	/** Resume an existing session file. */
	sessionFile?: string;
	thinking?: string;
	/** Anything else, appended verbatim. */
	extraArgs?: string[];
	/**
	 * Apply the worker trust policy from src/contracts.ts
	 * (`--no-approve --no-extensions --no-skills`). Default true.
	 */
	hermetic?: boolean;
	/** Load AGENTS.md/CLAUDE.md. Default false in tests (noise + drift). */
	contextFiles?: boolean;
}

export interface PiChild extends RpcSession {
	/** Send a prompt and resolve with its id-correlated response record. */
	prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<RpcRecord>;
	/** Wait for the next `agent_settled` after `fromIndex` records. */
	waitForSettled(timeoutMs?: number): Promise<RpcRecord>;
	getState(timeoutMs?: number): Promise<Record<string, unknown>>;
	/** All received records of a given event type. */
	eventsOfType(type: string): RpcRecord[];
}

export function buildPiArgs(options: PiChildOptions): string[] {
	const args: string[] = [];
	if (options.hermetic !== false) {
		// --mode rpc comes from startRpc; keep the rest of the policy verbatim.
		for (const flag of WORKER_REQUIRED_FLAGS) {
			if (flag === "--mode" || flag === "rpc") continue;
			args.push(flag);
		}
	}
	if (options.contextFiles !== true) args.push("--no-context-files");
	if (options.sessionFile) {
		args.push("--session", options.sessionFile);
	} else if (options.sessionDir) {
		args.push("--session-dir", options.sessionDir);
	} else {
		args.push("--no-session");
	}
	if (options.model) args.push("--model", options.model);
	if (options.thinking) args.push("--thinking", options.thinking);
	if (options.tools) args.push("--tools", options.tools.join(","));
	for (const extension of options.extensions ?? []) {
		args.push("-e", extension);
	}
	args.push(...(options.extraArgs ?? []));
	return args;
}

let promptSeq = 0;

export function startPiChild(options: PiChildOptions): PiChild {
	const session = startRpc({
		cwd: options.cwd,
		args: buildPiArgs(options),
		env: options.env,
	});

	const child: PiChild = {
		...session,
		async prompt(message, streamingBehavior) {
			promptSeq += 1;
			const id = `p${promptSeq}`;
			const record: RpcRecord = { id, type: "prompt", message };
			if (streamingBehavior) record.streamingBehavior = streamingBehavior;
			session.send(record);
			return session.waitFor((r) => r.type === "response" && r.id === id);
		},
		async waitForSettled(timeoutMs) {
			return session.waitFor((r) => r.type === "agent_settled", timeoutMs);
		},
		async getState(timeoutMs) {
			promptSeq += 1;
			const id = `s${promptSeq}`;
			session.send({ id, type: "get_state" });
			const response = await session.waitFor((r) => r.type === "response" && r.id === id, timeoutMs);
			return (response.data as Record<string, unknown> | undefined) ?? {};
		},
		eventsOfType(type) {
			return session.records().filter((r) => r.type === type);
		},
	};
	return child;
}
