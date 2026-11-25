/**
 * Worker commit signing: the host's global signing keys as GIT_CONFIG_COUNT pairs (never its config file), an ssh
 * agent handed only to a picp-written signer, key paths guarded best effort; an unreachable key fails by name.
 */
import { execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const SIGNING_UNAVAILABLE = "commit_signing_unavailable";
/** The ssh signer picp writes in the run dir; it alone gets the host's SSH_AUTH_SOCK. */
export const SSH_SIGNER_FILE = "ssh-signer";
/** The only keys passed: no credential helper, alias or include of the host's config reaches a worker. */
export const SIGNING_KEYS = [
	"commit.gpgsign", "tag.gpgsign", "user.signingkey", "gpg.format",
	"gpg.program", "gpg.ssh.program", "gpg.ssh.allowedSignersFile",
] as const;
const PATH_VALUED: readonly string[] = [
	"user.signingkey", "gpg.program", "gpg.ssh.program", "gpg.ssh.allowedSignersFile",
];
const OFF = "the host does not sign (commit.gpgsign and tag.gpgsign are not true)";

type Pair = readonly [string, string];
/** One global value as the host's git reads it (`bool`: `--type=bool`); undefined when unset; throws if unreadable. */
export type SigningRead = (name: string, bool: boolean) => string | undefined;

/** The host's signing for a worker before anything is written: the pairs to pass and what the signer needs. */
export interface SigningPlan {
	state: "off" | "ready" | "unavailable";
	/** How commits are signed (ready), or why they are not (off) or cannot be (unavailable). */
	why: string;
	pairs: Pair[];
	/** Ready: what of the key the worker's own uid can reach. */
	reach?: "file" | "agent" | "gnupg";
	socket?: string;
	gnupg?: string;
	/** Paths the native Read, Grep, Glob and Bash guards refuse: best effort, the worker runs as the same uid. */
	secrets: string[];
}

/** What a worker's git gets: GIT_CONFIG_COUNT pairs, plus GNUPGHOME for openpgp; never SSH_AUTH_SOCK itself. */
export interface WorkerSigning {
	state: SigningPlan["state"];
	why: string;
	env: Record<string, string>;
	secrets: string[];
}

/** The read the workers and `/doctor` both make: the host's global config, includes followed. */
export const globalConfigArgs = (name: string, bool: boolean): string[] =>
	["config", "--global", "--includes", ...(bool ? ["--type=bool"] : []), "--get", name];
/** Without HOME or GIT_CONFIG_GLOBAL there is no global file, and git refuses `--global`. */
export const hasGlobalConfig = (env: NodeJS.ProcessEnv): boolean => Boolean(env.HOME || env.GIT_CONFIG_GLOBAL);

/** Each signer names a missing program, so every commit fails with `commit_signing_unavailable: <why>`. */
export function unavailablePlan(why: string, pairs: readonly Pair[] = []): SigningPlan {
	const signer = `/${SIGNING_UNAVAILABLE}: ${why}`;
	const kept = pairs.filter(([name]) => ["commit.gpgsign", "tag.gpgsign", "gpg.format"].includes(name));
	const failing: Pair[] = [
		["user.signingkey", `key::ssh-ed25519 ${SIGNING_UNAVAILABLE}`],
		["gpg.program", signer], ["gpg.ssh.program", signer], ["gpg.x509.program", signer],
	];
	return { state: "unavailable", why, pairs: [...kept, ...failing], secrets: [] };
}

function readable(path: string): boolean {
	try {
		accessSync(path, constants.R_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** ssh: an agent-held key (`key::`, or a `.pub` with an agent) needs SSH_AUTH_SOCK; a key file must be readable. */
function sshPlan(pairs: Pair[], value: string | undefined, env: NodeJS.ProcessEnv): SigningPlan {
	const socket = env.SSH_AUTH_SOCK && existsSync(env.SSH_AUTH_SOCK) ? env.SSH_AUTH_SOCK : undefined;
	const no = (why: string): SigningPlan => unavailablePlan(why, pairs);
	const agent = (secrets: string[]): SigningPlan => (socket
		? { state: "ready", why: "ssh, agent-held key", pairs, reach: "agent", socket, secrets }
		: no("the ssh signing key is agent-held and SSH_AUTH_SOCK names no socket"));
	if (value === undefined || value === "") return no("user.signingkey is unset");
	if (value.startsWith("key::") || value.startsWith("ssh-")) return agent([]);
	if (!isAbsolute(value)) return no("user.signingkey is not an absolute path");
	const file = value.endsWith(".pub") ? value.slice(0, -4) : value;
	if (file !== value && socket) return agent([file]);
	if (readable(file)) return { state: "ready", why: "ssh, key file", pairs, reach: "file", secrets: [file] };
	if (file === value) return no("user.signingkey names a key file that is missing or unreadable");
	return no("user.signingkey is a public key with no ssh agent and no readable private key beside it");
}

/** The host's signing as a worker's git must see it: `read` is its global config; `env` its HOME and agents. */
export function evaluateSigning(read: SigningRead, env: NodeJS.ProcessEnv): SigningPlan {
	if (read("commit.gpgsign", true) !== "true" && read("tag.gpgsign", true) !== "true") {
		return { state: "off", why: OFF, pairs: [], secrets: [] };
	}
	const home = env.HOME ?? "";
	// git expands `~/` with its own HOME, which is scratch in a worker: the host's is used here.
	const expand = (value: string): string =>
		(value.startsWith("~/") && home !== "" ? join(home, value.slice(2)) : value);
	const pairs: Pair[] = [];
	for (const name of SIGNING_KEYS) {
		const value = read(name, name.endsWith(".gpgsign"));
		if (value !== undefined) pairs.push([name, PATH_VALUED.includes(name) ? expand(value) : value]);
	}
	const get = (name: string): string | undefined => pairs.find(([each]) => each === name)?.[1];
	const format = (get("gpg.format") ?? "openpgp").toLowerCase();
	if (format === "ssh") return sshPlan(pairs, get("user.signingkey"), env);
	if (format !== "openpgp" && format !== "x509") {
		return unavailablePlan(`gpg.format ${format} is not one picp passes to a worker`, pairs);
	}
	const gnupg = env.GNUPGHOME || (home === "" ? "" : join(home, ".gnupg"));
	if (gnupg === "" || !existsSync(gnupg)) return unavailablePlan("no GnuPG home (GNUPGHOME or ~/.gnupg)", pairs);
	return { state: "ready", why: `${format}, GnuPG home`, pairs, reach: "gnupg", gnupg, secrets: [gnupg] };
}

/** One `git config` value under the host `env`; undefined when unset (exit 1); any other exit throws. */
function gitValue(args: string[], env: NodeJS.ProcessEnv, cwd?: string): string | undefined {
	try {
		return execFileSync("git", args, {
			...(cwd === undefined ? {} : { cwd }), env, encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"], timeout: 10_000,
		}).trim();
	} catch (error) {
		const status = (error as { status?: number | null }).status;
		if (status === 1) return undefined;
		throw new Error(`git ${args.join(" ")} exited ${status ?? "on a signal"}`);
	}
}

/** Routes a ready ssh agent through a 0700 signer in `runDir`, so no env but the signer's ever holds the socket. */
function withSigner(plan: SigningPlan, runDir: string | undefined): SigningPlan {
	if (plan.socket === undefined) return plan;
	const program = plan.pairs.find(([name]) => name === "gpg.ssh.program")?.[1] ?? "ssh-keygen";
	if (!runDir) return unavailablePlan("no run dir (CP_RUN_DIR) to hold the ssh signer", plan.pairs);
	if (`${plan.socket}${program}`.includes("'")) {
		return unavailablePlan("the ssh agent socket or gpg.ssh.program path holds a single quote", plan.pairs);
	}
	const file = join(runDir, SSH_SIGNER_FILE);
	const body = `#!/bin/sh\nSSH_AUTH_SOCK='${plan.socket}'\nexport SSH_AUTH_SOCK\nexec '${program}' "$@"\n`;
	writeFileSync(file, body, { mode: 0o700 });
	chmodSync(file, 0o700);
	const pairs = plan.pairs.filter(([name]) => name !== "gpg.ssh.program");
	return { ...plan, pairs: [...pairs, ["gpg.ssh.program", file]] };
}

function configEnv(pairs: readonly Pair[]): Record<string, string> {
	if (pairs.length === 0) return {};
	const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
	pairs.forEach(([name, value], n) => {
		env[`GIT_CONFIG_KEY_${n}`] = name;
		env[`GIT_CONFIG_VALUE_${n}`] = value;
	});
	return env;
}

const cache = new WeakMap<NodeJS.ProcessEnv, Map<string, WorkerSigning>>();
/**
 * The host's signing for a worker's git in `worktree`, read once per env and worktree. A key the worktree's own
 * config sets is never passed, so the repository wins as in plain git; a failed read fails closed.
 */
export function workerSigning(env: NodeJS.ProcessEnv, worktree: string): WorkerSigning {
	const known = cache.get(env) ?? new Map<string, WorkerSigning>();
	cache.set(env, known);
	const found = known.get(worktree);
	if (found !== undefined) return found;
	let plan: SigningPlan;
	try {
		const read: SigningRead = (name, bool) =>
			(hasGlobalConfig(env) ? gitValue(globalConfigArgs(name, bool), env) : undefined);
		plan = withSigner(evaluateSigning(read, env), env.CP_RUN_DIR);
		const local = (name: string) => gitValue(["config", "--local", "--get", name], env, worktree) !== undefined;
		if (plan.state !== "off") plan = { ...plan, pairs: plan.pairs.filter(([name]) => !local(name)) };
	} catch (error) {
		const why = `the host's git config could not be read (${(error as Error).message})`;
		plan = unavailablePlan(why, [["commit.gpgsign", "true"]]);
	}
	const signing: WorkerSigning = {
		state: plan.state, why: plan.why, secrets: plan.secrets,
		env: { ...configEnv(plan.pairs), ...(plan.gnupg === undefined ? {} : { GNUPGHOME: plan.gnupg }) },
	};
	known.set(worktree, signing);
	return signing;
}
