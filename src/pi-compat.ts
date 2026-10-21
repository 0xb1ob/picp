/**
 * pi's supported range (#375): package.json `piCompat` {min, testedMax}, declared once and classified here for
 * install-tools, doctor and project readiness alike. Below min updates via pi's own path; a newer major, or a pi
 * that fails the capability probe (src/pi-compat-probe.ts), is incompatible; newer within testedMax's major warns.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DoctorFinding } from "./contracts.ts";

export interface PiCompat { min: string; testedMax: string }
/** What src/pi-compat-probe.ts observed: `pi --version`'s line, and whether the command-post extension loaded. */
export interface PiProbe { version?: string; extension: { ok: boolean; detail: string } }
export type PiCompatState = "old" | "supported" | "newer" | "incompatible";
export interface PiCompatResult { state: PiCompatState; version?: string; detail: string; range: string }

type Triple = [number, number, number];

/** The first `x.y.z` in `text`, so `pi 1.0.4` and `1.0.4` both read. */
export function parseVersion(text: string | undefined): Triple | undefined {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(text?.split("\n")[0] ?? "");
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

const compare = (a: Triple, b: Triple): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** `piCompat` from package.json's text; throws naming the problem when it is absent or malformed. */
export function parsePiCompat(packageJson: string): PiCompat {
	let raw: { min?: unknown; testedMax?: unknown } | undefined;
	try {
		raw = (JSON.parse(packageJson) as { piCompat?: { min?: unknown; testedMax?: unknown } }).piCompat;
	} catch (error) {
		throw new Error(`package.json is not JSON, so piCompat cannot be read: ${(error as Error).message}`);
	}
	const min = typeof raw?.min === "string" ? parseVersion(raw.min) : undefined;
	const max = typeof raw?.testedMax === "string" ? parseVersion(raw.testedMax) : undefined;
	if (!min || !max || compare(min, max) > 0) throw new Error(`package.json piCompat must be {min, testedMax} x.y.z versions with min <= testedMax (got ${JSON.stringify(raw)})`);
	return { min: min.join("."), testedMax: max.join(".") };
}

export function readPiCompat(packageRoot: string): PiCompat {
	return parsePiCompat(readFileSync(join(packageRoot, "package.json"), "utf8"));
}

export function piRange(compat: PiCompat): string {
	return `pi >= ${compat.min}, tested up to ${compat.testedMax}, major ${compat.testedMax.split(".")[0]}`;
}

/** Old is decided before the probe (an update re-probes); then a newer major or a failed probe is incompatible. */
export function classifyPi(compat: PiCompat, probe: PiProbe): PiCompatResult {
	const range = piRange(compat);
	const version = parseVersion(probe.version);
	const result = (state: PiCompatState, detail: string): PiCompatResult => ({ state, ...(version ? { version: version.join(".") } : {}), detail, range });
	if (!version) return result("incompatible", `\`pi --version\` gave no x.y.z version (${probe.version?.trim() || "no output"})`);
	const shown = version.join(".");
	if (compare(version, parseVersion(compat.min) as Triple) < 0) return result("old", `pi ${shown} is older than ${compat.min}`);
	const max = parseVersion(compat.testedMax) as Triple;
	if (version[0] > max[0]) return result("incompatible", `pi ${shown} is a newer major than the tested ${compat.testedMax}`);
	if (!probe.extension.ok) return result("incompatible", `pi ${shown} failed the capability probe: ${probe.extension.detail}`);
	if (compare(version, max) > 0) return result("newer", `pi ${shown} is newer than the tested ${compat.testedMax} (same major; the capability probe passed)`);
	return result("supported", `pi ${shown} is supported`);
}

/** The shell word for `pi update --self`, the one self-update path (never npm -g, --extensions, --all or --force). */
export const selfUpdate = (pi: string): string => `"${pi}" update --self`;

/** Doctor's `host.pi.compat`: old and incompatible are errors that name their fix, newer warns. */
export function piCompatFinding(result: PiCompatResult, pi: string): DoctorFinding {
	const what = `${result.detail}; supported: ${result.range}`.slice(0, 200);
	if (result.state === "supported") return { check: PI_COMPAT_CHECK, severity: "ok", what, detail: pi };
	if (result.state === "newer") return { check: PI_COMPAT_CHECK, severity: "warn", what, detail: pi, fix: "warn only: nothing to do unless something breaks; then install a tested pi" };
	if (result.state === "old") return { check: PI_COMPAT_CHECK, severity: "error", what, detail: pi, fix: `update pi with its own updater: ${selfUpdate(pi)} (or rerun cp-install, which asks first)` };
	return { check: PI_COMPAT_CHECK, severity: "error", what, detail: pi, fix: `install a pi in the supported range; cp-install --force proceeds anyway, with a warning` };
}

/** The doctor check id the installer's `--force` may accept at its final doctor, and only it. */
export const PI_COMPAT_CHECK = "host.pi.compat";
