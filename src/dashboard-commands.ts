/**
 * Full match S6: a dashboard command becomes one ordinary operator message, the text a human could type, so the
 * parent's own authority checks still decide; never a shell, a tool call or a grant change.
 */
import { commandGrammar } from "./viewer/control-files.ts";

/** `line` is what the journal records (`/stop cp-abcd`), refused or not; `text` is what the session is given. */
export type CommandResult = { ok: true; line: string; text: string } | { ok: false; line: string; reason: string };

/** One command from the viewer's forwarded args, re-checked against the grammar; a refusal names its reason. */
export function dashboardCommand(args: Record<string, unknown>): CommandResult {
	const name = typeof args.command === "string" ? args.command.slice(0, 32) : "";
	const job = typeof args.job_id === "string" ? args.job_id.slice(0, 128) : "";
	const line = `/${name}${job ? ` ${job}` : ""}`;
	const shape = commandGrammar(args);
	if (!shape.ok) return { ok: false, line, reason: shape.reason };
	if (shape.command === "status") return { ok: true, line, text: "Dashboard command /status: What is running and what needs me?" };
	const id = shape.job_id;
	return { ok: true, line, text: `Dashboard command /stop ${id}: please stop job ${id}. This is my request, not a grant change; check the job's state and stop it the usual way.` };
}
