/** One spec per native driver (C1b): the route, the spawn guard, the respawn check and the stop wording read it. */
import { codexAvailability, type NativeAvailability, nativeAvailability } from "../native-availability.ts";
import type { WorkerSpawnOptions } from "../worker-process.ts";
import type { NativeDriver } from "../worker-driver.ts";
import {
	assertNativeEffort, isNativeModel, nativeMaxConcurrent, nativeModelId, type NativeRefusal, type NativeSelection, nativeSelectionRefusal,
	nativeSlotRefusal, nativeSpawnOptions,
} from "./claude.ts";
import { assertCodexEffort, codexMaxConcurrent, codexModelId, codexSelectionRefusal, codexSpawnOptions, isCodexModel } from "./codex.ts";

type SpawnOptions = Pick<WorkerSpawnOptions, "piBin" | "argv" | "env" | "shutdownGraceMs">;

export interface NativeDriverSpec {
	label: string;
	/** The word a slot refusal leads with: "native concurrency is …" for Claude, "codex concurrency is …" for Codex. */
	noun: string;
	isModel(model: string): boolean;
	modelId(model: string): string;
	assertEffort(level: string | undefined): void;
	selectionRefusal(input: NativeSelection): Promise<{ category: NativeRefusal; why: string } | undefined>;
	maxConcurrent(home: string): number;
	/** The driver's subscription snapshot (S2 Claude, C3 Codex), read before a candidate is selected or resumed. */
	availability?: (home: string, model: string, options?: { now?: number; env?: NodeJS.ProcessEnv; windowsOnly?: boolean }) => Promise<NativeAvailability>;
	/** Whether a busy worker takes a mid-turn steer (Codex `turn/steer`, C2b). */
	steers: boolean;
	/** What the CLI resumes: a Claude "session", a Codex "thread". */
	session: string;
	/** `skills`: the per-job skill dirs (the Codex sandbox reads them; Claude's brief note and Read serve them). */
	spawnOptions(model: string, env: NodeJS.ProcessEnv, systemPrompt: string, options?: { web?: boolean; profile?: string; skills?: readonly string[] }): SpawnOptions;
}

// Arrow wrappers: the specs are read lazily, so an import cycle through doctor.ts never sees an uninitialised binding.
export const NATIVE_DRIVER_SPECS: Readonly<Record<NativeDriver, NativeDriverSpec>> = {
	claude: {
		label: "Claude CLI", noun: "native", steers: false, session: "session",
		availability: (home, model, options) => nativeAvailability(home, model, options),
		isModel: (model) => isNativeModel(model), modelId: (model) => nativeModelId(model), assertEffort: (level) => assertNativeEffort(level),
		selectionRefusal: (input) => nativeSelectionRefusal(input), maxConcurrent: (home) => nativeMaxConcurrent(home),
		spawnOptions: (model, env, systemPrompt, options) => nativeSpawnOptions(model, env, systemPrompt, options),
	},
	codex: {
		label: "Codex CLI", noun: "codex", steers: true, session: "thread",
		availability: (home, model, options) => codexAvailability(home, model, options),
		isModel: (model) => isCodexModel(model), modelId: (model) => codexModelId(model), assertEffort: (level) => assertCodexEffort(level),
		selectionRefusal: (input) => codexSelectionRefusal(input), maxConcurrent: (home) => codexMaxConcurrent(home),
		spawnOptions: (model, env, systemPrompt, options) => codexSpawnOptions(model, env, systemPrompt, { ...(options?.skills ? { skills: options.skills } : {}) }),
	},
};

export const nativeDriverSpec = (driver: NativeDriver): NativeDriverSpec => NATIVE_DRIVER_SPECS[driver];

/** The spawn-time check: `holders` of `driver` other than `key` fill its own `max` slots. */
export function nativeWorkerSlotRefusal(home: string, driver: NativeDriver, holders: Iterable<string>, key: string): { category: NativeRefusal; why: string } | undefined {
	const spec = nativeDriverSpec(driver);
	return nativeSlotRefusal(holders, key, spec.maxConcurrent(home), "live", spec.noun);
}
