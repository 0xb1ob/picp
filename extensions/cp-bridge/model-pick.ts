/** `cp_parent model_pick` (R1 D2): issue a one-job model pick proof from the operator's own session entry. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configureLayout, type Mode } from "../../src/contracts.ts";
import { CpBridgeError } from "../../src/cp-bridge.ts";
import { issueOperatorPick } from "../../src/operator-model-pick.ts";

interface ModelPickParams { model?: string; quote?: string; source_entry_id?: string; control_id?: string; job_id?: string }

/** The tool text and details; refusals throw, so the bridge returns them as errors. */
export function modelPick(params: ModelPickParams, ctx: ExtensionContext, target: { home: string; mode: Mode }): [string, Record<string, unknown>] {
	if (!params.model || !params.quote) throw new CpBridgeError("cp_parent model_pick needs model (provider/model-id) and quote (the human's words)");
	configureLayout(target.mode, target.home);
	const { reference } = issueOperatorPick({
		home: target.home, sessionFile: ctx.sessionManager.getSessionFile(), entries: ctx.sessionManager.getBranch(),
		model: params.model, quote: params.quote,
		...(params.source_entry_id ? { entryId: params.source_entry_id } : {}),
		...(params.job_id ? { jobId: params.job_id } : {}), ...(params.control_id ? { controlId: params.control_id } : {}),
	});
	return [
		`operator_quote: ${JSON.stringify(reference)}\n` +
			`Relay it verbatim with model ${params.model} on the parent's cp_dispatch or cp_ask (cp_parent send); ` +
			"it is honoured once, for one job only, and never becomes a routing default.",
		{ operator_quote: reference, model: params.model },
	];
}
