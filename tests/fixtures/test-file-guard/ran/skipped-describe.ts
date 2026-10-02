/**
 * Guard fixture (um58 #17): a file whose only top-level items are skipped
 * suites. `describe.skip` and `describe(name, { skip: true })` replace the body
 * with a noop, so no child test ever reports — the suite's own completion is the
 * only evidence, and the guard must treat it as a file that ran.
 */
import { describe, it } from "node:test";

describe.skip("skipped with describe.skip", () => {
	it("never runs", () => {});
});

describe("skipped by option", { skip: true }, () => {
	it("never runs either", () => {});
});
