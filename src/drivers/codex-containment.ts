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

export interface CodexContainment { systemdRun: string; runtimeDir: string }

export const containmentRefusal = (why: string): string =>
	`Refused: picp could not contain codex app-server in a systemd user scope (${why}); it never runs Codex uncontained.`;

/** The host's `systemd-run` and user runtime dir; throws (cli `containment`) when there is none. */
export function resolveCodexContainment(hostEnv: NodeJS.ProcessEnv = process.env): CodexContainment {
	const systemdRun = whichAll("systemd-run", hostEnv)[0];
	if (systemdRun === undefined) throw Object.assign(new CodexSpikeError(containmentRefusal("systemd-run is not on PATH")), { cli: "containment" as const });
	return { systemdRun, runtimeDir: hostEnv.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}` };
}

/** argv and env that start `command` as the leader's child inside a fresh scope named `unit`. */
export function containedCommand(containment: CodexContainment, command: string, args: readonly string[], env: Record<string, string>) {
	const unit = `picp-codex-${process.pid}-${randomBytes(4).toString("hex")}.scope`;
	const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !CONTAIN_ENV_KEY.test(key)));
	const unset = ["XDG_RUNTIME_DIR"].filter((key) => clean[key] === undefined);
	return {
		unit,
		command: containment.systemdRun,
		args: ["--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, "--", process.execPath, CODEX_CONTAIN, unit, "--", command, ...args],
		env: { ...clean, XDG_RUNTIME_DIR: clean.XDG_RUNTIME_DIR ?? containment.runtimeDir, ...(unset.length > 0 ? { PICP_CONTAIN_UNSET: unset.join(",") } : {}) },
	};
}
