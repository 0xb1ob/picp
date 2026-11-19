/**
 * A Codex run's pi-format Log (C1b), on the Claude driver's writer: the prompt, agent messages, reasoning summaries,
 * and one tool call and result per call, blocked and declined calls included. Same 64 KiB block cap.
 */
import { capped, nativeTranscript, TRANSCRIPT_BLOCK_CAP } from "./claude-transcript.ts";
import type { CodexToolEvent } from "./codex-spike.ts";

export interface CodexTranscript {
	file: string;
	/** A resumed turn is marked first, in Codex words (the shared marker names Claude). */
	prompt(text: string, resumed?: boolean): void;
	steer(text: string): void;
	agent(text: string): void;
	reasoning(text: string): void;
	tool(event: CodexToolEvent): void;
}

export function codexTranscript(file: string, header: { id: string; cwd: string }, model: string): CodexTranscript {
	const log = nativeTranscript(file, header, (name) => name);
	const names = new Map<string, string>();
	const assistant = (content: unknown[]) => log.message("assistant", content, { provider: "openai", model });
	const marked = (content: string, text: string) => {
		log.entry("custom_message", { customType: "native", content, display: true });
		log.prompt(text, false);
	};
	return {
		file,
		prompt: (text, resumed = false) => (resumed ? marked("Resumed the recorded Codex thread", text) : log.prompt(text, false)),
		steer: (text) => marked("Steered the running turn", text),
		agent: (text) => assistant([{ type: "text", text: capped(text) }]),
		reasoning: (text) => assistant([{ type: "thinking", thinking: capped(text) }]),
		tool(event) {
			if (event.phase === "start") {
				names.set(event.id, event.name);
				const json = JSON.stringify(event.args ?? {});
				assistant([{ type: "toolCall", id: event.id, name: event.name, arguments: Buffer.byteLength(json) <= TRANSCRIPT_BLOCK_CAP ? event.args ?? {} : { input: capped(json) } }]);
				return;
			}
			const exit = event.exitCode === undefined || event.exitCode === null ? "" : `\n[exit ${event.exitCode}]`;
			const body = `${event.output ?? ""}${exit}`.trim();
			log.message("toolResult", [{ type: "text", text: capped(body) }], { toolCallId: event.id, toolName: names.get(event.id) ?? event.name, isError: event.isError === true });
		},
	};
}
