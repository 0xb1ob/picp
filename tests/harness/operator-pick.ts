import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OperatorModelPickReference } from "../../src/contracts.ts";
import { issueOperatorPick } from "../../src/operator-model-pick.ts";

/** A real proof for `model` from a human entry of a registered operator session (the bridge's issue path, no RPC). */
export function seedOperatorPick(home: string, model: string, options: { jobId?: string; quote?: string } = {}): OperatorModelPickReference {
	const quote = options.quote ?? `use ${model} for this one`;
	const sessionFile = join(home, "operator-sessions", `operator-${randomBytes(4).toString("hex")}.jsonl`);
	const entry = { type: "message", id: randomBytes(4).toString("hex"), message: { role: "user", content: [{ type: "text", text: `Please ${quote}.` }] } };
	mkdirSync(join(home, "operator-sessions"), { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
	return issueOperatorPick({ home, sessionFile, entries: [entry], model, quote, ...(options.jobId ? { jobId: options.jobId } : {}) }).reference;
}
