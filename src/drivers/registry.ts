/** One spec per native driver (C1b): the route, the spawn guard, the respawn check and the stop wording read it. */
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
	/** Whether S2's Claude subscription snapshot can block a candidate model. */
	availability: boolean;
	spawnOptions(model: string, env: NodeJS.ProcessEnv, systemPrompt: string, options?: { web?: boolean; profile?: string }): SpawnOptions;
}

export const NATIVE_DRIVER_SPECS: Readonly<Record<NativeDriver, NativeDriverSpec>> = {
	claude: {
		label: "Claude CLI", noun: "native", isModel: isNativeModel, modelId: nativeModelId, assertEffort: assertNativeEffort,
		selectionRefusal: nativeSelectionRefusal, maxConcurrent: nativeMaxConcurrent, availability: true, spawnOptions: nativeSpawnOptions,
	},
	codex: {
		label: "Codex CLI", noun: "codex", isModel: isCodexModel, modelId: codexModelId, assertEffort: assertCodexEffort,
		selectionRefusal: codexSelectionRefusal, maxConcurrent: codexMaxConcurrent, availability: false,
		spawnOptions: (model, env, systemPrompt) => codexSpawnOptions(model, env, systemPrompt),
	},
};

export const nativeDriverSpec = (driver: NativeDriver): NativeDriverSpec => NATIVE_DRIVER_SPECS[driver];

/** The spawn-time check: `holders` of `driver` other than `key` fill its own `max` slots. */
export function nativeWorkerSlotRefusal(home: string, driver: NativeDriver, holders: Iterable<string>, key: string): { category: NativeRefusal; why: string } | undefined {
	const spec = nativeDriverSpec(driver);
	return nativeSlotRefusal(holders, key, spec.maxConcurrent(home), "live", spec.noun);
}
