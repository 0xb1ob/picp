/**
 * Test harness (m0). Shared by every later task's tests and by the milestone
 * E2E gates. Product code must never import from here.
 */

// Side effect: every file that uses the harness fails loudly instead of hanging when it cannot exit.
import "./exit-watchdog.ts";
// Side effect: a bare `node --test <file>` (no `--import` preload) still gets the scratch PI_HOME, never the real ~/.pi.
import "./hermetic-env.ts";

export { type AgentDir, type AgentDirOptions, createAgentDir } from "./agent-dir.ts";
export { createScratchLedger, type ScratchLedger, type ScratchLedgerOptions } from "./ledger.ts";
export {
	MOCK_API_KEY,
	MOCK_PROVIDER_ID,
	MockProvider,
	type MockToolCall,
	type MockUsage,
	type RecordedRequest,
	type ScriptOptions,
	type ScriptStep,
} from "./mock-provider.ts";
export {
	buildPiArgs,
	COMMAND_POST_EXTENSION,
	commandPostSource,
	CP_BRIDGE_EXTENSION,
	type PiChild,
	type PiChildOptions,
	REPO_ROOT,
	startPiChild,
	WORKER_REPORTER_EXTENSION,
} from "./pi-child.ts";
export { assertGolden, GOLDEN_DIR, goldenPath, UPDATE_GOLDEN } from "./golden.ts";
export { argOf, type CapturedSpawn, captureSpawns } from "./spawns.ts";
export { hostPiVersionConflict, noModelAuthFinding } from "./host-pi.ts";
export { type RpcRecord, type RpcSession, startRpc } from "./rpc.ts";
export {
	enableTreehouse,
	leaseState,
	type PoolEntry,
	poolStatus,
	treehouse,
	treehouseAvailable,
	type TreehousePool,
} from "./treehouse.ts";
export {
	advanceBase,
	createScratchRepo,
	git,
	rebaseMergeAndDeleteHead,
	type ScratchRepo,
	type ScratchRepoOptions,
	squashMergeAndDeleteHead,
} from "./scratch-repo.ts";
export {
	assertEventSequence,
	createScratchHome,
	readFleet,
	readRunEvents,
	readRunStatus,
	type ScratchHome,
	waitFor,
} from "./state.ts";
export { type FakeFleet, type FakeWorker, fakeWorker, fakeWorkerManager } from "./fake-worker.ts";
/** Live-model suites are operator-run only (see PLAN.md testing strategy). */
export const LIVE_TESTS_ENABLED = process.env.CP_LIVE_TESTS === "1";
