/**
 * Schedule result cards (schedules refactor PR1): a run's final result is queued on the run record first, then posted
 * to the dashboard Answers journal and only then marked delivered. No parent turn, wake or fleet phase is involved,
 * so a teardown, a suppressed scheduled relay or an absent operator cannot lose it. Reads no artifact body.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type FleetRecord, LAYOUT, paths, type Receipt } from "./contracts.ts";
import type { FleetStore } from "./fleet.ts";
import type { IntakeResult } from "./intake.ts";
import type { Ledger } from "./ledger.ts";
import { OperatorAnswers } from "./operator-answers.ts";
import type { ScheduleRunStore } from "./schedule-runs.ts";
import type { ScheduleRun, ScheduleRunResult } from "./viewer/schedule-run-core.ts";
import { expandedRoles } from "./viewer/schedule-run-groups.ts";

/** Closed runs older than this never get a card: the first start after deploy must not flood Answers with history. */
export const RESULT_RECONCILE_WINDOW_MS = 7 * 86_400_000;
/** A PR-opening envelope is not the run's success: these post at run close (landed, handed off or dropped). */
const AT_CLOSE: readonly string[] = ["pr", "pipeline"];
const OUTCOME = { done: "completed", blocked: "blocked", failed: "failed" } as const;

export type ResultLedgerJob = { id: string; status: string; close_reason?: string; comments?: readonly { text?: unknown }[] };
export interface ResultFacts { status: keyof typeof OUTCOME; summary: string; generation: number | null; links: readonly (string | undefined)[] }
export interface ScheduleResultPorts {
	runs: ScheduleRunStore;
	answers: Pick<OperatorAnswers, "postScheduleResult">;
	ledgerJobs: () => readonly ResultLedgerJob[];
	/** A job's accepted envelope, read from disk (it survives teardown); undefined before intake accepted one. */
	facts: (jobId: string) => ResultFacts | undefined;
	now?: () => Date;
	log?: (line: string) => void;
}

/** Whose accepted envelope is the run's result: a skill run's S1 named on its anchor (`expanded:`), else the anchor. */
export function resultOwner(run: ScheduleRun, jobs: readonly ResultLedgerJob[]): string | null {
	if (!run.policy.recipe.skill) return run.anchor_job_id;
	const anchor = jobs.find((job) => job.id === run.anchor_job_id);
	const s1 = expandedRoles(anchor?.comments ?? []).S1;
	return s1 && run.members.some((member) => member.job_id === s1) ? s1 : null;
}

/** A reported job's accepted envelope, PR/board receipts and relocated artifact path; never the artifact body. */
export function reportedFacts(home: string, record: FleetRecord | undefined): ResultFacts | undefined {
	if (!record?.reported_at) return undefined;
	let envelope: { status?: unknown; summary?: unknown } | undefined;
	try {
		envelope = (JSON.parse(readFileSync(join(home, paths.envelopeFile(record.job_id)), "utf8")) as { envelope?: typeof envelope }).envelope;
	} catch {
		return undefined;
	}
	const status = envelope?.status;
	if (typeof envelope?.summary !== "string" || (status !== "done" && status !== "blocked" && status !== "failed")) return undefined;
	const artifact = join(home, paths.artifactFile(record.job_id));
	return { status, summary: envelope.summary, generation: (record.supersessions ?? 0) + 1, links: [existsSync(artifact) ? artifact : undefined, ...receiptLinks(record.receipts)] };
}

const receiptLinks = (receipts: readonly Receipt[] | undefined): (string | undefined)[] => (receipts ?? []).filter((r) => r.kind === "pr" || r.kind === "board").map((r) => r.url);
const stamp = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, "Z");
const cleanLinks = (links: readonly (string | undefined)[]): string[] =>
	[...new Set(links.filter((link): link is string => !!link && link.length <= 1000 && !/[\r\n]/.test(link)))].slice(0, 10);

export class ScheduleResults {
	readonly #ports: ScheduleResultPorts;
	constructor(ports: ScheduleResultPorts) {
		this.#ports = ports;
	}

	/** Intake's accepted envelope: queue the run's card before teardown or any wake, then post it. Never throws. */
	accepted(result: IntakeResult): void {
		if (!result.accepted || result.already || !this.#ports.runs.active) return;
		this.#safely(`queue the result of ${result.job_id}`, () => {
			const run = this.#ports.runs.runOfJob(result.job_id);
			if (!run || run.result || AT_CLOSE.includes(run.policy.recipe.delivery) || resultOwner(run, this.#ports.ledgerJobs()) !== result.job_id) return;
			const links = [result.artifact?.path, result.board_url, ...receiptLinks(result.receipts)];
			this.#queue(run, this.#fromFacts(run, result.job_id, { status: result.status ?? "done", summary: result.summary ?? "", generation: result.generation ?? 1, links }));
		});
		this.#safely("post schedule results", () => this.drain());
	}

	/** Startup and scheduler tick: heal a crash before the card was queued, queue closed runs' cards, then post. */
	sync(): void {
		if (!this.#ports.runs.active) return;
		this.#safely("reconcile schedule results", () => this.reconcile());
		this.#safely("post schedule results", () => this.drain());
	}

	reconcile(): void {
		const jobs = this.#ports.ledgerJobs();
		const now = this.#now().getTime();
		for (const run of this.#ports.runs.runs()) {
			if (run.result) continue;
			if (run.phase === "closed") {
				if (now - Date.parse(run.closed_at!) <= RESULT_RECONCILE_WINDOW_MS) this.#queue(run, this.#closed(run, jobs));
				continue;
			}
			const owner = AT_CLOSE.includes(run.policy.recipe.delivery) ? null : resultOwner(run, jobs);
			const facts = owner ? this.#ports.facts(owner) : undefined;
			if (owner && facts) this.#queue(run, this.#fromFacts(run, owner, facts));
		}
	}

	/** Post every queued, undelivered card; a failure stays queued with its named error for the next pass. */
	drain(): void {
		for (const run of this.#ports.runs.runs()) {
			const result = run.result;
			if (!result || result.delivered_at) continue;
			try {
				const posted = this.#ports.answers.postScheduleResult({
					project: run.policy.project, title: `${run.policy.recipe.title} — run ${result.outcome}`, text: cardText(run, result),
					evidence_paths: result.links, job_id: result.job_id,
					source: { kind: "schedule", schedule_id: run.schedule_id, run_id: run.id, source_key: result.source_key, outcome: result.outcome },
				});
				this.#ports.runs.editRun(run.id, (row) => {
					const { error: _error, ...delivered } = row.result!;
					row.result = { ...delivered, answer_id: posted.answer.id, delivered_at: stamp(this.#now()) };
				});
			} catch (error) {
				const message = (error as Error).message.trim().slice(0, 1000) || "unknown error";
				if (result.error === message) continue;
				// Logged once per distinct error, not every 30 s tick.
				this.#log(`schedule result card for ${run.id} is still pending: ${message}`);
				this.#safely(`record the pending error on ${run.id}`, () => this.#ports.runs.editRun(run.id, (row) => { row.result!.error = message; }));
			}
		}
	}

	#queue(run: ScheduleRun, result: ScheduleRunResult): void {
		this.#ports.runs.editRun(run.id, (row) => { row.result ??= result; });
	}

	#fromFacts(run: ScheduleRun, jobId: string, facts: ResultFacts): ScheduleRunResult {
		const generation = facts.generation;
		return { source_key: `${run.id}:${jobId}:${generation ?? 1}`, job_id: jobId, generation, outcome: OUTCOME[facts.status], headline: facts.summary.trim().slice(0, 4000) || "(no headline)", at: stamp(this.#now()), links: cleanLinks(facts.links), answer_id: null, delivered_at: null };
	}

	/** A run closed with no card yet: its owner's envelope if any, else a run-level outcome naming dropped members. */
	#closed(run: ScheduleRun, jobs: readonly ResultLedgerJob[]): ScheduleRunResult {
		const owner = resultOwner(run, jobs);
		const own = owner ? this.#ports.facts(owner) : undefined;
		const dropped = jobs.filter((job) => run.members.some((m) => m.job_id === job.id) && (job.close_reason ?? "").startsWith("dropped:")).map((job) => `${job.id} (${job.close_reason})`);
		const headline = [own?.summary.trim() || `No result envelope${owner ? ` from ${owner}` : ""}; run closed ${run.outcome}.`, dropped.length ? `Dropped: ${dropped.join(", ")}` : ""].filter(Boolean).join("\n");
		const links = [...(own?.links ?? []), ...run.members.flatMap((m) => (m.job_id === owner ? [] : this.#ports.facts(m.job_id)?.links ?? []))];
		const outcome = run.outcome === "completed" && own && own.status !== "done" ? OUTCOME[own.status] : run.outcome!;
		return { source_key: `${run.id}:closed`, job_id: own ? owner : null, generation: own?.generation ?? null, outcome, headline: headline.slice(0, 4000), at: stamp(this.#now()), links: cleanLinks(links), answer_id: null, delivered_at: null };
	}

	#safely(what: string, fn: () => void): void {
		try {
			fn();
		} catch (error) {
			this.#log(`could not ${what}: ${(error as Error).message}`);
		}
	}
	#now(): Date { return (this.#ports.now ?? (() => new Date()))(); }
	#log(line: string): void { (this.#ports.log ?? ((text: string) => void process.stderr.write(`pi-command-post: ${text}\n`)))(line); }
}

function cardText(run: ScheduleRun, result: ScheduleRunResult): string {
	const facts = `Schedule ${run.schedule_id}, run ${run.id}: ${result.outcome}${result.job_id ? `, result job ${result.job_id}` : ""}.`;
	return [result.headline, facts, ...result.links].join("\n\n");
}

/** The production wiring: the home's Answers journal, ledger and fleet. */
export function openScheduleResults(home: string, runs: ScheduleRunStore, fleet: FleetStore, ledger: () => Ledger): ScheduleResults {
	return new ScheduleResults({ runs, answers: new OperatorAnswers(join(home, LAYOUT.state)), ledgerJobs: () => ledger().read().jobs, facts: (id) => reportedFacts(home, fleet.get(id)) });
}
