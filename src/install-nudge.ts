/**
 * Install nudge (cp-install-nudge-5o4) — the discovery half `install-tools`
 * (cp-lvo) was missing.
 *
 * `/doctor` names a missing tool and stays read-only by design (see
 * docs/contracts.md §install-tools); `node scripts/install-tools.ts` gets it
 * onto PATH but nothing points a fresh clone's user at it. This module closes
 * that gap with a single, quiet check reused at the point a new user actually
 * hits the wall (today: the parent extension's `session_start`):
 *
 *  - **Reuses the existing detection.** No second probe: it walks
 *    `REQUIRED_TOOLS` with the same `which` shape `doctor.ts#whichAll` and
 *    `install-tools.ts` already use, injected so tests never touch a real PATH.
 *  - **Names the exact command.** `npm run doctor:install`, not a paraphrase —
 *    that script is `scripts/install-tools.ts` with no arguments, so it covers
 *    every missing tool in one run.
 *  - **Silent when nothing is missing.** No finding, no message: a nag on every
 *    session once the toolchain is installed is the failure mode this is
 *    designed not to have.
 *  - **Never installs, never sudo.** This module only formats a string; it
 *    calls nothing that touches the filesystem or the network.
 */

import { REQUIRED_TOOLS, type RequiredTool } from "./tool-manifest.ts";

export interface InstallNudgeOptions {
	/** Same shape as `doctor.ts#whichAll`: every match on PATH, in order. */
	which: (command: string) => string[];
}

/**
 * `undefined` when every `REQUIRED_TOOLS` entry resolves on PATH — the caller
 * shows nothing in that case. Otherwise a short, one-line-per-tool nudge
 * naming `npm run doctor:install`.
 */
export function computeInstallNudge(options: InstallNudgeOptions): string | undefined {
	const missing: RequiredTool[] = REQUIRED_TOOLS.filter((tool) => options.which(tool).length === 0);
	if (missing.length === 0) return undefined;
	// Deliberately not prefixed with the package name: `/cp-version` and the
	// scaffold notify both use it, and a caller distinguishing "the version/home
	// line" from "something else" by that substring (tests/e2e/packaging.test.ts
	// does exactly this on a fresh home, where br/treehouse are genuinely
	// missing) must not see this notify instead of the one it is waiting for.
	return [
		`install: missing from PATH: ${missing.join(", ")}`,
		"run `npm run doctor:install` to install them (never sudo; run `npm run doctor:preflight` to check first)",
	].join("\n");
}
