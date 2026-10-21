/**
 * The bounded pi capability probe (#375): `pi --version`, then one `pi --mode rpc` that loads only the command-post
 * extension and must list /cp-version from it (tests/extension-load.test.ts's check). It runs in a fresh 0700 scratch
 * HOME/agent dir/CP_HOME with no auth, no session and no model call, kills only its own child, and removes the scratch.
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiProbe } from "./pi-compat.ts";
import { realpathSync as entryRealpath } from "node:fs";
import { fileURLToPath as entryPath } from "node:url";

export const PROBE_VERSION_MS = 5_000;
export const PROBE_EXTENSION_MS = 15_000;
export const PROBE_CLEANUP_MS = 5_000;
/** /doctor's shorter extension-load budget: the probe measured 1.3-1.8 s (#404). */
export const DOCTOR_PROBE_MS = 15_000;

/** Probe `pi` (an absolute path) against `packageRoot`'s extension; `loaded` skips the load. Never throws. */
export async function probePi(pi: string, packageRoot: string, extensionMs = PROBE_EXTENSION_MS, loaded?: Promise<PiProbe["extension"]>): Promise<PiProbe> {
	const scratch = mkdtempSync(join(tmpdir(), "cp-pi-probe-"));
	const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: scratch, PI_CODING_AGENT_DIR: join(scratch, "agent"), CP_HOME: join(scratch, "cp"), PI_OFFLINE: "1", TMPDIR: scratch };
	try {
		const line = await new Promise<string | undefined>((done) => {
			execFile(pi, ["--version"], { cwd: scratch, env, encoding: "utf8", timeout: PROBE_VERSION_MS }, (error, stdout) => done(error ? undefined : stdout.split("\n")[0]?.trim()));
		});
		const extension = await (loaded ?? loadsExtension(pi, join(packageRoot, "extensions/command-post/index.ts"), scratch, env, extensionMs));
		return { ...(line ? { version: line } : {}), extension };
	} catch (error) {
		return { extension: { ok: false, detail: `probe failed: ${(error as Error).message}` } };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

const loads = new Map<string, PiProbe["extension"]>();

/** /doctor's probe: async, DOCTOR_PROBE_MS; `--version` every time, a passed extension load reused per path+mtime. */
export async function probePiCached(pi: string, packageRoot: string): Promise<PiProbe> {
	let key: string | undefined;
	try {
		const real = realpathSync(pi);
		key = `${real}\0${statSync(real).mtimeMs}\0${packageRoot}`;
	} catch {
		key = undefined; // unreadable: probe it uncached, and its failure says why
	}
	const hit = key === undefined ? undefined : loads.get(key);
	const probe = await probePi(pi, packageRoot, DOCTOR_PROBE_MS, hit ? Promise.resolve(hit) : undefined);
	// Only a pass is kept: a timeout under load must not stick as "incompatible" until pi changes.
	if (key !== undefined && probe.extension.ok) loads.set(key, probe.extension);
	return probe;
}

function loadsExtension(pi: string, extension: string, cwd: string, env: NodeJS.ProcessEnv, budgetMs: number): Promise<{ ok: boolean; detail: string }> {
	const args = ["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", extension];
	const child = spawn(pi, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
	return new Promise((done) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (ok: boolean, detail: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.stdin.end();
			// Resolve only once our own child is gone (stdin EOF ends pi's RPC loop; SIGKILL after the budget).
			if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return done({ ok, detail });
			const kill = setTimeout(() => child.kill("SIGKILL"), PROBE_CLEANUP_MS);
			child.once("exit", () => {
				clearTimeout(kill);
				done({ ok, detail });
			});
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(false, `no get_commands answer within ${budgetMs / 1000}s`);
		}, budgetMs);
		child.on("error", (error) => finish(false, `could not run: ${error.message}`));
		child.on("close", (code) => finish(false, `exited ${code} before answering get_commands: ${stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`));
		child.stdin.on("error", () => {}); // EPIPE from a pi that already exited: "close" reports it
		child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString("utf8")).slice(-4000)));
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			for (let end = stdout.indexOf("\n"); end !== -1; end = stdout.indexOf("\n")) {
				const line = stdout.slice(0, end);
				stdout = stdout.slice(end + 1);
				let record: { type?: string; id?: string; success?: boolean; data?: { commands?: Array<{ name: string; source: string }> } };
				try {
					record = JSON.parse(line);
				} catch {
					continue; // not a protocol line
				}
				if (record.type !== "response" || record.id !== "probe") continue;
				const found = record.data?.commands?.some((command) => command.name === "cp-version" && command.source === "extension") === true;
				finish(found, found ? "the command-post extension loaded (/cp-version listed)" : `get_commands answered without the extension's /cp-version (success: ${record.success})`);
			}
		});
		child.stdin.write(`${JSON.stringify({ id: "probe", type: "get_commands" })}\n`);
	});
}

/** The same probe from synchronous code (doctor, install-tools): this file as a node subprocess, bounded. */
export function probePiSync(pi: string, packageRoot: string): PiProbe {
	const budget = PROBE_VERSION_MS + PROBE_EXTENSION_MS + 2 * PROBE_CLEANUP_MS;
	const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), pi, packageRoot], { encoding: "utf8", timeout: budget, stdio: ["ignore", "pipe", "pipe"] });
	try {
		return JSON.parse(run.stdout) as PiProbe;
	} catch {
		return { extension: { ok: false, detail: `probe helper exited ${run.status ?? run.signal}: ${(run.stderr || run.error?.message || "").trim().slice(0, 300)}` } };
	}
}

// Not import.meta.main: that is node 24.2+, and engines admits every 24.x (#375).
if (process.argv[1] !== undefined && (() => { try { return entryRealpath(process.argv[1]) === entryPath(import.meta.url); } catch { return false; } })()) {
	process.stdout.write(`${JSON.stringify(await probePi(process.argv[2] ?? "pi", process.argv[3] ?? process.cwd()))}\n`);
	process.exit(0);
}
