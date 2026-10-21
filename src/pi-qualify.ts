/**
 * pi version tracking: the qualify job's naming (one open PR per pi version) and doctor's `host.pi.drift` warning
 * for a host pi above piCompat.testedMax for more than DRIFT_DAYS with no qualify PR open. Warns, never errors.
 */
import type { DoctorFinding } from "./contracts.ts";
import type { PiCompatResult } from "./pi-compat.ts";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const DRIFT_DAYS = 7;
export const PI_DRIFT_CHECK = "host.pi.drift";

/** The qualify job's title and PR title: the one key that makes "at most one per pi version" checkable. */
export const qualifyTitle = (version: string): string => `qualify pi ${version}`;

/** `prListed` is false when gh could not say: an unknown PR state is never reported as "no PR". */
export interface PiDriftFacts { releasedAt?: Date; qualifyPr?: string; prListed?: boolean; unreadable?: string }
export type Sh = (command: string, args: string[]) => { status: number | null; stdout: string };

/** Release time of `version` (npm `time`) and the open qualify PR. Never throws: a failed or non-JSON answer sets `unreadable`. */
export function readDriftFacts(version: string, sh: Sh): PiDriftFacts {
	const facts: PiDriftFacts = {};
	const read = (command: string, args: string[]): unknown => {
		let out = "";
		try {
			const r = sh(command, args);
			out = r.stdout ?? "";
			if (r.status === 0) return JSON.parse(out);
		} catch (error) {
			out = `${(error as Error).message} ${out}`;
		}
		facts.unreadable ??= `${[command, ...args].join(" ")}: ${out.slice(0, 200) || "no output"}`;
		return undefined;
	};
	const time = read("npm", ["view", PI_PACKAGE, "time", "--json"]) as Record<string, string> | undefined;
	const at = time?.[version];
	if (at && !Number.isNaN(Date.parse(at))) facts.releasedAt = new Date(at);
	const prs = read("gh", ["pr", "list", "--state", "open", "--search", `"${qualifyTitle(version)}" in:title`, "--json", "title,url"]);
	if (Array.isArray(prs)) {
		facts.prListed = true;
		const hit = (prs as Array<{ title: string; url: string }>).find((pr) => pr.title?.startsWith(qualifyTitle(version)));
		if (hit) facts.qualifyPr = hit.url;
	}
	return facts;
}

/** A warn only for a newer host pi released more than `days` ago with no qualify PR; absent otherwise or when the age is unknown. */
export function piDriftFinding(result: PiCompatResult, testedMax: string, facts: PiDriftFacts, now: Date, days = DRIFT_DAYS): DoctorFinding | undefined {
	if (result.state !== "newer" || !result.version || !facts.releasedAt || !facts.prListed || facts.qualifyPr) return undefined;
	const age = Math.floor((now.getTime() - facts.releasedAt.getTime()) / 86_400_000);
	if (age <= days) return undefined;
	return { check: PI_DRIFT_CHECK, severity: "warn", what: `host pi ${result.version} is ${age} days past release but above the tested ${testedMax}, and no "${qualifyTitle(result.version)}" PR is open`, fix: `run the pi-version-watch schedule, or open "${qualifyTitle(result.version)}" (bump the devDependency and piCompat.testedMax together)` };
}
