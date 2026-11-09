/**
 * The native parent's session view (`nativeParentLogFile`): its turns as pi session lines beside the record, which the
 * viewer reads as the parent's file on driver claude. A record with no log yet imports its Claude CLI sessions once.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { nativeParentLogFile } from "../viewer/native-parent-log.ts";
import { capped, nativeTranscript, type NativeTranscript } from "./claude-transcript.ts";

const WAKE = /^\[fleet wake-up (\S+) — from the fleet, not an operator message\]\n/;
/** The Claude CLI's session store under its config dir: `<config>/projects/<cwd>/<id>.jsonl`, never the home's. */
const CLI_SESSIONS = "projects";

/** A wake-up as the model reads it: behind its fleet marker, never mistaken for an operator message. */
export const wakeBlock = (customType: string, text: string): string => `[fleet wake-up ${customType} — from the fleet, not an operator message]\n${text}`;

type Landed = { role: "user"; content: unknown } | { role: "custom"; customType: string; content: unknown; display?: boolean };
type Block = Record<string, unknown>;

const texts = (content: unknown): string[] => typeof content === "string" ? [content]
	: Array.isArray(content) ? (content as Block[]).flatMap((block) => (block?.type === "text" ? [String(block.text ?? "")] : [])) : [];

export interface ParentLog {
	readonly file: string;
	/** A message entering the parent's context: an operator text as pi's user message, a wake-up as its custom message. */
	land(message: Landed): void;
	relay(message: SDKMessage): void;
	/** A turn that ended in error or was aborted, as pi's assistant error. */
	failed(stopReason: string, errorMessage: string): void;
	compacted(tokensBefore: number | undefined): void;
}

function landed(log: NativeTranscript, message: Landed, at?: string): void {
	if (message.role === "user") return log.message("user", [{ type: "text", text: capped(texts(message.content).join("\n")) }], {}, at);
	const content = typeof message.content === "string" ? capped(message.content) : message.content;
	log.entry("custom_message", { customType: message.customType, content, display: message.display !== false }, at);
}

/** One line of the CLI's `<session_id>.jsonl` as the live entry would have logged it; other lines are skipped. */
function replay(log: NativeTranscript, raw: string): void {
	let line: Block;
	try {
		line = JSON.parse(raw) as Block;
	} catch {
		return;
	}
	const at = typeof line.timestamp === "string" ? line.timestamp : undefined;
	if (line.isSidechain === true || line.isMeta === true || line.isCompactSummary === true) return;
	if (line.type === "system" && line.subtype === "compact_boundary") {
		const before = (line.compactMetadata as { preTokens?: unknown } | undefined)?.preTokens;
		return log.entry("compaction", typeof before === "number" ? { tokensBefore: before } : {}, at);
	}
	const message = line.message as { content?: unknown } | undefined;
	if (!message || (line.type !== "user" && line.type !== "assistant")) return;
	// SAFETY: a CLI session line carries the SDK message's own `message`; relay reads only its content blocks.
	if (line.type === "assistant") return log.relay({ type: "assistant", message, parent_tool_use_id: null } as unknown as SDKMessage, at);
	for (const text of texts(message.content)) {
		const wake = WAKE.exec(text);
		landed(log, wake ? { role: "custom", customType: wake[1]!, content: text.slice(wake[0].length), display: true } : { role: "user", content: text }, at);
	}
	if (Array.isArray(message.content) && (message.content as Block[]).some((block) => block?.type === "tool_result")) {
		log.relay({ type: "user", message, parent_tool_use_id: null } as unknown as SDKMessage, at);
	}
}

/** Each recorded session's CLI file under `<config>/projects/<cwd>/`, imported in order; a missing one is named. */
function backfill(log: NativeTranscript, claudeConfig: string, sessionIds: readonly string[]): void {
	const projects = join(claudeConfig, CLI_SESSIONS);
	let dirs: string[] = [];
	try {
		dirs = readdirSync(projects);
	} catch { /* no CLI store yet: nothing to import */ }
	for (const id of new Set(sessionIds)) {
		const found = dirs.map((dir) => join(projects, dir, `${id}.jsonl`)).find((file) => existsSync(file));
		try {
			if (!found) throw new Error("no CLI session file");
			for (const raw of readFileSync(found, "utf8").split("\n")) if (raw.trim()) replay(log, raw);
		} catch (error) {
			process.stderr.write(`[native claude parent] claude session ${id} not imported into ${log.file}: ${(error as Error).message}\n`);
		}
	}
}

/** The log for `record`; when it does not exist yet, the record's claude sessions are imported first. */
export function parentLog(record: string, options: { cwd: string; claudeConfig: string; sessionIds: readonly string[]; toolName: (name: string) => string }): ParentLog {
	const log = nativeTranscript(nativeParentLogFile(record), { id: basename(record, ".jsonl"), cwd: options.cwd }, options.toolName);
	if (!existsSync(log.file)) backfill(log, options.claudeConfig, options.sessionIds);
	return {
		file: log.file,
		land: (message) => landed(log, message),
		relay: (message) => {
			// A compaction the CLI ran on its own mid-turn; a manual `/compact` is logged by `compacted` instead.
			if (message.type === "system" && message.subtype === "compact_boundary") log.entry("compaction", { tokensBefore: message.compact_metadata.pre_tokens });
			else log.relay(message);
		},
		failed: (stopReason, errorMessage) => log.message("assistant", [], { stopReason, errorMessage }),
		compacted: (tokensBefore) => log.entry("compaction", tokensBefore === undefined ? {} : { tokensBefore }),
	};
}
