/**
 * A native run's pi-format log (a worker's job Log, the parent's session view): each top-level SDK assistant/user
 * message appended as the pi session lines the viewer's transcript parser already reads (text, tool calls and results,
 * thinking text).
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export const TRANSCRIPT_BLOCK_CAP = 64 * 1024;

/** `<state>/sessions/native/<job>.jsonl`; the run dir is `<state>/runs/<job>` in every home layout. */
export const nativeTranscriptFile = (runDir: string, jobId: string): string => join(runDir, "..", "..", "sessions", "native", `${jobId}.jsonl`);

/** Text over the 64 KiB cap is cut there and says so. */
export function capped(text: string): string {
	const bytes = Buffer.byteLength(text);
	if (bytes <= TRANSCRIPT_BLOCK_CAP) return text;
	return `${Buffer.from(text).subarray(0, TRANSCRIPT_BLOCK_CAP).toString("utf8")}\n[picp: truncated ${bytes - TRANSCRIPT_BLOCK_CAP} bytes over the 64 KiB block cap]`;
}

function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: { type?: unknown; text?: unknown }) => (part?.type === "text" ? String(part.text ?? "") : part?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
}

export interface NativeTranscript {
	file: string;
	/** A turn's prompt as the parent's message; a resumed turn is marked first. */
	prompt(text: string, resumed: boolean): void;
	/** `at` (ISO) dates a replayed message; absent is now. */
	relay(message: SDKMessage, at?: string): void;
	/** One pi session line of `type` (`custom_message`, `compaction`), stamped with an id and `at`. */
	entry(type: string, fields: Record<string, unknown>, at?: string): void;
	message(role: string, content: unknown[], extra?: Record<string, unknown>, at?: string): void;
}

/** Append-only, one line per message; a failed write is named once on stderr and never fails the run it logs. */
export function nativeTranscript(file: string, header: { id: string; cwd: string }, toolName: (name: string) => string): NativeTranscript {
	const names = new Map<string, string>();
	let failed = false;
	const append = (record: Record<string, unknown>): void => {
		if (failed) return;
		try {
			if (!existsSync(file)) {
				mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
				appendFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: header.id, timestamp: new Date().toISOString(), cwd: header.cwd })}\n`, { mode: 0o600 });
			}
			appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
		} catch (error) {
			failed = true;
			process.stderr.write(`[claude cli] transcript ${file} not written: ${(error as Error).message}\n`);
		}
	};
	const stamp = (at?: string) => ({ id: randomUUID().slice(0, 8), timestamp: at ?? new Date().toISOString() });
	const entry = (type: string, fields: Record<string, unknown>, at?: string) => append({ type, ...stamp(at), ...fields });
	const message = (role: string, content: unknown[], extra: Record<string, unknown> = {}, at?: string) => entry("message", { message: { role, content, timestamp: at ? Date.parse(at) : Date.now(), ...extra } }, at);
	return {
		file,
		entry,
		message,
		prompt(text, resumed) {
			if (resumed) entry("custom_message", { customType: "native", content: "Resumed the recorded Claude session", display: true });
			message("user", [{ type: "text", text: capped(text) }]);
		},
		relay(sdk, at) {
			if ((sdk.type !== "assistant" && sdk.type !== "user") || sdk.parent_tool_use_id !== null) return;
			const content = sdk.message.content;
			// SAFETY: SDK content blocks are plain JSON objects; every field kept is checked or stringified.
			const blocks = Array.isArray(content) ? (content as unknown as Array<Record<string, unknown>>) : [];
			if (sdk.type === "user") {
				for (const block of blocks.filter((b) => b.type === "tool_result")) {
					const id = String(block.tool_use_id), name = names.get(id);
					message("toolResult", [{ type: "text", text: capped(resultText(block.content)) }], { toolCallId: id, ...(name ? { toolName: name } : {}), isError: block.is_error === true }, at);
				}
				return;
			}
			const kept = blocks.flatMap((block): Array<Record<string, unknown>> => {
				if (block.type === "text") return [{ type: "text", text: capped(String(block.text ?? "")) }];
				if (block.type === "thinking") return [{ type: "thinking", thinking: capped(String(block.thinking ?? "")) }];
				if (block.type !== "tool_use") return [];
				const id = String(block.id), name = toolName(String(block.name)), json = JSON.stringify(block.input ?? {});
				names.set(id, name);
				return [{ type: "toolCall", id, name, arguments: Buffer.byteLength(json) <= TRANSCRIPT_BLOCK_CAP ? block.input ?? {} : { input: capped(json) } }];
			});
			if (kept.length > 0) message("assistant", kept, {}, at);
		},
	};
}
