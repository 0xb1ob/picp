/**
 * The native Claude parent's process (driver `claude`, S1a stub): it parses the argv `nativeParentSpawnOptions` builds
 * and speaks the pi RPC lines the bridge reads. Only `get_state` is answered; every other command is refused by name.
 */
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { nativeModelId } from "./claude.ts";

const write = (record: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify(record)}\n`);

let sessionFile: string;
let modelId: string;
try {
	const { values } = parseArgs({ options: { session: { type: "string" }, model: { type: "string" }, "system-prompt-file": { type: "string" } }, strict: true });
	if (!values.session || !values.model || !values["system-prompt-file"]) throw new Error("--session, --model and --system-prompt-file are required");
	sessionFile = values.session;
	modelId = nativeModelId(values.model);
} catch (error) {
	process.stderr.write(`[native claude parent] refused to start: ${(error as Error).message}\n`);
	process.exit(2);
}

function command(line: string): void {
	let request: { id?: unknown; type?: unknown };
	try {
		request = JSON.parse(line) as typeof request;
	} catch {
		return;
	}
	const reply = (body: Record<string, unknown>) => write({ type: "response", id: request.id, command: request.type, ...body });
	if (request.type === "get_state") return reply({ success: true, data: { sessionFile, model: { provider: "anthropic", id: modelId }, isStreaming: false } });
	reply({ success: false, error: `the native claude parent does not take ${String(request.type)} yet` });
}

createInterface({ input: process.stdin }).on("line", command).on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
