/**
 * Guard fixture (um58 #17): a file whose whole suite is skipped on purpose.
 * Skip is a reported test, so the guard must treat this file as ran.
 */
import { describe, it } from "node:test";

describe("a suite skipped on purpose", () => {
	it("never runs", { skip: true }, () => {});
});
