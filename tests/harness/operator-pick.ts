import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { layoutForHome, type OperatorModelPickReference } from "../../src/contracts.ts";
import { issueOperatorPick } from "../../src/operator-model-pick.ts";
import { controlJournalFile, dashboardMarker } from "../../src/viewer/control-files.ts";

/** What the operator session holds: the human typing (terminal or a `dc-…` dashboard request), the parent, the model. */
export type PickAuthor = { kind: "terminal" } | { kind: "dashboard"; controlId: string } | { kind: "parent" } | { kind: "main-session" };

/**
 * A real proof for `model` from an entry of a registered operator session (the bridge's issue path, no RPC). `author`
 * shapes that entry: a dashboard request also gets its bridge audit rows; a parent or main-session entry is refused.
 */
export function seedOperatorPick(home: string, model: string, options: { jobId?: string; quote?: string; driver?: "pi" | "claude" | "codex"; author?: PickAuthor } = {}): OperatorModelPickReference {
	const quote = options.quote ?? `use ${model}${options.driver ? ` on ${options.driver}` : ""} for this one`;
	const sessionFile = join(home, "operator-sessions", `operator-${randomBytes(4).toString("hex")}.jsonl`);
	const body = `Please ${quote}.`;
	const author = options.author ?? { kind: "terminal" };
	const id = randomBytes(4).toString("hex");
	const text = (value: string) => [{ type: "text", text: value }];
	const entry = author.kind === "parent" ? { type: "custom_message", id, customType: "cp-bridge", content: text(`[cp-bridge send ps-1] ${body}`) }
		: author.kind === "main-session" ? { type: "message", id, message: { role: "assistant", content: text(body) } }
		: { type: "message", id, message: { role: "user", content: text(author.kind === "dashboard" ? `${body}\n${dashboardMarker(author.controlId)}` : body) } };
	mkdirSync(join(home, "operator-sessions"), { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
	if (author.kind === "dashboard") {
		const journal = controlJournalFile(join(resolve(home), layoutForHome("multi", home).state));
		mkdirSync(dirname(journal), { recursive: true });
		appendFileSync(journal, `${JSON.stringify({ id: author.controlId, type: "request", by: "bridge", text: body, session_file: sessionFile })}\n` +
			`${JSON.stringify({ id: author.controlId, type: "outcome", by: "bridge", state: "delivered" })}\n`);
	}
	return issueOperatorPick({
		home, sessionFile, entries: [entry], model, quote, ...(options.jobId ? { jobId: options.jobId } : {}), ...(options.driver ? { driver: options.driver } : {}),
		...(author.kind === "dashboard" ? { controlId: author.controlId } : {}),
	}).reference;
}
