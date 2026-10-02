/**
 * Run registry: one `RunRecorder` per job, per process.
 *
 * `events.jsonl` is append-only with a monotonic `seq`, which only works if a
 * single writer owns it. Dispatch, send, envelope intake and teardown all want
 * to append markers to the same run, so they share one recorder instead of
 * each opening its own (two recorders would rebuild the same log and then race
 * on `seq`).
 */

import type { RunMeta } from "./run-artifacts.ts";
import { RunRecorder } from "./run-artifacts.ts";

export class RunRegistry {
	readonly home: string;
	readonly #recorders = new Map<string, RunRecorder>();

	constructor(home: string) {
		this.home = home;
	}

	/** The recorder for this job, opened (and remembered) on first use. */
	open(jobId: string, meta: RunMeta = {}): RunRecorder {
		const existing = this.#recorders.get(jobId);
		if (existing) return existing;
		const recorder = RunRecorder.open({ home: this.home, jobId, meta });
		this.#recorders.set(jobId, recorder);
		return recorder;
	}

	get(jobId: string): RunRecorder | undefined {
		return this.#recorders.get(jobId);
	}

	/** Flush and forget one run (teardown, or a dispatch that failed). */
	close(jobId: string): void {
		const recorder = this.#recorders.get(jobId);
		if (!recorder) return;
		this.#recorders.delete(jobId);
		recorder.close();
	}

	closeAll(): void {
		for (const jobId of [...this.#recorders.keys()]) this.close(jobId);
	}
}
