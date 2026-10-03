/**
 * Preloaded by `npm test` (`--import`): drop the variables a command-post
 * worker or operator session exports, so the suite reads the same environment
 * inside a worker as it does in CI. Loaded in the runner process first, so
 * every test file's process inherits the scrubbed environment.
 *
 * Only session identity is dropped. PI_LENS_HOME stays: a pi child that loads
 * pi-lens without it logs into its cwd (tests that spawn pi assert a clean
 * tree), so tests/worker-packages.test.ts drops it from its own planned env.
 * Opt-ins a human sets on purpose (CP_LIVE_TESTS, CP_LIVE_MODEL,
 * CP_PARENT_MODEL, …) are left alone.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { STRIPPED_ENV_KEYS } from "../../src/worker-manager.ts";

const SESSION_ENV_KEYS: readonly string[] = [
	...STRIPPED_ENV_KEYS,
	"CP_HOME",
	"CP_MODE",
	"CP_HEADLESS",
	"CP_JOB_ID",
	"CP_KIND",
	"CP_DELIVERY",
	"CP_ROLE",
	"CP_RUN_DIR",
	"CP_WORKTREE",
	"CP_ARTIFACT_PATH",
	"CP_ASK_OPERATOR",
];

for (const key of SESSION_ENV_KEYS) delete process.env[key];

// A CI runner has no global git identity, and scripted workers commit in leased
// worktrees of plain clones. Default one (never override a host's own) so every
// spawned child can commit.
process.env.GIT_AUTHOR_NAME ??= "cp test";
process.env.GIT_AUTHOR_EMAIL ??= "cp@test.invalid";
process.env.GIT_COMMITTER_NAME ??= "cp test";
process.env.GIT_COMMITTER_EMAIL ??= "cp@test.invalid";

// The real ~/.pi is never a valid test target: any test (or code under test) that
// falls back to `process.env.PI_HOME` without an explicit override must still land in
// a scratch home, never the operator's real one (pi-command-post-6wn). Individual tests
// may still set PI_HOME to their own scratch dir; this is only the default floor.
const scratchHome = mkdtempSync(join(tmpdir(), "cp-hermetic-pi-home-"));
process.env.PI_HOME = scratchHome;

// pi-command-post-6wn: guard the real selector across the whole process, not just one
// test file — any test process (this file is preloaded into every one of them) that
// writes to the operator's real ~/.pi/command-post/operator-targets/selected.json is a
// regression, however it got there.
const REAL_SELECTOR = resolve(homedir(), ".pi", "command-post", "operator-targets", "selected.json");

function selectorSnapshot(): { existed: boolean; mtimeMs: number; hash: string } | undefined {
	if (!existsSync(REAL_SELECTOR)) return undefined;
	const stat = statSync(REAL_SELECTOR);
	const hash = createHash("sha256").update(readFileSync(REAL_SELECTOR)).digest("hex");
	return { existed: true, mtimeMs: stat.mtimeMs, hash };
}

const before = selectorSnapshot();

process.on("exit", () => {
	rmSync(scratchHome, { recursive: true, force: true });
	const after = selectorSnapshot();
	const changed = before === undefined ? after !== undefined : after === undefined || after.mtimeMs !== before.mtimeMs || after.hash !== before.hash;
	if (changed) {
		process.stderr.write(`[pi-command-post-6wn] the real operator-target selector changed during this test run: ${REAL_SELECTOR}\n`);
		process.exitCode = 1;
	}
});
