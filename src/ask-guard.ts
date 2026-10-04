/**
 * Ask guard (cp-6fyl E): a question put to the human in prose, with no `cp_parent ask` behind it, is forced back to
 * the main session once, then carded by the bridge itself.
 *
 * Enforced (structural): whether a `cp_parent ask` succeeded in a run (`tool_execution_end`), one forced
 * continuation when the detector fires without one, and a deterministic fallback card when the model still opens
 * none. Heuristic (not enforceable): `detectHumanQuestion` is a text rule. It misses a question with no `?` and no
 * cue phrase, and it fires on a rhetorical or quoted question. No pi hook can stop the model writing prose.
 */
import type { OperatorAsk, OperatorAsks } from "./operator-asks.ts";

export const ASK_GUARD_TYPE = "cp-ask-guard";
export const DETECTED_ASK_PREFIX = "Detected in the main session's reply";
export const NO_ASK = "NO-ASK";
const DETECTED_LABEL = "Answer in the operator chat";
const WINDOW_CHARS = 600;
// `still waiting` / `your (two) choices` (N10): a choice put to the human with no `?` and no other cue.
const CUE = /\b(should I|do you want|would you like|which (option|one)|please (confirm|choose|decide)|your call|let me know|still waiting|your (?:\w+ )?choices?)\b/i;
const DASHBOARD_ASK_CLICK = /\[cp-dashboard [^\]]*\bask=/;

/** The sentence that asks the human something, from the tail of the final text; fences and `>` quotes never count. */
export function detectHumanQuestion(text: string): string | undefined {
	const prose = text.replace(/```[\s\S]*?(```|$)/g, "\n").split("\n").filter((line) => !/^\s*>/.test(line)).join("\n");
	let found: string | undefined;
	for (const line of prose.slice(-WINDOW_CHARS).split("\n")) {
		for (const part of line.split(/(?<=[.!?])\s+/)) {
			const sentence = part.trim();
			if (sentence && (/\?["')\]*_`]*$/.test(sentence) || CUE.test(sentence))) found = sentence;
		}
	}
	return found;
}

const textOf = (content: unknown): string =>
	typeof content === "string" ? content
		: Array.isArray(content) ? content.map((part) => (part as { text?: unknown })?.text).filter((part): part is string => typeof part === "string").join("\n")
			: "";

/** The text of the last assistant message in `messages` (pi's `AgentMessage[]`), or "". */
export function lastAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; content?: unknown };
		if (message?.role === "assistant") return textOf(message.content);
	}
	return "";
}

export type GuardEntry = { type: "custom_message"; customType: string; content: string; display: boolean };

export class AskGuard {
	#asked = false;
	#nudged: string | undefined; // the reply that asked, kept for the card
	#carded = false;

	/** `agent_settled`, not `agent_start`: pi starts a new agent loop for each forced continuation of the same run. */
	runEnded(): void { this.#asked = false; this.#nudged = undefined; this.#carded = false; }

	/** A `cp_parent ask` that opened an ask (an `ask_answer` result carries an id too, but never `state: "open"`). */
	toolEnded(event: { toolName?: string; isError?: boolean; result?: { details?: { id?: unknown; state?: unknown } } }): void {
		const details = event?.result?.details;
		if (event?.toolName === "cp_parent" && !event.isError && details?.state === "open" && /^ask-/.test(String(details.id))) this.#asked = true;
	}

	/** First call with a detected question and no ask: one forced continuation. Second: the card, unless the reply is `NO-ASK`. */
	beforeSettle(text: string, asks: () => OperatorAsks, now = new Date()): { entries?: GuardEntry[]; continue?: boolean; card?: OperatorAsk } | undefined {
		if (this.#asked || this.#carded) return undefined;
		if (!this.#nudged) {
			if (!detectHumanQuestion(text)) return undefined;
			this.#nudged = text;
			return {
				entries: [{ type: "custom_message", customType: ASK_GUARD_TYPE, display: false, content: `Your reply asks the human a question but opened no cp_parent ask. Open it now (short question, options, recommendation, context) or reply ${NO_ASK} if it was not a question.` }],
				continue: true,
			};
		}
		this.#carded = true;
		if (text.trim().toUpperCase().startsWith(NO_ASK)) return undefined;
		return { card: this.#card(asks(), this.#nudged, now) };
	}

	#card(asks: OperatorAsks, text: string, now: Date): OperatorAsk {
		return asks.open({
			project: /\[([\w.-]{2,})\](?!\()/.exec(text)?.[1] ?? "command-post",
			question: (detectHumanQuestion(text) ?? text.trim()).slice(0, 300),
			options: [{ label: DETECTED_LABEL, consequence: "your next chat message is recorded as the answer" }],
			recommendation: DETECTED_LABEL,
			context: `${DETECTED_ASK_PREFIX} (no cp_parent ask was opened) at ${now.toISOString()}:\n${text.slice(-1500)}`,
		});
	}

	/** The human's next chat line answers every open detected card; a dashboard click on an ask is the LLM's to record. */
	userMessage(message: unknown, asks: () => OperatorAsks): OperatorAsk[] {
		const user = message as { role?: string; content?: unknown } | undefined;
		if (user?.role !== "user") return [];
		const text = textOf(user.content).trim();
		if (!text || DASHBOARD_ASK_CLICK.test(text)) return [];
		const store = asks();
		const cards = store.open().filter((ask) => ask.context?.startsWith(DETECTED_ASK_PREFIX));
		for (const card of cards) store.answer(card.id, text.slice(0, 1000));
		return cards;
	}
}
