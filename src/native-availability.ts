/**
 * Native routing S2: the home-local snapshot of passive Claude subscription evidence, kept apart from gateway quota.
 * Evidence, never authorization: it turns NEW native selection (and a native resume) away. Missing or corrupt reads
 * as unknown, never spent and never free. Contract: docs/native-drivers.md "Availability snapshot (S2)".
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { LAYOUT, type Layout, layoutForHome } from "./contracts.ts";
import {
	type ModelFamily, modelFamily, NATIVE_AUTH_CODES, NATIVE_WINDOWS, type NativeAuthCode, type NativeWindow, OBSERVATION_EVENT, WINDOW_STATUSES,
} from "./drivers/claude-observation.ts";
import { installedClaudeVersion, nativeModelId, type NativeRefusal } from "./drivers/claude.ts";
import { atomicWriteJson } from "./json-store.ts";
import { loadNativeConfig, nativeConfigFile } from "./worker-driver.ts";

const SEEN_MAX = 256;
const literals = (values: readonly string[]) => Type.Union(values.map((value) => Type.Literal(value)));
const version = Type.Optional(Type.String({ minLength: 1, maxLength: 40 }));
const at = Type.Number({ minimum: 0 });
const WindowEntrySchema = Type.Object(
	{ status: literals(WINDOW_STATUSES), observed_at: at, resets_at: Type.Optional(at), utilization: Type.Optional(Type.Number()), claude_version: version },
	{ additionalProperties: false },
);
const sticky = (code: TSchema) => Type.Object({ code, observed_at: at, claude_version: version }, { additionalProperties: false });
const SnapshotSchema = Type.Object({
	version: Type.Literal(1),
	windows: Type.Partial(Type.Object(Object.fromEntries(NATIVE_WINDOWS.map((window) => [window, WindowEntrySchema])), { additionalProperties: false })),
	auth: Type.Optional(sticky(literals(NATIVE_AUTH_CODES))),
	lockdown: Type.Optional(sticky(Type.Literal("lockdown"))),
	seen: Type.Array(Type.String({ maxLength: 64 }), { maxItems: SEEN_MAX }),
}, { additionalProperties: false });
const EventSchema = Type.Intersect([
	Type.Object({ type: Type.Literal(OBSERVATION_EVENT), observed_at: at, claude_version: version }),
	Type.Union([
		Type.Object({ kind: Type.Literal("window"), window: literals(NATIVE_WINDOWS), status: literals(WINDOW_STATUSES), uuid: Type.Optional(Type.String({ maxLength: 64 })), resets_at: Type.Optional(at), utilization: Type.Optional(Type.Number()) }),
		Type.Object({ kind: Type.Literal("auth"), code: literals(NATIVE_AUTH_CODES) }),
		Type.Object({ kind: Type.Literal("lockdown"), code: Type.Literal("lockdown") }),
		Type.Object({ kind: Type.Literal("turn_ok"), family: Type.Optional(literals(["opus", "sonnet"])) }),
	]),
]);

interface WindowEntry { status: (typeof WINDOW_STATUSES)[number]; observed_at: number; resets_at?: number; utilization?: number; claude_version?: string }
interface Sticky<C> { code: C; observed_at: number; claude_version?: string }
export interface NativeAvailabilitySnapshot {
	version: 1;
	windows: Partial<Record<NativeWindow, WindowEntry>>;
	auth?: Sticky<NativeAuthCode>;
	lockdown?: Sticky<"lockdown">;
	/** Rate-limit event uuids already applied, newest last. */
	seen: string[];
}
type ObservationEvent = { observed_at: number; claude_version?: string } & (
	| { kind: "window"; window: NativeWindow; status: WindowEntry["status"]; uuid?: string; resets_at?: number; utilization?: number }
	| { kind: "auth"; code: NativeAuthCode } | { kind: "lockdown"; code: "lockdown" } | { kind: "turn_ok"; family?: ModelFamily });

export const nativeAvailabilityFile = (home: string, layout: Layout = LAYOUT): string => join(home, layout.state, "native-availability.json");

/** The snapshot, or undefined when it is missing or corrupt (unknown). */
export function readNativeAvailability(home: string, layout: Layout = LAYOUT): NativeAvailabilitySnapshot | undefined {
	try {
		const raw: unknown = JSON.parse(readFileSync(nativeAvailabilityFile(home, layout), "utf8"));
		return Value.Check(SnapshotSchema, raw) ? (raw as NativeAvailabilitySnapshot) : undefined;
	} catch {
		return undefined;
	}
}

const isSticky = (entry: WindowEntry): boolean => entry.status === "rejected" && entry.resets_at === undefined;

/** Applies one relayed `native_observation` event; false when invalid, a duplicate uuid or older than the entry. */
export function recordNativeObservation(home: string, input: unknown): boolean {
	if (!Value.Check(EventSchema, input)) return false;
	const event = input as ObservationEvent;
	const snapshot = readNativeAvailability(home) ?? { version: 1, windows: {}, seen: [] };
	const stamp = { observed_at: event.observed_at, ...(event.claude_version ? { claude_version: event.claude_version } : {}) };
	if (event.kind === "window") {
		if (event.uuid !== undefined && snapshot.seen.includes(event.uuid)) return false;
		if ((snapshot.windows[event.window]?.observed_at ?? -1) > event.observed_at) return false;
		if (event.uuid !== undefined) snapshot.seen = [...snapshot.seen, event.uuid].slice(-SEEN_MAX);
		const { status, resets_at, utilization } = event;
		snapshot.windows[event.window] = { status, ...stamp, ...(resets_at === undefined ? {} : { resets_at }), ...(utilization === undefined ? {} : { utilization }) };
	} else if (event.kind === "turn_ok") {
		// A successful turn clears sticky entries observed before it (invalidation i); windows only for its model family.
		if ((snapshot.auth?.observed_at ?? Infinity) <= event.observed_at) delete snapshot.auth;
		if ((snapshot.lockdown?.observed_at ?? Infinity) <= event.observed_at) delete snapshot.lockdown;
		const cleared: NativeWindow[] = ["five_hour", "seven_day", "seven_day_overage_included", "unspecified", ...(event.family ? [`seven_day_${event.family}` as const] : [])];
		for (const window of cleared) {
			const entry = snapshot.windows[window];
			if (entry && isSticky(entry) && entry.observed_at <= event.observed_at) delete snapshot.windows[window];
		}
	} else {
		const prior = event.kind === "auth" ? snapshot.auth : snapshot.lockdown;
		if ((prior?.observed_at ?? -1) > event.observed_at) return false;
		if (event.kind === "auth") snapshot.auth = { code: event.code, ...stamp };
		else snapshot.lockdown = { code: "lockdown", ...stamp };
	}
	atomicWriteJson(nativeAvailabilityFile(home), snapshot);
	return true;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function mtime(file: string): number | undefined {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return undefined;
	}
}

export interface NativeAvailability {
	blocked?: { category: Extract<NativeRefusal, "window" | "auth" | "lockdown">; why: string };
	/** A rejected window whose reset passed: unknown, never "0% used"; a native attempt is allowed. */
	note?: string;
}

/**
 * What the snapshot says about a new native run of `model` at `now`. A sticky entry (auth, lockdown, a rejected window
 * with no reset) holds until a later allowed event or successful turn, the switch file rewritten (Settings off then on)
 * after it, or another installed CLI version. `windowsOnly` is the resume admission: windows, never auth or lockdown.
 */
export async function nativeAvailability(home: string, model: string, options: { now?: number; env?: NodeJS.ProcessEnv; windowsOnly?: boolean } = {}): Promise<NativeAvailability> {
	const snapshot = readNativeAvailability(home);
	if (!snapshot) return {};
	const now = options.now ?? Date.now();
	const switched = mtime(nativeConfigFile(home));
	let installed: Promise<string | undefined> | undefined;
	const invalidated = async (entry: { observed_at: number; claude_version?: string }): Promise<boolean> => {
		if (switched !== undefined && switched > entry.observed_at) return true;
		if (entry.claude_version === undefined) return false;
		const current = await (installed ??= installedClaudeVersion(options.env));
		return current !== undefined && current !== entry.claude_version;
	};
	const id = nativeModelId(model);
	const family = modelFamily(id);
	let note: string | undefined;
	for (const window of NATIVE_WINDOWS) {
		const entry = snapshot.windows[window];
		if (entry?.status !== "rejected" || (window === "seven_day_opus" && family !== "opus") || (window === "seven_day_sonnet" && family !== "sonnet")) continue;
		if (entry.resets_at !== undefined) {
			if (now < entry.resets_at) return { blocked: { category: "window", why: `${window} rejected until ${iso(entry.resets_at)}` } };
			note ??= `${window} unknown since its reset ${iso(entry.resets_at)}`;
		} else if (!(await invalidated(entry))) {
			return { blocked: { category: "window", why: `${window} rejected, reset unknown (observed ${iso(entry.observed_at)}); clears on an allowed event or switch off then on` } };
		}
	}
	if (!options.windowsOnly && snapshot.auth && !(await invalidated(snapshot.auth))) {
		return { blocked: { category: "auth", why: `${snapshot.auth.code} at ${iso(snapshot.auth.observed_at)}; sign in to claude again, then turn the switch off and on` } };
	}
	if (!options.windowsOnly && snapshot.lockdown && !(await invalidated(snapshot.lockdown))) {
		return { blocked: { category: "lockdown", why: `the CLI surface lockdown refused a run at ${iso(snapshot.lockdown.observed_at)}; fix the CLI, then turn the switch off and on` } };
	}
	return note ? { note } : {};
}

export interface NativeQuotaLine { state: "ok" | "limited" | "blocked" | "unknown"; label: string; detail: string }

/**
 * The dashboard's separate Claude item (S3), never gateway quota; undefined while the switch is off or unreadable.
 * Paths come from `home`'s own layout, since the viewer configures none. Precedence: blocked, limited, unknown, ok.
 */
export function nativeQuotaLine(home: string, now: number): NativeQuotaLine | undefined {
	const layout = layoutForHome("multi", home);
	const switchFile = nativeConfigFile(home, layout);
	try {
		if (!loadNativeConfig(switchFile).claude_research) return undefined;
	} catch {
		return undefined;
	}
	const snapshot = readNativeAvailability(home, layout);
	if (!snapshot) return { state: "unknown", label: "Claude unknown", detail: "no readable native-availability snapshot yet" };
	// shortcut: CLI-version invalidation (iii) is skipped (it spawns claude); add it if a CLI update leaves the line stale.
	const switched = mtime(switchFile);
	const live = <E extends { observed_at: number }>(entry: E | undefined): E | undefined => (entry && !(switched !== undefined && switched > entry.observed_at) ? entry : undefined);
	const auth = live(snapshot.auth), lockdown = live(snapshot.lockdown);
	if (auth) return { state: "blocked", label: "Claude blocked (sign-in)", detail: `${auth.code} at ${iso(auth.observed_at)}; sign in to claude again, then turn the switch off and on` };
	if (lockdown) return { state: "blocked", label: "Claude blocked (lockdown)", detail: `surface lockdown refused a run at ${iso(lockdown.observed_at)}` };
	const rejected = NATIVE_WINDOWS.flatMap((window) => (snapshot.windows[window]?.status === "rejected" ? [{ window, ...snapshot.windows[window]! }] : []));
	const sticky = rejected.filter((entry) => entry.resets_at === undefined && live(entry));
	if (sticky.length) return { state: "limited", label: "Claude limited (reset unknown)", detail: sticky.map((e) => `${e.window} rejected, reset unknown`).join("; ") };
	const pending = rejected.filter((entry) => entry.resets_at !== undefined && now < entry.resets_at);
	if (pending.length) {
		const until = Math.max(...pending.map((entry) => entry.resets_at!));
		return { state: "limited", label: `Claude limited until ${iso(until).slice(11, 16)}Z`, detail: pending.map((e) => `${e.window} rejected until ${iso(e.resets_at!)}`).join("; ") };
	}
	if (rejected.length) return { state: "unknown", label: "Claude unknown", detail: "a rejected window reset or was voided; unknown until the next native run" };
	return { state: "ok", label: "Claude ok", detail: "no spent window, sign-in or lockdown block recorded by native runs" };
}
