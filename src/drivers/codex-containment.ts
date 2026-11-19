/**
 * OS-level containment for `codex app-server`: each one runs in its own systemd user scope led by `codex-contain.mjs`,
 * which kills the whole cgroup through `cgroup.kill`. No `systemd-run` means no Codex: there is no uncontained path.
 */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { whichAll } from "../doctor.ts";
import { CodexSpikeError } from "./codex-cli.ts";

export const CODEX_CONTAIN = fileURLToPath(new URL("./codex-contain.mjs", import.meta.url));
/** Env keys only a boundary fake of systemd may set; never accepted from a caller's env. */
export const CONTAIN_ENV_KEY = /^PICP_CONTAIN_/;

/** `memoryMax`: the worker's memory cap, which the app-server's sibling scope would otherwise escape (E9). */
export interface CodexContainment { systemdRun: string; runtimeDir: string; memoryMax?: string }

export const containmentRefusal = (why: string): string =>
	`Refused: picp could not contain codex app-server in a systemd user scope (${why}); it never runs Codex uncontained.`;

const refused = (why: string) => Object.assign(new CodexSpikeError(containmentRefusal(why)), { cli: "containment" as const });

/** The host's `systemd-run`, user runtime dir and `CP_CODEX_MEMORY_MAX`; throws (cli `containment`) when unusable. */
export function resolveCodexContainment(hostEnv: NodeJS.ProcessEnv = process.env): CodexContainment {
	const systemdRun = whichAll("systemd-run", hostEnv)[0];
	if (systemdRun === undefined) throw refused("systemd-run is not on PATH");
	const memoryMax = hostEnv.CP_CODEX_MEMORY_MAX;
	if (memoryMax !== undefined && !/^\d+[KMGT]?$/.test(memoryMax)) throw refused(`CP_CODEX_MEMORY_MAX ${JSON.stringify(memoryMax)} is not a byte size like 6G`);
	return { systemdRun, runtimeDir: hostEnv.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`, ...(memoryMax === undefined ? {} : { memoryMax }) };
}

/** argv and env that start `command` as the leader's child inside a fresh scope named `unit`. */
export function containedCommand(containment: CodexContainment, command: string, args: readonly string[], env: Record<string, string>) {
	const unit = `picp-codex-${process.pid}-${randomBytes(4).toString("hex")}.scope`;
	const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !CONTAIN_ENV_KEY.test(key)));
	const unset = ["XDG_RUNTIME_DIR"].filter((key) => clean[key] === undefined);
	return {
		unit,
		command: containment.systemdRun,
		args: [
			"--user", "--scope", "--quiet", "--collect", `--unit=${unit}`,
			...(containment.memoryMax === undefined ? [] : ["-p", `MemoryMax=${containment.memoryMax}`, "-p", "MemorySwapMax=0"]),
			"--", process.execPath, CODEX_CONTAIN, unit, "--", command, ...args,
		],
		env: { ...clean, XDG_RUNTIME_DIR: clean.XDG_RUNTIME_DIR ?? containment.runtimeDir, ...(unset.length > 0 ? { PICP_CONTAIN_UNSET: unset.join(",") } : {}) },
	};
}
