/**
 * Leader of the cgroup scope that holds one `codex app-server`: `node codex-contain.mjs <unit> -- <command> [args…]`.
 * It kills its whole scope through `cgroup.kill` when the app-server exits, when fd 3 (the driver's lifeline) closes,
 * or on a signal; it refuses to start the command unless it sits in `<unit>`'s own cgroup. Imports `node:` only.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";

const LIFELINE = 3;
const [unit, dash, command, ...args] = process.argv.slice(2);
// A boundary fake of systemd (tests only) points these at its own cgroup files; the driver never passes them.
const root = process.env.PICP_CONTAIN_CGROUP_ROOT ?? "/sys/fs/cgroup";
const selfFile = process.env.PICP_CONTAIN_SELF_CGROUP ?? "/proc/self/cgroup";
const unset = ["PICP_CONTAIN_CGROUP_ROOT", "PICP_CONTAIN_SELF_CGROUP", ...(process.env.PICP_CONTAIN_UNSET ?? "").split(",").filter(Boolean), "PICP_CONTAIN_UNSET"];

function tell(message) {
	const line = Buffer.from(`${JSON.stringify(message)}\n`);
	for (let off = 0, tries = 0; off < line.length && tries < 1000; tries++) {
		try {
			off += writeSync(LIFELINE, line, off);
		} catch (error) {
			if (error.code !== "EAGAIN") return;
		}
	}
}

let killFile;
function teardown(code) {
	if (killFile !== undefined) {
		try {
			writeFileSync(killFile, "1");
		} catch {
			// The scope is already gone.
		}
	}
	process.exit(code);
}

function scope() {
	if (unit === undefined || dash !== "--" || command === undefined) return { refused: "usage: codex-contain.mjs <unit> -- <command> [args…]" };
	let path;
	try {
		path = /^0::(\/.*)$/m.exec(readFileSync(selfFile, "utf8"))?.[1];
	} catch (error) {
		return { refused: `cannot read its own cgroup (${error.code ?? error.message})` };
	}
	if (path === undefined || !path.endsWith(`/${unit}`)) return { refused: `not inside its own scope ${unit} (cgroup v2 ${path ?? "missing"})` };
	const file = join(root, path, "cgroup.kill");
	if (!existsSync(file)) return { refused: `the scope has no cgroup.kill (${file}); the kernel cannot tear it down` };
	return { killFile: file };
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => teardown(1));
process.on("uncaughtException", () => teardown(70));
const found = scope();
if (found.refused !== undefined) {
	tell({ refused: found.refused });
	process.exit(3);
}
killFile = found.killFile;
let lifeline;
try {
	lifeline = new Socket({ fd: LIFELINE, readable: true, writable: false });
} catch {
	teardown(4);
}
lifeline.on("data", () => {});
for (const event of ["end", "close", "error"]) lifeline.on(event, () => teardown(0));
const env = { ...process.env };
for (const key of unset) delete env[key];
const child = spawn(command, args, { stdio: "inherit", env });
child.once("error", (error) => {
	tell({ exit: { code: null, signal: null, error: error.message } });
	teardown(127);
});
child.once("spawn", () => tell({ contained: { killFile, pid: child.pid } }));
child.once("exit", (code, signal) => {
	tell({ exit: { code, signal } });
	teardown(0);
});
