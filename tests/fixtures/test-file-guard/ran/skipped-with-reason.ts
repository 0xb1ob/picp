/**
 * Guard fixture (um58 #17): a file whose only top-level item is a suite skipped
 * with a reason string — the conditional-skip form. Node reports the reason in
 * the completion's `skip`, not `true`, so a rule that counted only `skip === true`
 * would call this file silent.
 */
import { describe, it } from "node:test";

describe("skipped with a reason string", { skip: "the conditional-skip form" }, () => {
	it("never runs", () => {});
});
