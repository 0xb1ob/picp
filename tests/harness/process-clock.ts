/**
 * `--import` preload for a child process under test: shifts every `Date` reading by the integer milliseconds in the
 * file `CP_TEST_CLOCK_FILE` names, re-read on each call, so a test advances a real process's clock by rewriting it.
 */
import { readFileSync } from "node:fs";

const file = process.env.CP_TEST_CLOCK_FILE;
if (file) {
	const Real = Date;
	const shifted = (): number => {
		const offset = Number(readFileSync(file, "utf8"));
		if (!Number.isInteger(offset)) throw new Error(`${file}: not an integer millisecond offset`);
		return Real.now() + offset;
	};
	globalThis.Date = new Proxy(Real, {
		construct: (target, args, newTarget) => Reflect.construct(target, args.length === 0 ? [shifted()] : args, newTarget),
		apply: () => new Real(shifted()).toString(),
		get: (target, prop, receiver) => (prop === "now" ? shifted : Reflect.get(target, prop, receiver)),
	});
}
