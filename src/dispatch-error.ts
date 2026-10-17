/** A refused dispatch; a leaf module so src/ops-jobs.ts can throw it without a cycle through src/dispatch.ts. */
import type { PreflightResult } from "./preflight.ts";

export class DispatchError extends Error {
	readonly result: PreflightResult | undefined;
	constructor(message: string, result?: PreflightResult) {
		super(message);
		this.result = result;
	}
}
