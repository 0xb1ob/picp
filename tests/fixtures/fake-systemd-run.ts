/**
 * Stand-in `systemd-run --user --scope` for CI hosts with no user manager. Scope membership is the inherited
 * `FAKE_SCOPE=<unit>` env entry (set by the stub before exec); a detached fake kernel SIGKILLs every member once
 * the scope's `cgroup.kill` file reads `1`, as cgroup v2 does. Logs to `<FAKE_CODEX_STATE>/scopes.jsonl`.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const STATE = process.env.FAKE_CODEX_STATE ?? "";
const ROOT = join(STATE, "cgroup");
const log = (entry: unknown) => {
	mkdirSync(STATE, { recursive: true });
	appendFileSync(join(STATE, "scopes.jsonl"), `${JSON.stringify(entry)}\n`);
};

/** Pids whose environment carries this unit's marker, as /proc shows it. */
function members(unit: string): number[] {
	const mark = `FAKE_SCOPE=${unit}`;
	return readdirSync("/proc").filter((name) => /^\d+$/.test(name)).flatMap((name) => {
		try {
			return readFileSync(`/proc/${name}/environ`, "latin1").split("\0").includes(mark) ? [Number(name)] : [];
		} catch {
			return [];
		}
	});
}

async function kernel(unit: string): Promise<void> {
	const kill = join(ROOT, unit, "cgroup.kill");
	let empty = 0;
	for (let tick = 0; ; tick++) {
		await sleep(50);
		const pids = members(unit);
		if (existsSync(kill) && readFileSync(kill, "utf8").includes("1")) {
			for (let round = 0; round < 100 && members(unit).length > 0; round++) {
				for (const pid of members(unit)) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						// Gone already.
					}
				}
				await sleep(20);
			}
			log({ unit, killed: pids.length });
			break;
		}
		empty = pids.length === 0 ? empty + 1 : 0;
		if (tick > 20 && empty > 40) {
			log({ unit, collected: true });
			break;
		}
	}
	rmSync(join(ROOT, unit), { recursive: true, force: true });
	rmSync(join(ROOT, `${unit}.self`), { force: true });
}

const argv = process.argv.slice(2);
if (argv[0] === "--fake-kernel") {
	await kernel(argv[1] ?? "");
	process.exit(0);
}
const script = JSON.parse(readFileSync(process.env.FAKE_CODEX_SCRIPT ?? "", "utf8")) as { knobs?: { containment?: string } };
const unit = /^--unit=(.+)$/.exec(argv.find((arg) => arg.startsWith("--unit=")) ?? "")?.[1];
const command = argv.slice(argv.indexOf("--") + 1);
if (script.knobs?.containment === "fail" || unit === undefined || !argv.includes("--scope") || command.length === 0) {
	process.stderr.write("Failed to connect to user scope bus via local transport: No such file or directory\n");
	log({ unit, refused: true });
	process.exit(1);
}
mkdirSync(join(ROOT, unit), { recursive: true });
writeFileSync(join(ROOT, unit, "cgroup.kill"), "");
writeFileSync(join(ROOT, `${unit}.self`), `0::/${unit}\n`);
const env = { ...process.env };
delete env.FAKE_SCOPE;
spawn(process.execPath, [fileURLToPath(import.meta.url), "--fake-kernel", unit], { detached: true, stdio: "ignore", env }).unref();
log({ unit, started: true });
const leader = spawn(command[0] as string, command.slice(1), {
	stdio: ["inherit", "inherit", "inherit", "inherit"],
	env: { ...process.env, PICP_CONTAIN_CGROUP_ROOT: ROOT, PICP_CONTAIN_SELF_CGROUP: join(ROOT, `${unit}.self`) },
});
leader.once("exit", (code, signal) => (signal === null ? process.exit(code ?? 1) : process.kill(process.pid, signal)));
