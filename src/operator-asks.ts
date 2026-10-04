/** Operator-session bookkeeping only. These records never grant parent authority. */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import { IsoTimestampSchema, isoTimestamp, validate } from "./contracts.ts";
import { durableAppend } from "./json-store.ts";

const Text = Type.String({ minLength: 1, pattern: "\\S" });
export const OperatorAskInputSchema = Type.Object({
	project: Text,
	question: Type.String({ minLength: 1, pattern: "\\S", description: "One short question; the background goes in context" }),
	options: Type.Array(Type.Object({ label: Text, consequence: Text }), { minItems: 1, maxItems: 5 }),
	recommendation: Type.String({ minLength: 1, pattern: "\\S", description: "Exactly one options[].label; the rationale goes in context" }),
	source_escalation: Type.Optional(Type.String({ pattern: "^es-[A-Za-z0-9_-]+$" })),
	job_ids: Type.Optional(Type.Array(Text)),
	evidence_paths: Type.Optional(Type.Array(Text)),
	/** Plain-text background for the human: what happened, what each option really does, the risk. Paragraphs or `- ` bullets. */
	context: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, pattern: "\\S", description: "Background the human needs to decide, plain text up to 2000 chars: what happened, what each option really does, the risk. Paragraphs or '- ' bullets." })),
}, { additionalProperties: false });
export type OperatorAskInput = Static<typeof OperatorAskInputSchema>;
const Id = Type.String({ pattern: "^ask-[a-f0-9]+$" });
const OpenEvent = Type.Object({
	...OperatorAskInputSchema.properties,
	type: Type.Literal("open"), id: Id, created_at: IsoTimestampSchema,
}, { additionalProperties: false });
const AnswerEvent = Type.Object({
	type: Type.Literal("answer"), id: Id, answered_at: IsoTimestampSchema, answer: Text,
}, { additionalProperties: false });
const WithdrawEvent = Type.Object({
	type: Type.Literal("withdraw"), id: Id, reason: Text,
}, { additionalProperties: false });
const EventSchema = Type.Union([OpenEvent, AnswerEvent, WithdrawEvent]);
type AskEvent = Static<typeof EventSchema>;
export type OperatorAsk = OperatorAskInput & {
	id: string; created_at: string; state: "open" | "answered" | "withdrawn";
	answered_at?: string; answer?: string; reason?: string;
};

export class OperatorAsks {
	readonly file: string;
	constructor(file: string) { this.file = file; }

	open(): OperatorAsk[];
	open(input: OperatorAskInput): OperatorAsk;
	open(input?: OperatorAskInput): OperatorAsk | OperatorAsk[] {
		if (input === undefined) return this.list().filter((ask) => ask.state === "open");
		const checked = validate<OperatorAskInput>(OperatorAskInputSchema, input);
		if (!checked.ok) throw new Error(`invalid operator ask: ${JSON.stringify(checked.errors)}`);
		// N11: a sentence recommendation never matches an option, so the card would show a red default against it.
		const labels = checked.value.options.map((option) => option.label.trim());
		if (!labels.includes(checked.value.recommendation.trim())) throw new Error(`invalid operator ask: recommendation must be exactly one option label (${labels.map((label) => JSON.stringify(label)).join(", ")}); put the rationale in context`);
		const event: Static<typeof OpenEvent> = {
			...checked.value,
			options: checked.value.options.map((option) => ({ ...option, consequence: option.consequence.length > 200 ? `${option.consequence.slice(0, 199)}\u2026` : option.consequence })),
			type: "open", id: `ask-${randomBytes(6).toString("hex")}`, created_at: isoTimestamp(),
		};
		this.list(); // Refuse a corrupt journal before appending more history.
		this.append(event);
		const { type: _, ...ask } = event;
		return { ...ask, state: "open" };
	}

	answer(id: string, answer: string): void {
		this.requireOpen(id);
		this.append({ type: "answer", id, answer, answered_at: isoTimestamp() });
	}

	withdraw(id: string, reason: string): void {
		this.requireOpen(id);
		this.append({ type: "withdraw", id, reason });
	}

	list(): OperatorAsk[] {
		let text: string;
		try { text = readFileSync(this.file, "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const asks = new Map<string, OperatorAsk>();
		const lines = text.split("\n");
		for (const [index, line] of lines.entries()) {
			if (!line && index === lines.length - 1) continue;
			try {
				const checked = validate<AskEvent>(EventSchema, JSON.parse(line));
				if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
				const event = checked.value;
				const prior = asks.get(event.id);
				if (event.type === "open") {
					if (prior) throw new Error(`duplicate ask ${event.id}`);
					const { type: _, ...ask } = event;
					asks.set(event.id, { ...ask, state: "open" });
				} else {
					if (!prior || prior.state !== "open") throw new Error(`ask ${event.id} is not open`);
					if (event.type === "answer") Object.assign(prior, { state: "answered", answer: event.answer, answered_at: event.answered_at });
					else Object.assign(prior, { state: "withdrawn", reason: event.reason });
				}
			} catch (error) { throw new Error(`invalid operator asks ${this.file}:${index + 1}: ${(error as Error).message}`); }
		}
		return [...asks.values()];
	}

	/** Most recently opened first, including settled asks. */
	recent(limit = 10): OperatorAsk[] { return this.list().reverse().slice(0, limit); }

	private requireOpen(id: string): void {
		const ask = this.list().find((item) => item.id === id);
		if (!ask) throw new Error(`unknown operator ask ${id}`);
		if (ask.state !== "open") throw new Error(`operator ask ${id} is not open`);
	}

	private append(event: AskEvent): void {
		const checked = validate<AskEvent>(EventSchema, event);
		if (!checked.ok) throw new Error(`invalid operator ask event: ${JSON.stringify(checked.errors)}`);
		durableAppend(this.file, `${JSON.stringify(checked.value)}\n`);
	}
}
