import { spawn, execFile } from "node:child_process";
import { lstatSync, realpathSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { isSafeScriptPath, paths, SCHEMA_VERSION, type ScriptExitResult } from "./contracts.ts";
import { atomicWriteJson } from "./json-store.ts";

const exec = promisify(execFile);
export const SCRIPT_TAIL_BYTES = 64 * 1024;

/** Reject every symlink component, including one that points back inside the checkout. */
export async function resolveScriptFile(worktree: string, path: string): Promise<string> {
	if (!isSafeScriptPath(path)) throw new Error(`unsafe script path ${JSON.stringify(path)}`);
	const root = realpathSync(worktree);
	let candidate = root;
	for (const component of path.split("/")) {
		candidate = join(candidate, component);
		if (lstatSync(candidate).isSymbolicLink()) throw new Error(`script path ${path} contains a symlink`);
	}
	const resolved = realpathSync(candidate);
	if (!resolved.startsWith(root + sep) || !lstatSync(resolved).isFile()) throw new Error(`script path ${path} is not a regular file under ${root}`);
	const tracked = await exec("git", ["ls-files", "--error-unmatch", "--", relative(root, resolved)], { cwd: root }).then(() => true, () => false);
	if (!tracked) throw new Error(`script path ${path} is not tracked by git`);
	return resolved;
}

/** The whole environment a script sees: no inherited secrets, no prompts, no pager. */
export function scriptEnv(cwd: string): Record<string, string> {
	return { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_EDITOR: "true" };
}

export interface ScriptRunOptions {
	home: string;
	jobId: string;
	worktree: string;
	file: string;
	wallClockSeconds: number;
	/** Test-only executable override; production always uses /bin/sh. */
	shell?: string;
	/** Called after the result is durable. */
	onResult?: (result: ScriptExitResult) => Promise<unknown>;
}

export function runScript(options: ScriptRunOptions) {
	const { home, jobId } = options;
	const dir = join(home, paths.runDir(jobId));
	mkdirSync(dir, { recursive: true });
	const child = spawn(options.shell ?? "/bin/sh", [options.file], {
		cwd: options.worktree,
		detached: true,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...scriptEnv(options.worktree),
			CP_JOB_ID: jobId,
			CP_RUN_DIR: dir,
			CP_WORKTREE: options.worktree,
		},
	});
	const streams = [child.stdout, child.stderr].map((stream) => {
		let bytes = 0;
		let tail = Buffer.alloc(0);
		stream.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			tail = Buffer.concat([tail, chunk]).subarray(-SCRIPT_TAIL_BYTES);
		});
		return () => ({ bytes, tail });
	});
	let timedOut = false;
	let escalation: NodeJS.Timeout | undefined;
	let spawnError: Error | undefined;
	const timer = setTimeout(() => {
		timedOut = true;
		if (child.pid) {
			try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
			escalation = setTimeout(() => {
				if (child.pid) {
					try { process.kill(-child.pid, "SIGKILL"); } catch { /* Group already exited. */ }
				}
			}, 1_500);
		}
	}, options.wallClockSeconds * 1000);
	const closed = new Promise<ScriptExitResult>((resolve, reject) => {
		child.once("error", (error) => { spawnError = error; });
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if (escalation) {
				clearTimeout(escalation);
				if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* Group already exited. */ }
			}
			void (async () => {
				const reason = spawnError ? "spawn_error" : timedOut ? "timeout" : signal ? "signal" : code === 0 ? "success" : "exit";
				const result: ScriptExitResult = {
					job_id: jobId,
					status: reason === "success" ? "done" : "failed",
					exit_code: spawnError ? null : code,
					signal: spawnError ? null : signal,
					timed_out: timedOut,
					reason,
					summary: reason === "success" ? `${jobId}: script exited 0` : `${jobId}: script ${reason}${code !== null ? ` (${code})` : signal ? ` (${signal})` : ""}`,
					artifact_path: join(home, paths.artifactFile(jobId)),
				};
				const artifact = streams.map((read, i) => {
					const { bytes, tail } = read();
					return `${i ? "stderr" : "stdout"}: ${bytes} bytes${bytes > tail.length ? ` (truncated to last ${SCRIPT_TAIL_BYTES} bytes)` : ""}\n${tail.toString("utf8")}`;
				}).join("\n\n");
				mkdirSync(dirname(result.artifact_path), { recursive: true });
				const tmp = `${result.artifact_path}.tmp`;
				writeFileSync(tmp, artifact || "(no output)\n");
				renameSync(tmp, result.artifact_path);
				atomicWriteJson(join(home, paths.scriptResultFile(jobId)), { schema_version: SCHEMA_VERSION, job_id: jobId, result });
				await options.onResult?.(result);
				resolve(result);
			})().catch(reject);
		});
	});
	return { child, closed };
}
