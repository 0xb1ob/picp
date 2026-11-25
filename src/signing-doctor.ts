/**
 * `/doctor` worker commit signing, one line per driver, from the same global read the workers make
 * (worker-signing.ts). Kept out of doctor.ts, which sits at its ceiling.
 */
import type { DoctorFinding } from "./contracts.ts";
import type { CommandRunner } from "./doctor.ts";
import {
	evaluateSigning, globalConfigArgs, hasGlobalConfig, SIGNING_UNAVAILABLE, type SigningPlan, unavailablePlan,
} from "./drivers/worker-signing.ts";

const WHO = { pi: "pi workers", claude: "Claude CLI workers", codex: "Codex workers" } as const;
type Driver = keyof typeof WHO;
const REACH = {
	file: "the key file is readable by the worker's own uid",
	agent: "the ssh agent socket is reachable by the worker's own uid, though only picp's signer is handed it",
	gnupg: "the GnuPG home and its agent are reachable by the worker's own uid",
} as const;
const DEDICATED = "use a dedicated ssh-agent (or a gpg key) that holds only the signing key";
const REACHABLE = "start picp with SSH_AUTH_SOCK naming the ssh-agent that holds the key, point user.signingkey "
	+ "at a readable key file, or set GNUPGHOME (openpgp)";

/** One driver's line: ok when unsigned; a Claude or Codex worker warns whenever its uid can reach the key. */
function finding(driver: Driver, plan: SigningPlan): DoctorFinding {
	const check = `signing.${driver}`;
	const who = WHO[driver];
	if (plan.state === "off") return { check, severity: "ok", what: `${who}: commits unsigned; ${plan.why}` };
	if (plan.state === "unavailable") {
		const fails = driver === "pi" ? "commits fail (git's own error)" : `commits fail with ${SIGNING_UNAVAILABLE}`;
		return { check, severity: "warn", what: `${who}: ${fails}: ${plan.why}`, fix: REACHABLE };
	}
	const signed = `${who}: commits signed (${plan.why})`;
	if (driver === "pi") {
		return { check, severity: "ok", what: signed, detail: "pi's git reads the host's own config" };
	}
	const guard = driver === "claude"
		? "; Read, Grep and Bash refuse the key path, best effort only"
		: "; picp's tool-call guard refuses the key path, best effort only (the kernel profile is not narrowed)";
	return {
		check, severity: "warn", what: `${signed}; the key is reachable by the worker's shell`,
		detail: `${REACH[plan.reach ?? "file"]}${guard}`, fix: DEDICATED,
	};
}

export function signingFindings(o: { home: string; env: NodeJS.ProcessEnv; run: CommandRunner }): DoctorFinding[] {
	const read = (name: string, bool: boolean): string | undefined => {
		if (!hasGlobalConfig(o.env)) return undefined;
		const got = o.run("git", globalConfigArgs(name, bool), o.home);
		if (got.status === 0) return got.stdout.trim() || undefined;
		if (got.status === 1) return undefined;
		throw new Error(`git config --global --get ${name} exited ${got.status ?? "on a signal"}`);
	};
	let plan: SigningPlan;
	try {
		plan = evaluateSigning(read, o.env);
	} catch (error) {
		plan = unavailablePlan(`the host's git config could not be read (${(error as Error).message})`);
	}
	return (Object.keys(WHO) as Driver[]).map((driver) => finding(driver, plan));
}
