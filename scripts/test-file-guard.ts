/**
 * The suite's file-coverage guard (um58 #17, cp-pr8y).
 *
 * `npm test` asks the runner for every file matching `TEST_FILE_GLOB`, and
 * nothing used to compare that set to the files that actually produced a test.
 * A file that was silently skipped — or that registers nothing at all — left
 * the run green, which breaks the "nothing may look like nothing" rule.
 *
 * This is the suite's second `--test-reporter`: it watches every file's
 * `test:complete` events and, once the run ends, fails naming each discovered
 * file that reported neither a test nor a skip. `test:one` never loads it, so a
 * focused run is unchanged. A deliberately skipped file never trips the guard:
 * `test.skip` is a `type: "test"` completion, and a suite skipped whole
 * (`describe.skip`, or `describe(name, { skip: true })`) replaces its body with a
 * noop, so the suite's own `type: "suite"` completion is the one that carries the
 * `skip` — `true`, or the reason string a conditional skip passes
 * (`{ skip: "flaky on CI" }`).
 */
import { globSync } from "node:fs";
import { resolve } from "node:path";
import { Transform } from "node:stream";
import type { TransformCallback, TransformOptions } from "node:stream";

/**
 * The pattern `npm test` passes to the runner. `CP_TEST_FILE_GLOB` exists only
 * so the guard's own test can point it at fixtures; CI uses the default.
 */
export const TEST_FILE_GLOB = process.env.CP_TEST_FILE_GLOB ?? "tests/**/*.test.ts";

interface TestEventData {
	name?: string;
	file?: string;
	nesting?: number;
	skip?: boolean | string;
	todo?: boolean | string;
	details?: { type?: string };
}

interface TestEvent {
	type?: string;
	data?: TestEventData;
}

/**
 * The runner wraps every file in its own root test. That root is not a test the
 * file registered: it is named after the path and passes even when the file
 * declares nothing. Everything else (a test, a skip, a todo) is the file's own.
 */
export function isFileRoot(data: TestEventData): boolean {
	return data.nesting === 0 && typeof data.name === "string" && data.file !== undefined && resolve(data.name) === data.file;
}

/**
 * A file reported when a completion is one of its own tests — a pass, a failure,
 * a `test.skip`, a todo — or a suite it skipped whole (`describe.skip` and
 * `describe(name, { skip: true })` replace the body with a noop, so the suite's
 * own completion is the only evidence the file did anything). A directive can
 * carry a reason string instead of `true` (`{ skip: "flaky on CI" }`), so any
 * defined, non-`false` `skip`/`todo` counts.
 */
export function reportedAsTestOrSkip(data: TestEventData): boolean {
	const skipped = data.skip !== undefined && data.skip !== false;
	const todo = data.todo !== undefined && data.todo !== false;
	return data.details?.type === "test" || skipped || todo;
}

/** Discovered files that reported no test of their own, resolved and sorted. */
export function filesProducingNothing(discovered: readonly string[], reported: ReadonlySet<string>): string[] {
	return discovered
		.map((file) => resolve(file))
		.filter((file) => !reported.has(file))
		.sort();
}

export default class TestFileGuard extends Transform {
	readonly #reported = new Set<string>();

	constructor(options?: TransformOptions) {
		super({ ...options, writableObjectMode: true });
	}

	override _transform(event: TestEvent, _encoding: BufferEncoding, callback: TransformCallback): void {
		const data = event.data;
		if (event.type === "test:complete" && data?.file !== undefined && !isFileRoot(data) && reportedAsTestOrSkip(data)) {
			this.#reported.add(resolve(data.file));
		}
		callback(null, "");
	}

	override _flush(callback: TransformCallback): void {
		// Synchronous on purpose: `--test-force-exit` (which `npm test` passes)
		// ends the process without awaiting async reporter work, so a flush that
		// awaited its glob could be cut off — and the guard would pass by default.
		try {
			const discovered = globSync(TEST_FILE_GLOB);
			const missing = filesProducingNothing(discovered, this.#reported);
			if (discovered.length === 0) {
				process.stderr.write(
					`\ntest-file-guard found no test files for ${TEST_FILE_GLOB} — a pattern that matches nothing is silence, not a pass.\n`,
				);
				process.exitCode = 1;
			} else if (missing.length > 0) {
				process.stderr.write(
					`\n${missing.length} test file(s) produced no test and no skip:\n` +
						missing.map((file) => `  ${file}`).join("\n") +
						`\nThey matched ${TEST_FILE_GLOB} but the runner reported nothing for them — a missing test is a failure, not silence.\n`,
				);
				process.exitCode = 1;
			}
		} catch (error) {
			process.stderr.write(`test-file-guard could not check ${TEST_FILE_GLOB}: ${String(error)}\n`);
			process.exitCode = 1;
		}
		callback();
	}
}
