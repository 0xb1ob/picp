/**
 * Host precondition: **exactly one `pi` version on PATH**.
 *
 * `npm test` puts `node_modules/.bin` first on PATH, so the pinned
 * devDependency's `pi` *and* the developer's installed `pi` both answer. When
 * those two differ, `/doctor` reports `host.pi.conflict` as an error — and it is
 * right: PATH order really would decide which pi a worker gets. CI installs no
 * host pi, so only the devDependency answers and there is no conflict there.
 *
 * The two live-doctor tests that assert "a clean machine is dispatchable" need
 * that precondition. They use this to tolerate exactly `host.pi.conflict` (and
 * nothing else) with a stated reason, instead of being skipped or softened — the
 * real fix is to keep the pinned devDependency and the installed pi on the same
 * version (cp-q0g).
 */

import { execFileSync } from "node:child_process";
import { whichAll } from "../../src/doctor.ts";

function versionOf(path: string): string {
	try {
		return execFileSync(path, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "(version unknown)";
	}
}

/**
 * A human-readable reason when this host has more than one `pi` version on
 * PATH, or `null` when the precondition holds.
 */
export function hostPiVersionConflict(): string | null {
	const paths = whichAll("pi");
	if (paths.length < 2) return null;
	const byVersion = new Map<string, string[]>();
	for (const path of paths.slice(0, 8)) {
		const version = versionOf(path);
		byVersion.set(version, [...(byVersion.get(version) ?? []), path]);
	}
	if (byVersion.size < 2) return null;
	return [...byVersion.entries()].map(([version, found]) => `${version}: ${found[0]}`).join(" | ");
}

/**
 * True only for a `models.*` doctor error that says this host has **no
 * authenticated model at all**. Every candidate was refused for `availability`
 * (never `allowlist` or `effort`), and the probe listed `Available: (none).`.
 * CI is that host on purpose: it has no `pi auth`, and `CP_LIVE_TESTS` stays
 * empty. The live-doctor tests use this on CI to tolerate exactly these
 * findings. A routing, allowlist or effort regression still fails.
 */
export function noModelAuthFinding(finding: { check: string; severity: string; detail?: string }): boolean {
	const detail = finding.detail ?? "";
	return (
		finding.check.startsWith("models.") &&
		finding.severity === "error" &&
		detail.endsWith("Available: (none).") &&
		/\(availability\)|is not usable/.test(detail) &&
		!/\((?:allowlist|effort)\)/.test(detail)
	);
}
