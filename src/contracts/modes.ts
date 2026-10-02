/** Mode (multi only; single-project mode was removed) and the resolved runtime. Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { validate, type ValidationResult } from "./core.ts";

// ---------------------------------------------------------------------------
// Mode (multi only; single-project mode was removed, cp-8knh)
// ---------------------------------------------------------------------------

export const MODES = ["multi"] as const;
export type Mode = (typeof MODES)[number];
export const ModeSchema = StringEnum([...MODES]);

/** What an operator may write: `auto` means "use the default". `single` stays readable only to be refused. */
export const MODE_SETTINGS = ["single", "multi", "auto"] as const;
export type ModeSetting = (typeof MODE_SETTINGS)[number];
export const ModeSettingSchema = StringEnum([...MODE_SETTINGS]);

/** Wins over the settings file and the default. `multi|auto`; `single` is refused. */
export const ENV_MODE = "CP_MODE";

/** Bridge-driven parent: never open overlays; orchestration timers still run. */
export const ENV_HEADLESS = "CP_HEADLESS";

export const ModeSettingsSchema = Type.Object(
	{ schema_version: Type.Integer({ minimum: 1 }), mode: ModeSettingSchema },
	{ additionalProperties: false },
);
export type ModeSettings = Omit<Static<typeof ModeSettingsSchema>, "mode"> & { mode: ModeSetting };
export function validateModeSettings(value: unknown): ValidationResult<ModeSettings> {
	return validate<ModeSettings>(ModeSettingsSchema, value);
}

export const RUNTIME_SOURCES = ["CP_MODE", "settings", "CP_HOME", "checkout", "home-dir", "managed", "standard"] as const;
export type RuntimeSource = (typeof RUNTIME_SOURCES)[number];

export const RuntimeSchema = Type.Object(
	{
		mode: ModeSchema,
		home: Type.String({ minLength: 1 }),
		source: StringEnum([...RUNTIME_SOURCES]),
		reason: Type.String({ minLength: 1, maxLength: 1000 }),
	},
	{ additionalProperties: false },
);
export type Runtime = Omit<Static<typeof RuntimeSchema>, "mode" | "source"> & { mode: Mode; source: RuntimeSource };
export function validateRuntime(value: unknown): ValidationResult<Runtime> {
	return validate<Runtime>(RuntimeSchema, value);
}
