/**
 * A controllable stand-in for `WorkerProcess`, spawned through `WorkerManager`'s
 * `spawnFn` (4b-1 tests). No child process: liveness, busy and shutdown are
 * plain fields the test drives.
 */
import { DEFAULT_BUDGET_CONFIG } from "../../src/contracts.ts";
import { WorkerManager, type WorkerManagerOptions } from "../../src/worker-manager.ts";
import { join } from "node:path";
import { loadProfile } from "../../src/profiles.ts";
import { REPO_ROOT, WORKER_REPORTER_EXTENSION } from "./pi-child.ts";

export interface FakeWorker {
	pid: number;
	alive: boolean;
	busy: boolean;
	closed: Promise<{ code: number; signal: null }>;
	shutdownCalls: number;
	sent: string[];
	/** Resolves `closed` and marks the worker dead (an observed exit). */
	exit(): void;
	shutdown(): Promise<unknown>;
	onEvent(listener: unknown): () => void;
	send(message: string, mode?: string): Promise<{ receipt: "delivered" }>;
	prompt(message: string): Promise<void>;
	getState(): Promise<Record<string, unknown>>;
}

let nextPid = 900_000;

/** `shutdown` defaults to an immediate observed exit; pass one to defer or reject it. */
export function fakeWorker(overrides: Partial<Pick<FakeWorker, "busy" | "alive">> & { shutdown?: (worker: FakeWorker) => Promise<unknown> } = {}): FakeWorker {
	let resolveClosed!: (value: { code: number; signal: null }) => void;
	const worker: FakeWorker = {
		pid: nextPid++,
		alive: overrides.alive ?? true,
		busy: overrides.busy ?? false,
		closed: new Promise((resolve) => {
			resolveClosed = resolve;
		}),
		shutdownCalls: 0,
		sent: [],
		exit() {
			worker.alive = false;
			resolveClosed({ code: 0, signal: null });
		},
		async shutdown() {
			worker.shutdownCalls += 1;
			if (overrides.shutdown) return overrides.shutdown(worker);
			worker.exit();
			return { code: 0, signal: null, at: Date.now() };
		},
		onEvent: () => () => {},
		async send(message: string) {
			worker.sent.push(message);
			return { receipt: "delivered" };
		},
		async prompt(message: string) {
			worker.sent.push(message);
		},
		async getState() {
			return { sessionId: `s-${worker.pid}`, sessionFile: `/sessions/s-${worker.pid}.jsonl` };
		},
	};
	return worker;
}

export interface FakeFleet {
	manager: WorkerManager;
	/** Spawn `key` through the real manager with `worker` (default: an idle fake) as its process. */
	spawn(key: string, worker?: FakeWorker, profile?: "implementer" | "gate-reviewer"): FakeWorker;
	/** The next process start (by anyone, through `manager.spawn`) throws. */
	failNext(): void;
}

/** A real WorkerManager whose spawns are fakes. */
export function fakeWorkerManager(home: string, cap: number, options: Partial<WorkerManagerOptions> = {}): FakeFleet {
	let next: FakeWorker | undefined;
	let fail = false;
	const manager = new WorkerManager({
		home,
		workerReporterPath: WORKER_REPORTER_EXTENSION,
		budget: { ...DEFAULT_BUDGET_CONFIG, spawn_cap: cap },
		spawnFn: () => {
			if (fail) {
				fail = false;
				throw new Error("spawn failed");
			}
			const worker = next ?? fakeWorker();
			next = undefined;
			return worker as never;
		},
		...options,
	});
	return {
		manager,
		failNext() {
			fail = true;
		},
		spawn(key, worker = fakeWorker(), profile = "implementer") {
			next = worker;
			manager.spawn({
				key,
				identity: { jobId: key.split("#")[0]!, kind: "ship", delivery: "pr", worktree: home, runDir: home },
				profile: loadProfile(join(REPO_ROOT, "profiles"), profile),
				model: "mock/unused",
			});
			return worker;
		},
	};
}
