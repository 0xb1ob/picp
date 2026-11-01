/**
 * The provider-boundary port for a verified usage-limit reset (P3). Production declares no capability: no real
 * provider has a verified terminal reset signal, so the only adapter production composes decodes nothing.
 */

/** A usage-limit terminal error that names an absolute reset instant, read at the provider boundary. */
export interface QuotaResetSignal {
	provider: string;
	model: string;
	status: number;
	category: string;
	scope: string;
	/** Absolute reset instant, epoch seconds; never a relative delay. */
	resetsAtEpochSeconds: number;
	resetsAtUtc: string;
}

/** Decodes one terminal assistant message; `undefined` means no verified signal, never a guessed window. */
export interface QuotaResetAdapter {
	/** Stamped on every intent so a later decoder change is visible on old records. */
	readonly capabilityVersion: string;
	decode(message: unknown): QuotaResetSignal | undefined;
}

/** The production adapter: an empty allowlist, frozen, with no env, config, flag or settings hook to widen it. */
export const PRODUCTION_QUOTA_RESET_ADAPTER: QuotaResetAdapter = Object.freeze({
	capabilityVersion: "none",
	decode: (): QuotaResetSignal | undefined => undefined,
});
