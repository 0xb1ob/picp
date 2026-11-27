/**
 * Every message the gateway posts, as pure templates (golden-pinned). Operator text goes through `safeText` first: home
 * paths scrubbed, secrets redacted, and text still matching a secret pattern never sent.
 */
import type { OperatorAsk } from "../operator-asks.ts";
import { redactSecrets } from "../redact-secrets.ts";
import { SECRET_PATTERNS } from "../secret-patterns.ts";

export interface SlackMessage { text: string; blocks: unknown[] }

/** Escalation kinds a chat thread may answer; every other kind (and an unknown one) is link-only. */
export const CHAT_ANSWERABLE_KINDS: readonly string[] = ["product_ambiguity", "scope_expansion", "conflicting_acceptance", "loop_exhausted"];
export const REPLY_INLINE_LINES = 3;
export const REPLY_INLINE_CHARS = 500;
export const REPLY_CLIP_CHARS = 300;
export const LABEL_MAX = 100;
const BUTTON_MAX = 75;
const NO_LINK = "Open the dashboard to see it.";

export type ReceiptState = "queued" | "behind" | "delivered" | "held" | "dropped" | "refused";
export interface Receipt { state: ReceiptState; reason?: string }
export const RECEIPT_TEXT: Record<Exclude<ReceiptState, "dropped" | "refused">, string> = {
	queued: "Got it. Queued.",
	behind: "Queued behind the operator's current turn.",
	delivered: "Delivered.",
	held: "Operator offline: held for up to 24 h.",
};

/** An operator ask with no escalation, or one of the four answerable kinds; unreadable fails closed. */
export function chatAnswerable(ask: Pick<OperatorAsk, "source_escalation">, kindOf: (escalationId: string) => string | undefined): boolean {
	if (!ask.source_escalation) return true;
	try {
		const kind = kindOf(ask.source_escalation);
		return kind !== undefined && CHAT_ANSWERABLE_KINDS.includes(kind);
	} catch {
		return false;
	}
}

/** Home paths become `<home>`, secret shapes are redacted; undefined when a secret pattern still matches. */
export function safeText(text: string, homes: readonly string[]): string | undefined {
	let out = text;
	for (const home of [...homes].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(home).join("<home>");
	out = redactSecrets(out);
	return SECRET_PATTERNS.some((pattern) => pattern.re.test(out)) ? undefined : out;
}

/** Slack's three control characters; everything else is shown as written. */
const esc = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (text: string, max: number): string => {
	const points = [...text];
	return points.length > max ? `${points.slice(0, max - 1).join("").trimEnd()}…` : text;
};
const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text: esc(text) } });
const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
const linkTo = (link: string | null, label: string): string => (link ? `<${link}|${esc(label)}>` : NO_LINK);

function buttons(ask: OperatorAsk, labels: readonly string[], prefix: string) {
	return {
		type: "actions",
		block_id: `cp_ask_${ask.id}`,
		elements: labels.map((label, index) => {
			const recommended = ask.options[index]?.label === ask.recommendation;
			const suffix = recommended ? " (recommended)" : "";
			return { type: "button", action_id: `${prefix}${index}`, value: `${ask.id}:${index}`, text: { type: "plain_text", text: `${clip(label, BUTTON_MAX - suffix.length)}${suffix}`, emoji: false }, ...(recommended ? { style: "primary" } : {}) };
		}),
	};
}

/** Question, labels: each `safeText`ed, or undefined when any of them may not be sent. */
function cleanAsk(ask: OperatorAsk, homes: readonly string[]): { question: string; labels: string[] } | undefined {
	const question = safeText(ask.question, homes);
	const labels = ask.options.map((option) => safeText(option.label, homes));
	return question === undefined || labels.some((label) => label === undefined) ? undefined : { question, labels: labels as string[] };
}

/** A chat-answerable card: the question, one button per option (the recommendation marked) and a dashboard link. */
export function renderCard(ask: OperatorAsk, link: string | null, homes: readonly string[]): SlackMessage {
	const clean = cleanAsk(ask, homes);
	if (!clean) return renderNotice(undefined, link);
	return { text: esc(clean.question), blocks: [section(clean.question), buttons(ask, clean.labels, "cp_answer_"), context(linkTo(link, "Open on the dashboard"))] };
}

/** A dashboard-only decision: the question and a link, no buttons. */
export function renderNotice(question: string | undefined, link: string | null): SlackMessage {
	const text = question === undefined ? "Decision needed on the dashboard." : `Decision needed on the dashboard: ${question}`;
	return { text: esc(text), blocks: [section(text), context(linkTo(link, "Open on the dashboard"))] };
}

/** A card after its ask closed: the question kept, the buttons gone. */
export function renderClosed(ask: OperatorAsk, closed: { answered: string } | "withdrawn", homes: readonly string[]): SlackMessage {
	const question = safeText(ask.question, homes);
	const answer = closed === "withdrawn" ? undefined : safeText(closed.answered, homes);
	const status = closed === "withdrawn" ? "Withdrawn" : `Answered: ${answer === undefined ? "(see the dashboard)" : clip(answer.replace(/\s+/g, " ").trim(), LABEL_MAX)}`;
	return { text: esc(status), blocks: [...(question === undefined ? [] : [section(question)]), context(esc(status))] };
}

/** The operator's reply: as written when short, else its first paragraph clipped plus a link; secret text never. */
export function renderReply(text: string, link: string | null, homes: readonly string[]): SlackMessage {
	const safe = safeText(text.trim(), homes);
	if (safe === undefined || safe === "") return renderAmbiguous(link);
	if (safe.split("\n").length <= REPLY_INLINE_LINES && [...safe].length <= REPLY_INLINE_CHARS) return { text: esc(safe), blocks: [section(safe)] };
	const first = clip((safe.split(/\n\s*\n/).find((part) => part.trim()) ?? safe).trim(), REPLY_CLIP_CHARS);
	return { text: esc(first), blocks: [section(first), context(link ? `Full reply: ${linkTo(link, "the dashboard")}` : NO_LINK)] };
}

/** A turn bound to more than one thread (or a reply that may not be sent): only a link. */
export function renderAmbiguous(link: string | null): SlackMessage {
	const text = link ? `Replied on the dashboard: ${link}` : `Replied on the dashboard. ${NO_LINK}`;
	return { text: esc(text), blocks: [context(link ? `Replied on the dashboard: ${linkTo(link, "open it")}` : esc(text))] };
}

/** Two or more answerable cards open in the thread: which one a typed reply is for. */
export function renderWhich(asks: readonly OperatorAsk[], homes: readonly string[]): SlackMessage {
	const text = "Which question? Tap the answer you mean.";
	const blocks: unknown[] = [section(text)];
	asks.forEach((ask, n) => {
		const clean = cleanAsk(ask, homes);
		if (clean) blocks.push(section(clean.question), buttons(ask, clean.labels, `cp_which_${n}_`));
	});
	return { text: esc(text), blocks };
}

export const renderTooLong = (): SlackMessage => {
	const text = "Too long: 4,000 characters at most.";
	return { text, blocks: [section(text)] };
};

/** The status message's text for a receipt; a reason is scrubbed like any other text. */
export function renderReceipt(receipt: Receipt, homes: readonly string[]): SlackMessage {
	const reason = receipt.reason === undefined ? "" : (safeText(receipt.reason, homes) ?? "see the dashboard");
	const text = receipt.state === "dropped" ? `Dropped: ${reason}` : receipt.state === "refused" ? `Not delivered: ${reason}` : RECEIPT_TEXT[receipt.state];
	return { text: esc(text), blocks: [context(esc(text))] };
}
