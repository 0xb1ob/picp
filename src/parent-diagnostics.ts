import type { WorkerProcess } from "./worker-process.ts";

export interface ParentDiagnostic {
	text: string;
	level: "info" | "error";
}

/** #settledProc's refusal: alive and ready, but mid-turn or a send pending. */
export const PARENT_UNSETTLED = "parent must be settled with no pending send";

/** Invoke only registered diagnostic commands: an unknown slash command would become an LLM prompt. */
export async function parentDiagnostic(proc: WorkerProcess, action: "doctor" | "version" | "drain", timeoutMs = 120_000, args = ""): Promise<ParentDiagnostic> {
	const command = action === "doctor" ? "doctor" : action === "drain" ? "cp-drain" : "cp-version";
	const prefix = action === "doctor" ? "DOCTOR " : action === "drain" ? "DRAIN: " : "pi-command-post ";
	const response = await proc.request("get_commands", {}, timeoutMs);
	if (response.success === false) throw new Error(`parent diagnostics unavailable: ${response.error ?? "get_commands failed"}`);
	const commands = (response.data as { commands?: Array<{ name: string; source: string }> } | undefined)?.commands;
	if (!Array.isArray(commands) || !commands.some((entry) => entry.name === command && entry.source === "extension")) {
		throw new Error(`parent diagnostic /${command} is not registered; reload the command-post parent extension`);
	}
	let result: ParentDiagnostic | undefined;
	let failure: string | undefined;
	const unsubscribe = proc.onEvent((event) => {
		if (event.type === "extension_error" && event.extensionPath === `command:${command}`) failure = String(event.error);
		if (event.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string" && event.message.startsWith(prefix)) {
			result = { text: event.message, level: event.notifyType === "error" ? "error" : "info" };
		}
	});
	try {
		// Pi acknowledges extension commands after their handlers finish, including their notifications.
		const reply = await proc.request("prompt", { message: `/${command}${args ? ` ${args}` : ""}` }, timeoutMs);
		if (reply.success === false) throw new Error(`parent diagnostic /${command} failed: ${reply.error ?? "request rejected"}`);
		if (failure) throw new Error(`parent diagnostic /${command} failed: ${failure}`);
		if (!result) throw new Error(`parent /${command} returned no diagnostic output`);
		return result;
	} finally {
		unsubscribe();
	}
}
