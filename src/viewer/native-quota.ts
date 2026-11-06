/** The chat footer's separate Claude item (native routing S3): read-only, never merged into gateway quota. */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkspaceStatusResponse } from "./api-types.ts";
import { num, obj, type Json } from "./sessions.ts";

/** Viewer copies of `NATIVE_WINDOWS`, `NATIVE_AUTH_CODES` and `WINDOW_STATUSES` (`drivers/claude-observation.ts`);
 * tests pin list parity and that this parse accepts exactly what S2's `SnapshotSchema` accepts. */
export const QUOTA_WINDOWS = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included", "unspecified"] as const;
export const QUOTA_AUTH_CODES = ["authentication_failed", "oauth_org_not_allowed", "account_on_hold"] as const;
export const QUOTA_STATUSES = ["allowed", "allowed_warning", "rejected"] as const;

type ClaudeItem = NonNullable<WorkspaceStatusResponse["claude"]>;
type Entry = { observed_at: number; status?: string; resets_at?: number; code?: string };
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const readJson = (file: string): Json | undefined => {
	try { return obj(JSON.parse(readFileSync(file, "utf8"))); } catch { return undefined; }
};
const only = (value: Json, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
/** Viewer copy of `NATIVE_CLASSES` (`worker-driver.ts`): valid like `loadNativeConfig`, and some class switch on. */
const SWITCHES = ["claude_research", "claude_ship", "claude_review"] as const;
const nativeSwitchOn = (config: Json): boolean => only(config, [...SWITCHES, "max_concurrent"])
	&& SWITCHES.every((key) => config[key] === undefined || typeof config[key] === "boolean")
	&& (config.max_concurrent === undefined || (Number.isInteger(config.max_concurrent) && (config.max_concurrent as number) >= 1 && (config.max_concurrent as number) <= 4))
	&& SWITCHES.some((key) => config[key] === true);
const at = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
const version = (value: unknown) => value === undefined || (typeof value === "string" && value.length >= 1 && value.length <= 40);
/** S2's entry schemas (no extra keys): a window entry, or a sticky auth/lockdown entry when `codes` is set. */
const entry = (value: unknown, codes?: readonly string[]): Entry | undefined => {
	const e = obj(value);
	if (!e || at(e.observed_at) === undefined || !version(e.claude_version)) return undefined;
	if (codes) return only(e, ["code", "observed_at", "claude_version"]) && codes.includes(e.code as string) ? { observed_at: at(e.observed_at)!, code: e.code as string } : undefined;
	const shaped = only(e, ["status", "observed_at", "resets_at", "utilization", "claude_version"]) && (QUOTA_STATUSES as readonly unknown[]).includes(e.status)
		&& (e.resets_at === undefined || at(e.resets_at) !== undefined) && (e.utilization === undefined || num(e.utilization) !== undefined);
	return shaped ? { observed_at: at(e.observed_at)!, status: e.status as string, resets_at: at(e.resets_at) } : undefined;
};

/** The snapshot, or undefined when S2 would reject it (read as unknown); like S2, unknown window names are ignored. */
function parse(raw: Json | undefined) {
	const windows = obj(raw?.windows), seen = raw?.seen;
	if (!raw || raw.version !== 1 || !windows || !only(raw, ["version", "windows", "auth", "lockdown", "seen"])) return undefined;
	if (!Array.isArray(seen) || seen.length > 256 || seen.some((s) => typeof s !== "string" || s.length > 64)) return undefined;
	const parsed = QUOTA_WINDOWS.flatMap((window) => (windows[window] === undefined ? [] : [{ window, entry: entry(windows[window]) }]));
	const auth = raw.auth === undefined ? undefined : entry(raw.auth, QUOTA_AUTH_CODES);
	const lockdown = raw.lockdown === undefined ? undefined : entry(raw.lockdown, ["lockdown"]);
	if (parsed.some((p) => !p.entry) || (raw.auth !== undefined && !auth) || (raw.lockdown !== undefined && !lockdown)) return undefined;
	return { windows: parsed as { window: string; entry: Entry }[], auth, lockdown };
}

/**
 * `data/native.json` and `state/native-availability.json` beside `stateDir`, as the parent writes them. Undefined while
 * the switch is off or invalid. Precedence: blocked, limited, unknown (no readable snapshot), ok.
 */
export function nativeQuotaLine(stateDir: string, now: number): ClaudeItem | undefined {
	const switchFile = join(dirname(stateDir), "data", "native.json");
	const config = readJson(switchFile);
	if (!config || !nativeSwitchOn(config)) return undefined;
	const snapshot = parse(readJson(join(stateDir, "native-availability.json")));
	if (!snapshot) return { state: "unknown", label: "Claude unknown", detail: "no readable native-availability snapshot yet" };
	// shortcut: CLI-version invalidation (iii) is skipped (it spawns claude); add it if a CLI update leaves the line
	// stale. Entries older than the switch file were voided by turning it on (invalidation ii).
	let switched: number | undefined;
	try { switched = statSync(switchFile).mtimeMs; } catch { switched = undefined; }
	const live = (e: Entry | undefined) => (e && !(switched !== undefined && switched > e.observed_at) ? e : undefined);
	const auth = live(snapshot.auth), lockdown = live(snapshot.lockdown);
	if (auth) {
		return { state: "blocked", label: "Claude blocked (sign-in)",
			detail: `${auth.code} at ${iso(auth.observed_at)}; sign in to claude again, then turn the switch off and on` };
	}
	if (lockdown) return { state: "blocked", label: "Claude blocked (lockdown)", detail: `surface lockdown refused a run at ${iso(lockdown.observed_at)}` };
	const rejected = snapshot.windows.filter((w) => w.entry.status === "rejected");
	const sticky = rejected.filter((w) => w.entry.resets_at === undefined && live(w.entry));
	if (sticky.length) {
		return { state: "limited", label: "Claude limited (reset unknown)", detail: sticky.map((w) => `${w.window} rejected, reset unknown`).join("; ") };
	}
	const pending = rejected.flatMap((w) => (w.entry.resets_at !== undefined && now < w.entry.resets_at ? [{ window: w.window, resets: w.entry.resets_at }] : []));
	if (pending.length) {
		const until = Math.max(...pending.map((w) => w.resets));
		return { state: "limited", label: `Claude limited until ${iso(until).slice(11, 16)}Z`,
			detail: pending.map((w) => `${w.window} rejected until ${iso(w.resets)}`).join("; ") };
	}
	if (rejected.length) return { state: "unknown", label: "Claude unknown", detail: "a rejected window reset or was voided; unknown until the next native run" };
	return { state: "ok", label: "Claude ok", detail: "no spent window, sign-in or lockdown block recorded by native runs" };
}
