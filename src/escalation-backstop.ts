/**
 * Escalation backstop (cp-gb8d). An escalation raised outside `cp_escalate` (a gate's
 * `raiseForGate`, for one) has no bridge relay path, and Web Push leaves the delegable kinds
 * to the main session, so es-8d0465 sat open ~13 h without reaching it. The operator session
 * relays, once per id, every escalation that the dashboard would turn amber: open at least
 * `ESCALATION_BACKSTOP_SECONDS`, represented by no open operator ask, and never relayed to the
 * session before (bridge relays are recorded here too).
 *
 * Notification only: no authorization, no parent wake, no write to the escalation store or
 * the ask journal. At most once per id, with two accepted edges: the ledger is claimed before
 * the push, so a session that dies in between loses that one relay; and two operator sessions
 * on one home can both relay (`atomicWriteJson` is not a cross-process lock). Open ids are
 * pinned in the ledger; only settled history is capped.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Static, Type } from "typebox";
import { bridgePaths, type BridgeRelay } from "./cp-bridge.ts";
import { type Escalation, IsoTimestampSchema, isoTimestamp, layoutForHome, type Mode, SCHEMA_VERSION, validate } from "./contracts.ts";
import { EscalationStore } from "./escalation.ts";
import { atomicWriteJson } from "./json-store.ts";
import type { OperatorAsk } from "./operator-asks.ts";
import { escalationProjects, homeMandateProjects, homeProjectResolver, projectTag, withProjectTag } from "./project-report.ts";

/** The dashboard's amber threshold: `src/viewer/overview-decisions.ts` `parent_questions`, `viewer-app/screens/{Overview,Decisions,DecisionContext}.tsx`. */
export const ESCALATION_BACKSTOP_SECONDS = 600;
export const ESCALATION_BACKSTOP_TICK_MS = 60_000;
export const ESCALATION_RELAY_LEDGER_KEEP = 512;

const LedgerSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		items: Type.Array(
			Type.Object(
				{
					id: Type.String({ pattern: "^es-[A-Za-z0-9_-]+$" }),
					relayed_at: IsoTimestampSchema,
					via: Type.Union([Type.Literal("bridge"), Type.Literal("backstop")]),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);
type Ledger = Static<typeof LedgerSchema>;

export function escalationRelayLedgerFile(home: string, mode: Mode): string {
	return resolve(home, layoutForHome(mode, home).state, "operator", "escalation-relays.json");
}

/** Every escalation id relayed to the operator session, by the bridge or by the backstop. */
export class EscalationRelayLedger {
	readonly file: string;
	constructor(file: string) {
		this.file = file;
	}

	#read(): Ledger {
		if (!existsSync(this.file)) return { schema_version: SCHEMA_VERSION, items: [] };
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(this.file, "utf8"));
		} catch (error) {
			throw new Error(`${this.file} is not valid JSON (${(error as Error).message}); refusing to guess`);
		}
		const parsed = validate<Ledger>(LedgerSchema, raw);
		if (!parsed.ok) throw new Error(`${this.file} violates the escalation-relay ledger contract (${parsed.errors.join("; ")}); refusing to guess`);
		return parsed.value;
	}

	ids(): Set<string> {
		return new Set(this.#read().items.map((item) => item.id));
	}

	/**
	 * Record `id`; false when it is already recorded. Ids in `open` are pinned, so a still-open
	 * escalation is never forgotten and re-relayed; only the rest is capped to the newest
	 * `ESCALATION_RELAY_LEDGER_KEEP`.
	 */
	note(id: string, via: "bridge" | "backstop", at: string = isoTimestamp(), open: ReadonlySet<string> = new Set()): boolean {
		const ledger = this.#read();
		if (ledger.items.some((item) => item.id === id)) return false;
		const all = [...ledger.items, { id, relayed_at: at, via }].sort((a, b) => a.relayed_at.localeCompare(b.relayed_at));
		const kept = new Set(all.filter((item) => !open.has(item.id)).slice(-ESCALATION_RELAY_LEDGER_KEEP));
		const items = all.filter((item) => open.has(item.id) || kept.has(item));
		const next = { schema_version: SCHEMA_VERSION, items };
		const checked = validate<Ledger>(LedgerSchema, next);
		if (!checked.ok) throw new Error(`refusing to write an invalid escalation-relay ledger: ${checked.errors.join("; ")}`);
		atomicWriteJson(this.file, next);
		return true;
	}
}

/** Record a bridge escalation relay, so the backstop never repeats it. Throws on a ledger failure. */
export function noteBridgeRelay(home: string, mode: Mode, relay: BridgeRelay): void {
	if (relay.kind !== "escalation" || !relay.escalationId) return;
	const open = new Set(new EscalationStore({ home }).open().map((item) => item.id));
	new EscalationRelayLedger(escalationRelayLedgerFile(home, mode)).note(relay.escalationId, "bridge", isoTimestamp(), open);
}

/** The dashboard's rule: open, old enough, no open ask represents it — and never relayed. */
export function dueEscalations(input: {
	open: readonly Escalation[];
	asks: readonly OperatorAsk[];
	relayed: ReadonlySet<string>;
	now: Date;
	afterSeconds?: number;
}): Escalation[] {
	const after = (input.afterSeconds ?? ESCALATION_BACKSTOP_SECONDS) * 1000;
	const represented = new Set(input.asks.filter((ask) => ask.state === "open").map((ask) => ask.source_escalation));
	return input.open
		.filter((item) => {
			const created = Date.parse(item.created_at);
			return item.status === "open" && Number.isFinite(created) && input.now.getTime() - created >= after && !represented.has(item.id) && !input.relayed.has(item.id);
		})
		.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function overdueRelay(home: string, escalation: Escalation, now: Date): BridgeRelay {
	const minutes = Math.floor((now.getTime() - Date.parse(escalation.created_at)) / 60_000);
	const text = `${escalation.id} (${escalation.kind}) has been open ${minutes} min and was never relayed to this session — ${escalation.question}`;
	let tagged: string;
	try {
		tagged = withProjectTag(escalationProjects(escalation, homeProjectResolver(home), homeMandateProjects(home)), text);
	} catch {
		tagged = `${projectTag([undefined])} ${text}`; // Unresolvable project is named as unknown, never left untagged.
	}
	return {
		kind: "escalation",
		...(escalation.job_ids[0] ? { jobId: escalation.job_ids[0] } : {}),
		escalationId: escalation.id,
		stale: false,
		text: tagged,
		receipt: { level: "owner_observed", reached: ["owner_observed"] },
		paths: bridgePaths(home, escalation.job_ids, escalation.evidence_paths),
	};
}

export interface EscalationBackstopPorts {
	home: string;
	open(): Escalation[];
	asks(): OperatorAsk[];
	ledger: EscalationRelayLedger;
	relay(relay: BridgeRelay): void;
	now?(): Date;
}

/** One pass: claim each due id in the ledger, then relay it. Returns the relayed ids; store and ledger errors propagate. */
export function runEscalationBackstop(ports: EscalationBackstopPorts): string[] {
	const now = ports.now?.() ?? new Date();
	const relayed = ports.ledger.ids();
	const open = ports.open();
	const pinned = new Set(open.map((item) => item.id));
	const due = dueEscalations({ open, asks: ports.asks(), relayed, now });
	const sent: string[] = [];
	for (const escalation of due) {
		if (!ports.ledger.note(escalation.id, "backstop", isoTimestamp(now), pinned)) continue;
		ports.relay(overdueRelay(ports.home, escalation, now));
		sent.push(escalation.id);
	}
	return sent;
}
