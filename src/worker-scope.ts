/**
 * Workers in their own memory-capped systemd user scope (#576): a worker that blows up is killed alone, never
 * cp-daemon. Asked for by `CP_WORKER_MEMORY_MAX`, which cp-daemon's parent role sets on the systemd backend only.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export const WORKER_MEMORY_MAX_ENV = "CP_WORKER_MEMORY_MAX";
const SCOPE_FLAGS: readonly string[] = ["--user", "--scope", "--quiet", "--collect"];
const usable = new Map<string, boolean>();

/** True when `systemd-run --user --scope` starts a scope (doctor's `service.worker_scope` runs the same probe). */
function scopeWorks(env: NodeJS.ProcessEnv): boolean {
	try {
		execFileSync("systemd-run", [...SCOPE_FLAGS, "--", "true"], { env, stdio: "ignore", timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * `binary args` wrapped in `systemd-run --user --scope` with `MemoryMax`, or unchanged when no limit is asked for or
 * the scope cannot start (probed once per PATH, logged once): a worker spawn never fails because of its scope.
 */
export function scopedCommand(binary: string, args: string[], env: NodeJS.ProcessEnv, jobId = "worker", log = console.warn): { binary: string; args: string[] } {
	const limit = env[WORKER_MEMORY_MAX_ENV];
	if (!limit) return { binary, args };
	const key = env.PATH ?? "";
	let ok = usable.get(key);
	if (ok === undefined) {
		ok = scopeWorks(env);
		usable.set(key, ok);
		if (!ok) log(`[cp] systemd-run --user --scope does not work here: workers run unscoped, without MemoryMax=${limit}`);
	}
	if (!ok) return { binary, args };
	const unit = `cp-worker-${jobId.replace(/[^A-Za-z0-9_.-]/g, "_")}-${randomBytes(3).toString("hex")}`;
	return { binary: "systemd-run", args: [...SCOPE_FLAGS, `--unit=${unit}`, "-p", `MemoryMax=${limit}`, "-p", "MemorySwapMax=0", "--", binary, ...args] };
}
