import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import type { TestContext } from "node:test";

/** Keep a real child unreaped until the assertion finishes, then reap it ourselves. */
export async function withZombie(t: TestContext, check: (pid: number, holder: number) => void): Promise<void> {
	if (!existsSync("/proc/self/status")) return t.skip("zombie fixture needs procfs");
	const probe = spawnSync("python3", ["-c", "import os; assert hasattr(os, 'fork')"], { timeout: 5_000 });
	if (probe.error || probe.status !== 0) return t.skip("zombie fixture needs python3 with os.fork on PATH");
	for (let attempt = 0; attempt < 2; attempt++) {
		const holder = spawn("python3", ["-c", [
			"import os, sys",
			"pid = os.fork()",
			"if pid == 0: os._exit(0)",
			"print(pid, flush=True)",
			"sys.stdin.read()",
			"os.waitpid(pid, 0)",
		].join("\n")], { stdio: ["pipe", "pipe", "inherit"], timeout: 15_000, killSignal: "SIGKILL" });
		const closed = once(holder, "close");
		try {
			const data = await Promise.race([
				once(holder.stdout, "data"),
				closed.then(() => { throw new Error("zombie holder exited before reporting its child"); }),
			]);
			const pid = Number(String(data[0]).trim());
			assert.ok(Number.isSafeInteger(pid) && pid > 0, "holder must report a child pid");
			const deadline = Date.now() + 10_000;
			while (true) {
				let status: string;
				try {
					status = readFileSync(`/proc/${pid}/status`, "utf8");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					t.diagnostic(`zombie fixture child was reaped before observation (attempt ${attempt + 1})`);
					break;
				}
				if (/^State:\s+Z/m.test(status)) {
					process.kill(pid, 0); // A kill-0-only aliveness check would wrongly return true.
					check(pid, holder.pid!);
					return;
				}
				assert.ok(Date.now() < deadline, "forked child never became a zombie");
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		} finally {
			holder.stdin.end();
			await closed;
		}
	}
	t.skip("zombie fixture child was reaped before observation in both attempts");
}
