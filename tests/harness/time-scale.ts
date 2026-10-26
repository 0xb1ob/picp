/**
 * `--import` preload for a daemon process under test: its clock runs `CP_TEST_TIME_SCALE` times faster from the
 * shared epoch `CP_TEST_TIME_ZERO` (ms), and every timer waits that many times less, so processes agree on the time.
 */
const scale = Number(process.env.CP_TEST_TIME_SCALE);
const zero = Number(process.env.CP_TEST_TIME_ZERO);
if (scale > 0 && Number.isFinite(zero)) {
	const Real = Date;
	const realNow = Real.now.bind(Real);
	const now = (): number => Math.round(zero + (realNow() - zero) * scale);
	globalThis.Date = new Proxy(Real, {
		construct: (target, args, newTarget) => Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget),
		apply: () => new Real(now()).toString(),
		get: (target, prop, receiver) => (prop === "now" ? now : Reflect.get(target, prop, receiver)),
	});
	const shrink = (ms: unknown): number => Math.max(0, Number(ms ?? 0) / scale);
	const { setTimeout: realTimeout, setInterval: realInterval } = globalThis;
	globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => realTimeout(fn, shrink(ms), ...rest)) as typeof setTimeout;
	globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => realInterval(fn, shrink(ms), ...rest)) as typeof setInterval;
}
