/**
 * cp_schedule and the scheduler's host (Lane X, Pier 1.5). The policy is
 * src/scheduler.ts; this only ticks it while this session holds the parent
 * lock, catching up once on start. An answer/board/local fire is handed to the
 * schedule runner (src/schedule-runner.ts), which dispatches and tears it down
 * in code with no parent turn; a pr/pipeline fire wakes the parent to call cp_next.
 * Every 2 s it also consumes the Schedules page's journaled requests (src/schedule-control.ts, cp-hhuf P6).
 */
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PolicyAction } from "../../src/schedule-run-fire.ts";
import { Type } from "typebox";
import type { Delivery, JobKind } from "../../src/contracts.ts";
import { operatorTextsFromEntries, requireOperatorQuote } from "../../src/decide.ts";
import { DEFAULT_TOKEN_CEILING, loadMandateDefaults } from "../../src/mandate-defaults.ts";
import { githubRepoFromCloneUrl } from "../../src/mandate.ts";
import type { IntakeResult } from "../../src/intake.ts";
import { RUNNER_DELIVERIES, ScheduleRunner } from "../../src/schedule-runner.ts";
import { formatExpansionWake, pendingExpansions } from "../../src/schedule-expand.ts";
import { SCHEDULE_CONTROL_POLL_MS, ScheduleControl } from "../../src/schedule-control.ts";
import { formatScheduleEvent, formatSchedules, SCHEDULE_SKILLS, type ScheduleEvent, Scheduler, SCHEDULER_TICK_MS } from "../../src/scheduler.ts";
import type { ExtensionDeps } from "./shared.ts";

import { schedulePolicyView } from "../../src/viewer/schedule-policy-view.ts";
import { isNativePolicy, RUN_THINKING_LEVELS } from "../../src/viewer/schedule-policy.ts";
import { startScheduledPipeline } from "../../src/schedule-native.ts";
import { SELF_REVIEW_SKILL } from "../../src/schedule-self-review.ts";
/** The quote is written verbatim as one ledger comment (≤4000 chars) after its `run-now quote sha <12 hex>: ` prefix. */
const RUN_NOW_QUOTE_MAX = 3900;

/** Whether `word` occurs in `text` as a whole token: no letter, digit or `_` right before or after it. */
export function namesToken(text: string, word: string, flags: "" | "i"): boolean {
	const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, `u${flags}`).test(text);
}

/** A verified operator sentence naming the schedule (id case-sensitive, name not), as the policy action it authorizes. */
function quotedAction(quote: string, names: { id?: string; name: string }, ctx: ExtensionContext, toolCallId: string): PolicyAction {
	const verified = requireOperatorQuote(quote, { operatorTexts: operatorTextsFromEntries(ctx.sessionManager.getEntries()) });
	const said = verified.stored.operator_quote;
	if (!(names.id !== undefined && namesToken(said, names.id, "")) && !namesToken(said, names.name, "i")) throw new Error("the operator quote must name this schedule as a whole token");
	const quote_sha = createHash("sha256").update(verified.source).digest("hex").slice(0, 12);
	return { saved_by: verified.decidedBy as PolicyAction["saved_by"], provenance: { channel: "cp_schedule", tool_call_id: toolCallId, quote_sha, ...(verified.provenance ?? {}) } };
}

export function registerScheduleTools(
	pi: ExtensionAPI, deps: ExtensionDeps, holdsLock: () => boolean,
	shareRunner: (get: () => ScheduleRunner | undefined) => void, wakeEnvelope: (result: IntakeResult) => void,
	deferParentWake: (deliver: () => void) => void,
): void {
	let scheduler: Scheduler | undefined;
	let runner: ScheduleRunner | undefined;
	let timer: NodeJS.Timeout | undefined;
	// One startedAt per process: a reload is not a restart, so it never re-stamps "missed".
	const startedAt = new Date();
	const log = (line: string): void => void process.stderr.write(`pi-command-post: ${line}\n`);
	const build = (): Scheduler => {
		const post = deps.commandPost();
		return new Scheduler({
			home: post.home, ledger: () => post.ledger(), mandates: post.mandates, runs: post.mandates.scheduleRuns,
			usageJobs: () => post.fleet.read().jobs, cloneOf: (project) => post.registry.pathOf(project), startedAt,
			archivedProjects: () => post.registry.archivedNames(),
			// Every fire re-reads these: an unregistered project or an unreadable defaults file refuses it.
			mintContext: (project) => {
				const entry = post.registry.get(project);
				if (!entry) return { refusal: `project ${project} is not registered` };
				const defaults = loadMandateDefaults(post.home);
				return { defaults, ...(entry.mandate ? { projectOverride: entry.mandate } : {}), ceiling: defaults.token_ceiling ?? DEFAULT_TOKEN_CEILING };
			},
			// cp-pr-review: the PR urls a schedule lists must be in this repo; a non-GitHub clone_url refuses the add.
			repoOf: (project) => githubRepoFromCloneUrl(post.registry.get(project)?.clone_url ?? ""),
		});
	};
	const buildRunner = (): ScheduleRunner => {
		const post = deps.commandPost();
		return new ScheduleRunner({
			dispatch: (request) => post.dispatch(request), tearDown: (jobId) => post.tearDown(jobId), ledger: () => post.ledger(),
			recorded: (jobId) => post.intake.intake(jobId), wake: wakeEnvelope,
			runs: post.mandates.scheduleRuns,
			fleetJobs: () => post.fleet.read().jobs, schedules: () => (scheduler ??= build()).list(), now: () => new Date(), log,
		});
	};
	// The fleet owner only: a session without the lock never tears anything down.
	shareRunner(() => (holdsLock() ? (runner ??= buildRunner()) : undefined));
	// Hold only parent transport: fires, fresh grants, polling and runner dispatch happen now.
	const sendParent = (text: string, details: Record<string, unknown>): void => deferParentWake(() => {
		pi.sendMessage({ customType: "cp-schedule", content: text, display: true, details }, { deliverAs: "followUp", triggerTurn: true });
	});
	const woken = new Set<string>();
	/** One offer per anchor per process: dedupe now, even if transport is held until compaction. */
	const wakeParent = (anchorId: string, text: string, details: Record<string, unknown>): void => {
		if (woken.has(anchorId)) return;
		woken.add(anchorId);
		sendParent(text, details);
	};
	const handle = (event: ScheduleEvent, active: ScheduleRunner): void => {
		const text = formatScheduleEvent(event);
		if (event.native && event.delivery === "pipeline" && event.outcome === "fired") return startPipeline(event, text);
		// A native self-review run is the runner's in code: no expansion wake, no parent turn (a replay heals there too).
		if (event.native && event.skill === SELF_REVIEW_SKILL && event.outcome === "fired") {
			log(text);
			return void active.onFired(event);
		}
		if (event.outcome !== "fired" || event.replayed) log(text);
		else if (event.skill && event.job_id) wakeParent(event.job_id, text, { ...event });
		else if (event.delivery !== undefined && RUNNER_DELIVERIES.includes(event.delivery)) {
			log(text);
			void active.onFired(event);
		} else sendParent(text, { ...event });
	};
	/** A native pipeline starts in code (a replay heals an interrupted start); only a failure wakes the parent. */
	const startPipeline = (event: ScheduleEvent, text: string): void => {
		log(text);
		const post = deps.commandPost(), schedule = (scheduler ??= build()).list().find((entry) => entry.id === event.schedule_id);
		const pipeline = post.pipeline();
		const starter = { start: (request: Parameters<typeof pipeline.start>[0]) => pipeline.start(request), started: (id: string) => pipeline.store.get(id) !== undefined };
		void (schedule ? startScheduledPipeline(starter, post.mandates.scheduleRuns, schedule, event) : Promise.reject(new Error(`no schedule ${event.schedule_id}`)))
			.then((line) => log(`[${event.project}] schedule ${event.schedule_id}: ${line}`))
			.catch((error: Error) => sendParent(`[${event.project}] schedule ${event.name} (${event.schedule_id}) could not start its pipeline on ${event.job_id} (${event.run_id}): ${error.message}`, { ...event }));
	};
	const tick = async (): Promise<void> => {
		// 4b-2 backstop: the queue's own owns() decides; a scheduler fault never stops it.
		try { await deps.commandPost().dispatchQueue.drain(); } catch (error) { log(`dispatch queue drain failed: ${(error as Error).message}`); }
		// unload-parent PR2 backstop: a blocker closed by hand (no landing) releases its armed dependents here; release() never throws.
		try { await deps.commandPost().armedDispatches.release(); } catch (error) { log(`armed dispatch release failed: ${(error as Error).message}`); }
		// PR1: queue and post run result cards, apart from firing; the session-start catch-up tick is the startup recovery.
		try { deps.commandPost().scheduleResults.sync(); } catch (error) { log(`schedule result sync failed: ${(error as Error).message}`); }
		try {
			scheduler ??= build();
			runner ??= buildRunner();
			await runner.sweepReported();
			await runner.retryPending();
			// A deferred anchor not yet expanded (a restart before the fan-out finished) re-wakes the parent once per process.
			for (const { anchor, schedule } of pendingExpansions(deps.commandPost().ledger().read().jobs, scheduler.list(), deps.commandPost().mandates.scheduleRuns)) {
				wakeParent(anchor.id, formatExpansionWake(anchor, schedule), { schedule_id: schedule.id, job_id: anchor.id, skill: schedule.job.skill });
			}
			for (const event of await scheduler.tick()) handle(event, runner);
		} catch (error) {
			log(`scheduler tick failed: ${(error as Error).message}`);
		}
	};
	let controlTimer: NodeJS.Timeout | undefined;
	let controlling = false;
	let control: ScheduleControl | undefined;
	// cp-hhuf P6: the Schedules page's journaled requests, applied through this same scheduler and runner.
	const drain = async (): Promise<void> => {
		if (controlling) return;
		controlling = true;
		try {
			const s = (scheduler ??= build());
			const active = (runner ??= buildRunner());
			control ??= new ScheduleControl({ stateDir: dirname(s.file), scheduler: s, log });
			for (const event of await control.pass()) handle(event, active);
		} catch (error) {
			log(`schedule control failed: ${(error as Error).message}`);
		} finally {
			controlling = false;
		}
	};
	// Registered after the session hooks, so the lock is already decided when this runs.
	pi.on("session_start", async () => {
		if (!holdsLock() || timer) return;
		timer = setInterval(() => void tick(), SCHEDULER_TICK_MS);
		timer.unref();
		setTimeout(() => void tick(), 0).unref(); // catch-up pass, after startup returns
		controlTimer = setInterval(() => void drain(), SCHEDULE_CONTROL_POLL_MS);
		controlTimer.unref();
	});
	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		if (controlTimer) clearInterval(controlTimer);
		controlTimer = undefined;
	});

	const parameters = Type.Object({
		action: StringEnum(["add", "list", "enable", "disable", "remove", "run_now", "move", "update", "policy", "adopt", "deactivate"]),
		id: Type.Optional(Type.String({ description: "Schedule id" })),
		revision: Type.Optional(Type.Integer({ minimum: 0, description: "Expected policy/base revision; required for adopt; optional on a native run_now (a stale one refuses)" })),
		operator_quote: Type.Optional(Type.String({ maxLength: RUN_NOW_QUOTE_MAX, description: "native add, legacy run_now, adopt, deactivate: the operator's verbatim sentence naming the schedule (id or name)" })),
		name: Type.Optional(Type.String()),
		project: Type.Optional(Type.String()),
		mandate_id: Type.Optional(Type.String({ description: "move, and a legacy add only: the seed schedule grant. Omit on add for a native schedule authorized by its saved policy" })),
		limits: Type.Optional(Type.Object({
			usd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), tokens: Type.Optional(Type.Integer({ minimum: 1 })),
			child_jobs: Type.Optional(Type.Integer({ minimum: 1 })), parallelism: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
			run_hours: Type.Optional(Type.Integer({ minimum: 1 })),
		}, { additionalProperties: false, description: "native add: per-run caps; each omitted one comes from the project override, then data/mandate-defaults.json" })),
		overrides: Type.Optional(Type.Object({
			model: Type.Optional(Type.String({ description: "provider/model for every stage of this run" })),
			thinking: Type.Optional(StringEnum([...RUN_THINKING_LEVELS])), parallelism: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
		}, { additionalProperties: false, description: "native run_now only: this run's execution, frozen at start" })),
		cron: Type.Optional(Type.String({ description: "minute hour day-of-month month day-of-week" })),
		tz: Type.Optional(Type.String({ description: "IANA time zone for cron, e.g. Europe/Warsaw or UTC" })),
		watch_script: Type.Optional(Type.String({ description: "Tracked repository-relative script for a watch" })),
		every_seconds: Type.Optional(Type.Integer({ minimum: 30, maximum: 86400 })),
		on: Type.Optional(StringEnum(["exit0", "changed"])),
		title: Type.Optional(Type.String({ description: "Title of each fired job (the slot is appended)" })),
		kind: Type.Optional(StringEnum(["ship", "research"])),
		delivery: Type.Optional(StringEnum(["pr", "local", "pipeline", "answer", "board"])),
		description: Type.Optional(Type.String()),
		script_path: Type.Optional(Type.String({ description: "Make each fired job a script job (ship/local)" })),
		manual: Type.Optional(Type.Boolean({ description: "A manual schedule: never fires on its own, only on Run now" })),
		skill: Type.Optional(StringEnum([...SCHEDULE_SKILLS], { description: "manual only: the fire records a deferred anchor and wakes you to expand it with this skill; cp-pr-review needs 1-20 description lines `pr: https://github.com/<owner>/<repo>/pull/<n>` in the project's own repo; cp-org-pr-review needs one description line `org: <github-org>` and takes optional `user: <login>`, `team: <slug>` (0-10), `hold: <PR url in the org>` (0-50) and `max_reviewers: <1-3>` lines (skills/cp-org-pr-review/SKILL.md)" })),
	});

	pi.registerTool({
		name: "cp_schedule",
		label: "Schedule",
		description:
			"Saved schedules: `add` a cron line (5 fields + IANA tz), a watch (a tracked script run every N seconds in the project's " +
			"canonical clone, firing on exit 0 or on changed stdout) or manual (Run now only); `list`, `enable`, `disable`, `remove`; " +
			"`run_now` fires one schedule now (a native schedule takes optional revision and overrides {model, thinking, parallelism}, frozen for that run; a legacy one needs operator_quote: the operator's verbatim sentence naming the schedule, single use); `move` retargets a legacy schedule to a fresh seed grant; " +
			"`update` changes a schedule's skill, description, title, kind or delivery under add's rules (refused while a run is open). " +
			"`policy` previews saved/legacy settings; `adopt` (with revision) and `deactivate` require a single-use operator quote naming the schedule. " +
			"`add` without mandate_id saves a native policy (operator_quote naming the new schedule, optional limits): its saved revision authorizes every run, with no grant, quote or risk ask per run. " +
			"Activated schedules start durable runs with saved per-run bounds and no grant minted; legacy schedules mint a fresh grant from the saved template. " +
			"answer/board/local fires are dispatched and torn down by the schedule runner " +
			"in code (an LLM schedule as one short-lived worker with its description as the task, a script_path schedule directly, no model); " +
			"a native pipeline starts in code; pr fires (and legacy pipeline fires) wake you (cp-schedule) for cp_next/cp_dispatch. Caps, parallelism and review apply either way. " +
			"Fires in the always-on parent; a slot missed while it was down is caught up once at start, noted \"missed <time>\".",
		promptSnippet: "Manage cron/watch schedules that file jobs under a mandate (cp_schedule)",
		promptGuidelines: [
			"A cp-schedule wake-up (pr and legacy pipeline schedules) names a created job: call cp_next and act on it like any other ready job; answer/board/local scheduled jobs are the schedule runner's and a native pipeline is started by the host, never dispatch them yourself.",
			"A cp-schedule wake naming a parent-expanded run is yours: follow the skill it names (cp-self-review, cp-pr-review, cp-org-pr-review) — create its jobs with label schedule:<id>, comment `expanded: …` on the anchor, dispatch them as the skill says; never dispatch the deferred anchor; close it once the synthesis job is torn down. A native cp-self-review run sends no such wake: the schedule runner creates, dispatches and tears down its seven jobs in code, so never create, dispatch or tear them down yourself.",
			"A native schedule (add without mandate_id, on the operator's sentence naming it) is authorized by its saved policy: its runs need no grant, quote or risk:high ask, and a merge, an undeclared kind or a ship under a report-only policy is refused in code — never ask about them.",
			"A legacy schedule needs its own active schedule grant (cp_mandate issue with schedule_grant:true, no job_ids, named by no other schedule) as its seed: add saves its bounds as the schedule's template, and every fire mints a fresh grant from that template, so an expired or spent fire grant never stops the next fire and its budget is never yours to raise or ask about.",
			"A legacy run_now needs the operator's verbatim sentence naming the schedule (its id or name) as operator_quote; never on your own initiative, and never by replaying an earlier sentence. A native run_now needs no quote, but still only when the operator asks for it.",
			"An operator revoke or pause of a schedule's current fire grant stops the schedule until it is moved (`move` with id and mandate_id: a fresh schedule grant) or the grant is resumed.",
		],
		parameters,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			deps.setLive(ctx);
			const s = (scheduler ??= build());
			const need = (key: keyof typeof params): string => {
				const value = params[key];
				if (value === undefined || value === "") throw new Error(`cp_schedule ${params.action} needs ${key}`);
				return String(value);
			};
			let text: string;
			if (params.action === "list") text = formatSchedules(s.list());
			else if (params.action === "add") {
				// No hidden inputs: a parameter outside the schema (a removed opt-in) is refused, never ignored.
				const unknown = Object.keys(params).filter((key) => !Object.hasOwn(parameters.properties, key));
				if (unknown.length) throw new Error(`cp_schedule add refused: unknown parameter ${unknown.join(", ")}; a schedule's bounds are its saved policy, with nothing to opt into`);
				if (params.mandate_id !== undefined && params.limits) throw new Error("cp_schedule add refused: limits are for a native add; a legacy add takes its bounds from mandate_id");
				const native = params.mandate_id === undefined ? { action: quotedAction(need("operator_quote"), { name: need("name") }, ctx, toolCallId), limits: params.limits ?? {} } : undefined;
				const added = await s.add({
					name: need("name"), project: need("project"), ...(native ? { native } : { mandate_id: need("mandate_id") }), title: need("title"),
					kind: need("kind") as JobKind, delivery: need("delivery") as Delivery,
					...(params.cron !== undefined ? { cron: params.cron } : {}), ...(params.tz ? { tz: params.tz } : {}),
					...(params.watch_script !== undefined ? { watch_script: params.watch_script } : {}),
					...(params.every_seconds ? { every_seconds: params.every_seconds } : {}), ...(params.on ? { on: params.on as "exit0" | "changed" } : {}),
					...(params.description ? { description: params.description } : {}), ...(params.script_path !== undefined ? { script_path: params.script_path } : {}),
					...(params.manual ? { manual: true as const } : {}), ...(params.skill ? { skill: params.skill } : {}),
				});
				const notes = native ? `\nnative policy revision 1 saved and active: it authorizes every run, nothing to ask per run` : added.notes?.length ? `\nfire grant template: ${added.notes.join("; ")}` : "";
				text = `added ${formatSchedules([added])}${notes}${holdsLock() ? "" : "\n(this session does not hold the parent lock: it will not fire here)"}`;
			} else if (params.action === "update") {
				const updated = await s.update(need("id"), {
					...(params.skill !== undefined ? { skill: params.skill } : {}), ...(params.description !== undefined ? { description: params.description } : {}),
					...(params.title !== undefined ? { title: params.title } : {}), ...(params.kind !== undefined ? { kind: params.kind as JobKind } : {}),
					...(params.delivery !== undefined ? { delivery: params.delivery as Delivery } : {}),
				});
				text = `updated ${formatSchedules([updated.schedule])}${updated.notes.length ? `\nfire grant template: ${updated.notes.join("; ")}` : ""}`;
			} else if (params.action === "move") {
				const moved = await s.move(need("id"), need("mandate_id"));
				text = `moved ${formatSchedules([moved.schedule])}${moved.note}${moved.notes.length ? `\nfire grant template: ${moved.notes.join("; ")}` : ""}`;
			} else if (params.action === "remove") {
				const removed = await s.remove(need("id"));
				text = `removed ${removed.schedule.id}${removed.note}`;
			}
			else if (params.action === "run_now") {
				// The fleet owner only; a legacy schedule also needs one verbatim operator sentence naming it (single use).
				if (!holdsLock()) throw new Error("cp_schedule run_now refused: this session does not hold the parent lock; only the parent that owns the fleet fires a schedule");
				const id = need("id");
				const schedule = s.list().find((entry) => entry.id === id);
				if (!schedule) throw new Error(`cp_schedule run_now refused: no schedule ${id}`);
				const runs = deps.commandPost().mandates.scheduleRuns;
				const policy = runs.active ? runs.activePolicy(id) : undefined;
				let event: ScheduleEvent, deprecated = "";
				if (policy && isNativePolicy(policy)) {
					if (params.operator_quote !== undefined) deprecated = "\nnote: operator_quote is ignored on a native schedule; its saved policy authorizes the run";
					event = await s.fireNow(id, {
						via: "cp_schedule", tool_call_id: toolCallId,
						...(params.revision !== undefined ? { revision: params.revision } : {}), ...(params.overrides ? { overrides: params.overrides } : {}),
					});
				} else {
					if (params.overrides) throw new Error("cp_schedule run_now refused: overrides need a native schedule policy");
					const quote = need("operator_quote");
					if (quote.length > RUN_NOW_QUOTE_MAX) throw new Error(`cp_schedule run_now refused: operator_quote is over ${RUN_NOW_QUOTE_MAX} characters`);
					const verified = requireOperatorQuote(quote, { operatorTexts: operatorTextsFromEntries(ctx.sessionManager.getEntries()) });
					const said = verified.stored.operator_quote;
					// Whole tokens only (word boundaries; the id case-sensitive): "nightly" inside "nightlyish" names nothing.
					if (!namesToken(said, schedule.id, "") && !namesToken(said, schedule.name, "i")) {
						throw new Error(`cp_schedule run_now refused: the quote names neither ${schedule.id} nor "${schedule.name}"; a run now needs the operator's sentence naming the schedule`);
					}
					event = await s.fireNow(id, {
						via: "cp_schedule", tool_call_id: toolCallId, operator_quote: verified.stored.operator_quote, decided_by: verified.decidedBy,
						...(params.revision !== undefined ? {revision:params.revision} : {}),
						source_sha: createHash("sha256").update(verified.source).digest("hex").slice(0, 12), ...(verified.provenance ?? {}),
					});
				}
				handle(event, (runner ??= buildRunner()));
				text = formatScheduleEvent(event) + deprecated;
			}
			else if (params.action === "policy") text = JSON.stringify(schedulePolicyView(dirname(s.file),need("id")),null,2);
			else if (params.action === "adopt" || params.action === "deactivate") {
				if (!holdsLock()) throw new Error("only the parent holding the fleet lock may change schedule authority");
				const id = need("id"), schedule = s.list().find(entry=>entry.id === id);
				if (!schedule) throw new Error(`no schedule ${id}`);
				const action = quotedAction(need("operator_quote"), { id, name: schedule.name }, ctx, toolCallId);
				if (params.action === "adopt" && params.revision === undefined) throw new Error("adopt needs revision: read cp_schedule policy first");
				const record = params.action === "adopt" ? await s.activatePolicy(id,action,params.revision!) : await s.deactivatePolicy(id,action);
				text = params.action === "adopt" ? `Settings saved · revision ${record.active_revision} (applies to the next run)` : "Back on per-fire grants";
			}
			else text = formatSchedules([await s.setEnabled(need("id"), params.action === "enable")]);
			return { content: [{ type: "text", text }], details: {} };
		},
	});
}
