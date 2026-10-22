/**
 * A deterministic `gh` for every e2e spawn: the preload puts this stub first on PATH, so the host's real gh
 * (and its auth) is never reached. Scenario bins prepended later still win.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

// `--version` replays the host gh's, so doctor's host.gh.conflict sees one version, not two.
const STUB = `#!/bin/sh
case "$*" in
	"--version") cat "$(dirname "$0")/version.txt"; exit 0 ;;
	"api user --jq .login") echo cp-e2e-stub; exit 0 ;;
esac
echo "gh stub: no scripted gh in this e2e scenario" >&2
exit 1
`;

/** Create the stub dir and return it. */
export function installGhStub(): string {
	const dir = mkdtempSync(join(tmpdir(), "cp-hermetic-gh-"));
	const host = spawnSync("gh", ["--version"], { encoding: "utf8" });
	writeFileSync(join(dir, "version.txt"), host.status === 0 ? host.stdout : "gh version 0.0.0\n");
	writeFileSync(join(dir, "gh"), STUB, { mode: 0o755 });
	return dir;
}

/** The first `gh` on `path`, if any. */
export function resolveGh(path: string | undefined): string | undefined {
	for (const dir of (path ?? "").split(delimiter)) {
		if (!dir) continue;
		try { accessSync(join(dir, "gh"), constants.X_OK); return join(dir, "gh"); } catch { /* next dir */ }
	}
	return undefined;
}

/** Throws when a spawn's PATH resolves a gh that is neither the stub nor a scenario bin under tmpdir. */
export function assertNoHostGh(path: string | undefined): void {
	const gh = resolveGh(path);
	if (gh && !resolve(dirname(gh)).startsWith(resolve(tmpdir()))) throw new Error(`e2e spawn would resolve the host gh: ${gh}`);
}
