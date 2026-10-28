/**
 * Header guard (issue 589): an operator reply naming project work with no `[project]` header over it is forced back
 * once; the re-send's outcome goes to the sidecar the viewer reads (src/viewer/reply-splits.ts). Never edits the
 * transcript. `NO-PROJECT` accepts a reply untagged.
 */
import { MandateStore } from "./mandate.ts";
import { durableAppend } from "./json-store.ts";
import type { GuardEntry } from "./ask-guard.ts";
import { hasRefs, projectByRefs, refProjects, splitReply, type SplitContext } from "./viewer/reply-split.ts";
import { type ReplySplitRecord, replySplitsFile } from "./viewer/reply-splits.ts";
import { operatorReplyContext } from "./viewer/sessions-view.ts";

export const HEADER_GUARD_TYPE = "cp-header-guard";
export const NO_PROJECT = "NO-PROJECT";
export const HEADER_NUDGE = `Your reply covers project work without [project] section headers. Re-send it with one [project] header per section, or reply ${NO_PROJECT}.`;

type Reply = { ts: number; block: number; text: string };
type Message = { role?: string; content?: unknown; timestamp?: unknown };
const blocks = (content: unknown): Array<{ type?: unknown; text?: unknown }> => (Array.isArray(content) ? content : []);

/** The last assistant message's last text block (shortcut: earlier blocks of a multi-block reply are not linted). */
function lastReply(messages: Message[]): Reply | undefined {
	const message = messages.findLast((m) => m?.role === "assistant");
	if (typeof message?.timestamp !== "number") return undefined;
	const all = blocks(message.content), block = all.findLastIndex((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim() !== "");
	return block < 0 ? undefined : { ts: message.timestamp, block, text: String(all[block]!.text) };
}

/** The project of the human line a reply answers: its own leading `[project] `, else the one its ids resolve to. */
function replyTo(messages: Message[], ctx: SplitContext): string | undefined {
	const user = messages.findLast((m) => m?.role === "user");
	const text = typeof user?.content === "string" ? user.content : blocks(user?.content).map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n");
	const named = /^\[([^\]]+)\] /.exec(text)?.[1];
	return named && ctx.projects.has(named) ? named : projectByRefs(text, ctx);
}

/** A miss: some section with no header of its own names an id that resolves to a known project. */
const headerMiss = (text: string, ctx: SplitContext): boolean =>
	hasRefs(text) && splitReply(text, ctx).some((s) => s.source !== "header" && refProjects(s.text, ctx).size > 0);

/** The single project of the active mandates, the last fallback before `general`. */
function mandateProject(home: string): string | undefined {
	const active = new Set(new MandateStore(home).list().filter((m) => m.status === "active").flatMap((m) => m.projects));
	return active.size === 1 ? [...active][0] : undefined;
}

export interface HeaderTarget { home: string; stateDir: string; sessionFile?: string }

export class HeaderGuard {
	#nudged: Reply | undefined;
	#done = false;

	readonly #target: () => HeaderTarget;
	constructor(target: () => HeaderTarget) { this.#target = target; }

	/** `agent_settled`: a forced continuation is another loop of the same run, so the run ends only here. */
	runEnded(): void { this.#nudged = undefined; this.#done = false; }

	/** The ask guard forced the re-send back first: it never added headers, so close out with no record. */
	askNudged(): void { if (this.#nudged) this.#done = true; }

	/** First miss in a run: one forced continuation. The next settle records its outcome; never a second nudge. */
	beforeSettle(contextMessages: unknown): { entries: GuardEntry[]; continue: true } | undefined {
		if (this.#done) return undefined;
		const messages = (Array.isArray(contextMessages) ? contextMessages : []) as Message[];
		const reply = lastReply(messages);
		if (!reply || (!this.#nudged && !hasRefs(reply.text))) return undefined;
		const target = this.#target(), ctx: SplitContext = operatorReplyContext({ home: target.home, stateDir: target.stateDir });
		if (!this.#nudged) {
			if (!headerMiss(reply.text, ctx)) return undefined;
			this.#nudged = reply;
			return { entries: [{ type: "custom_message", customType: HEADER_GUARD_TYPE, display: false, content: HEADER_NUDGE }], continue: true };
		}
		this.#done = true;
		const original = this.#nudged;
		if (reply.text.trim().toUpperCase().startsWith(NO_PROJECT)) this.#append(target, "hidden", reply);
		else if (headerMiss(reply.text, ctx)) {
			const fallback = replyTo(messages, ctx) ?? mandateProject(target.home);
			this.#append(target, "superseded", original); // one copy shows: the re-send's split, not both
			this.#append(target, "split", reply, splitReply(reply.text, { ...ctx, fallback }));
		} else this.#append(target, "superseded", original);
		return undefined;
	}

	#append(target: HeaderTarget, type: ReplySplitRecord["type"], reply: Reply, segments?: ReplySplitRecord["segments"]): void {
		if (!target.sessionFile) return; // an unsaved session has no transcript to annotate
		const record: ReplySplitRecord = { type, session_file: target.sessionFile, ts: reply.ts, block: reply.block, ...(segments ? { segments } : {}) };
		durableAppend(replySplitsFile(target.stateDir), `${JSON.stringify(record)}\n`, { mode: 0o600 });
	}
}
