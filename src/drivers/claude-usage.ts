/** N4a: a native run's usage, measured from the SDK result's `modelUsage` on every subtype, and its denials. */
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { NativeSession } from "./claude-followup.ts";

export type NativeBaseline = NonNullable<NativeSession["baseline"]>;
type Counts = { input: number; output: number; cache_read: number; cache_write: number };
/** A shutdown's wait for an unreported in-flight turn's `result`, inside the parent's stdin grace. */
export const NATIVE_RESULT_GRACE_MS = 4_000;
/** The same wait once a report or verdict was accepted: the parent stops a reviewer as soon as its verdict lands. */
export const NATIVE_REPORTED_GRACE_MS = 45_000;
/** The parent's stdin→SIGTERM grace for a native worker: the reported wait plus claude's own exit after the abort. */
export const NATIVE_SHUTDOWN_GRACE_MS = NATIVE_REPORTED_GRACE_MS + 12_000;

/** pi's `message_end` usage shape (run-artifacts `readUsage`); `input` excludes cache read and write. */
export interface PiUsage { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { total: number } }

export interface NativeRunUsage {
	/** `unavailable`: no result or no tokens reported; `unbaselined`: the growth since the baseline is unknown;
	 * `estimated`: no result, so the streamed assistant usage stands in. */
	status: "complete" | "unavailable" | "unbaselined" | "estimated";
	usage?: PiUsage;
	/** The estimate's tokens have no price: picp holds no per-model cost table, so its cost is 0. */
	cost_unknown?: true;
	/** This result's cumulative totals, the next resume's baseline; absent when `modelUsage` is unreadable. */
	baseline?: NativeBaseline;
}

const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);

/** Per-model cumulative counts and the session cost; undefined when `modelUsage` is absent, empty or malformed. */
function totals(result: SDKResultMessage): { ledger: Map<string, Counts>; cost: number } | undefined {
	const models = Object.entries(result.modelUsage ?? {});
	if (models.length === 0) return undefined;
	const ledger = new Map<string, Counts>();
	let cost = 0;
	for (const [model, entry] of models) {
		const [input, output] = [count(entry.inputTokens), count(entry.outputTokens)];
		if (input === undefined || output === undefined || !(entry.costUSD >= 0) || !Number.isFinite(entry.costUSD)) return undefined;
		ledger.set(model, { input, output, cache_read: count(entry.cacheReadInputTokens) ?? 0, cache_write: count(entry.cacheCreationInputTokens) ?? 0 });
		cost += entry.costUSD;
	}
	// Cross-check: the larger of the per-model sum and `total_cost_usd`, so a disagreement never under-counts.
	return { ledger, cost: Number.isFinite(result.total_cost_usd) && result.total_cost_usd > cost ? result.total_cost_usd : cost };
}

/** Growth over the baseline; undefined when a model is gone or a counter went backwards (a reset, not usage). */
function growth(now: ReadonlyMap<string, Counts>, baseline: NativeBaseline): Counts | undefined {
	if (Object.keys(baseline.ledger).some((model) => !now.has(model))) return undefined;
	const sum: Counts = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
	for (const [model, at] of now) {
		const before = baseline.ledger[model] ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 };
		// A pre-N4a baseline has no cache split: its whole input growth counts as uncached input, the side that binds.
		const read = at.cache_read - (before.cache_read ?? at.cache_read);
		const write = at.cache_write - (before.cache_write ?? at.cache_write);
		const input = at.input + at.cache_read + at.cache_write - before.input - read - write;
		const output = at.output - before.output;
		if (Math.min(input, output, read, write) < 0) return undefined;
		sum.input += input;
		sum.output += output;
		sum.cache_read += read;
		sum.cache_write += write;
	}
	return sum;
}

/**
 * One run's usage from its result (any subtype) over the session baseline; a resumed process restores the cumulative
 * `modelUsage`, so only the growth counts. No result, or zero tokens, stays unavailable: never a measured 0.
 */
export function nativeRunUsage(result: SDKResultMessage | undefined, baseline: NativeBaseline | undefined): NativeRunUsage {
	const now = result === undefined ? undefined : totals(result);
	if (now === undefined) return { status: "unavailable" };
	const ledger = Object.fromEntries([...now.ledger].map(([model, at]) => [model, { ...at, input: at.input + at.cache_read + at.cache_write }]));
	const next: NativeBaseline = { ledger, cost_usd: now.cost };
	const grew = baseline === undefined ? undefined : growth(now.ledger, baseline);
	const cost = baseline === undefined ? Number.NaN : now.cost - baseline.cost_usd;
	if (grew === undefined || !(cost >= 0)) return { status: "unbaselined", baseline: next };
	const totalTokens = grew.input + grew.output + grew.cache_read + grew.cache_write;
	if (totalTokens === 0) return { status: "unavailable", baseline: next };
	const usage = { input: grew.input, output: grew.output, cacheRead: grew.cache_read, cacheWrite: grew.cache_write, totalTokens, cost: { total: cost } };
	return { status: "complete", usage, baseline: next };
}

/** One streamed assistant message's usage, keyed by message id; the CLI repeats a message per content block. */
export type StreamedUsage = Map<string, Counts & { model: string }>;

/** Notes an SDK assistant message's usage once per message id, keeping each counter's largest value. */
export function noteStreamedUsage(seen: StreamedUsage, message: SDKMessage): void {
	if (message.type !== "assistant") return;
	const { id, model, usage } = message.message;
	if (typeof id !== "string" || typeof usage !== "object" || usage === null) return;
	const at = { input: count(usage.input_tokens) ?? 0, output: count(usage.output_tokens) ?? 0, cache_read: count(usage.cache_read_input_tokens) ?? 0, cache_write: count(usage.cache_creation_input_tokens) ?? 0 };
	const before = seen.get(id) ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 };
	seen.set(id, {
		model: String(model), input: Math.max(at.input, before.input), output: Math.max(at.output, before.output),
		cache_read: Math.max(at.cache_read, before.cache_read), cache_write: Math.max(at.cache_write, before.cache_write),
	});
}

/**
 * A run that ended without its result: the streamed usage, `estimated`, at cost 0 with `cost_unknown`. The baseline
 * advances by the estimate, so a resume's restored totals never count these tokens again (a reset reads unbaselined).
 */
export function estimatedRunUsage(seen: StreamedUsage, baseline: NativeBaseline | undefined): NativeRunUsage {
	const sum: Counts = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
	const ledger: NativeBaseline["ledger"] = { ...baseline?.ledger };
	for (const { model, ...at } of seen.values()) {
		for (const key of ["input", "output", "cache_read", "cache_write"] as const) sum[key] += at[key];
		const was = ledger[model] ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 };
		ledger[model] = {
			input: was.input + at.input + at.cache_read + at.cache_write, output: was.output + at.output,
			...(was.cache_read === undefined ? {} : { cache_read: was.cache_read + at.cache_read }),
			...(was.cache_write === undefined ? {} : { cache_write: was.cache_write + at.cache_write }),
		};
	}
	const totalTokens = sum.input + sum.output + sum.cache_read + sum.cache_write;
	if (totalTokens === 0) return { status: "unavailable" };
	const usage = { input: sum.input, output: sum.output, cacheRead: sum.cache_read, cacheWrite: sum.cache_write, totalTokens, cost: { total: 0 } };
	return { status: "estimated", usage, cost_unknown: true, ...(baseline ? { baseline: { ledger, cost_usd: baseline.cost_usd } } : {}) };
}

const MAX_DENIED = 5;
const MAX_REASON = 200;
const PATH = /(?<=^|[\s(=:'"`])(?:~|\.{1,2})?\/[^\s)'"`,;]*/g;

/** At most 5 `tool: reason` lines of at most 200 chars; long env values and every path are redacted first. */
export function nativeDenials(denials: ReadonlyArray<{ tool: string; reason: string }>, env: NodeJS.ProcessEnv = process.env): string[] {
	const values = Object.values(env).filter((value): value is string => value !== undefined && value.length >= 12).sort((a, b) => b.length - a.length);
	return denials.slice(0, MAX_DENIED).map(({ tool, reason }) => {
		let line = `${tool}: ${reason}`;
		for (const value of values) line = line.split(value).join("<env>");
		return line.replace(PATH, "<path>").slice(0, MAX_REASON);
	});
}
