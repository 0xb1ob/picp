/**
 * Teardown's Codex thread delete (D5): one contained bare app-server (web search off, no hook, no turn) asked
 * `thread/delete` for the thread the worker recorded. A failure is named in the result and never blocks the lease.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WORKER_MEMORY_MAX_ENV } from "../worker-scope.ts";
import { readNativeSession } from "./claude-followup.ts";
import { resolveCodexAsync } from "./codex-cli.ts";
import { type CodexContainment, resolveCodexContainment } from "./codex-containment.ts";
import { buildCodexChildEnv, codexBareArgs } from "./codex-launch.ts";
import { CODEX_METHODS as M } from "./codex-protocol.ts";
import { spawnCodexRpc } from "./codex-rpc.ts";

const CLOSE_GRACE_MS = 5_000;

/** Deletes `threadId` through one bare app-server in its own scope; throws on a refusal, a CLI error or the timeout. */
export async function codexThreadDelete(options: {
	codexPath: string; containment: CodexContainment; env: Record<string, string>; cwd: string; threadId: string; timeoutMs?: number;
}): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 15_000;
	const rpc = spawnCodexRpc({ command: options.codexPath, args: codexBareArgs(), cwd: options.cwd, env: options.env, containment: options.containment });
	try {
		await rpc.request(M.initialize, { clientInfo: { name: "picp", version: "0.0.0" }, capabilities: { experimentalApi: true } }, timeoutMs);
		rpc.notify(M.initialized);
		await rpc.request(M.threadDelete, { threadId: options.threadId }, timeoutMs);
	} finally {
		rpc.closeInput();
		if ((await Promise.race([rpc.exited, sleep(CLOSE_GRACE_MS, undefined, { ref: false })])) === undefined) rpc.kill("SIGKILL");
	}
}

export interface CodexThreadDeleted { deleted: boolean; thread_id?: string; error?: string }

/** Reads the worker's session record and deletes its thread; the outcome, never a throw. */
export async function deleteCodexThread(input: { sessionFile: string; hostEnv?: NodeJS.ProcessEnv }): Promise<CodexThreadDeleted> {
	const hostEnv = input.hostEnv ?? process.env;
	let threadId: string | undefined;
	try {
		const record = readNativeSession(input.sessionFile);
		threadId = record.thread_id;
		if (threadId === undefined) return { deleted: false, error: "the session record holds no thread id (no turn started)" };
		if (record.codex_home === undefined) return { deleted: false, thread_id: threadId, error: "the session record holds no Codex home" };
		const dirs = { home: join(record.scratch_dir, "home"), tmp: join(record.scratch_dir, "tmp") };
		for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
		const memory = hostEnv[WORKER_MEMORY_MAX_ENV];
		const containment = resolveCodexContainment({ ...hostEnv, ...(memory ? { CP_CODEX_MEMORY_MAX: memory } : {}) });
		const codex = await resolveCodexAsync(hostEnv);
		const cwd = record.cwd !== undefined && existsSync(record.cwd) ? record.cwd : record.scratch_dir;
		await codexThreadDelete({ codexPath: codex.path, containment, env: buildCodexChildEnv(dirs, hostEnv, record.codex_home), cwd, threadId });
		return { deleted: true, thread_id: threadId };
	} catch (error) {
		return { deleted: false, ...(threadId === undefined ? {} : { thread_id: threadId }), error: (error as Error).message.slice(0, 500) };
	}
}
