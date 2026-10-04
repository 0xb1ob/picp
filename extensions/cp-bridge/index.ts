/**
 * cp-bridge — MAIN session extension.
 *
 * Loaded only in the operator's outer pi session (`bin/cp-operator`). It does
 * not register fleet tools. The CP parent is a headless RPC child.
 *
 * Mid-turn wakes into this operator session use `deliverAs: "followUp"`: a
 * busy coordinator queues them, never drops them, never steers into the
 * current tool batch. (Sends into the CP parent steer instead; see
 * `src/parent-delivery.ts`.)
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { attachParentHost, currentHost, parentHostPaths, ParentHostClient } from "../../src/parent-host.ts";
import { reattachLoop } from "../../src/bridge-reattach.ts";
import { CpBridgeError, formatBridgeRelay, requireAvailableParentModel, resolveParentModel } from "../../src/cp-bridge.ts";
import { currentEscalationRelay } from "../../src/escalation-relay.ts";
import { OperatorRelayQueue } from "../../src/operator-relays.ts";
import { EscalationStore } from "../../src/escalation.ts";
import { ESCALATION_BACKSTOP_TICK_MS, EscalationRelayLedger, escalationRelayLedgerFile, noteBridgeRelay, runEscalationBackstop } from "../../src/escalation-backstop.ts";
import { type Mode, MODES, THINKING_LEVELS, configureLayout, layoutForHome } from "../../src/contracts.ts";
import { OperatorAsks, OperatorAskInputSchema } from "../../src/operator-asks.ts";
import { IntegrationHolds } from "../../src/integration-hold.ts";
import { PACKAGE_ROOT } from "../../src/home.ts";
import { resolveRuntime, SINGLE_MODE_REMOVED } from "../../src/mode.ts";
import { readParentLock } from "../../src/parent-lock.ts";
import { FleetStore, isPidAlive } from "../../src/fleet.ts";
import { DRAIN_DEFAULT_TIMEOUT_S, DRAIN_MAX_TIMEOUT_S, restartNotice } from "../../src/drain.ts";
import { ParentSendDelegationSchema, sendIdOfMessage } from "../../src/parent-outbox.ts";
import { recordOperatorSession } from "../../src/operator-session-log.ts";
import { type DashboardControl, startDashboardControl } from "../../src/dashboard-control.ts";

import { atomicWriteJson } from "../../src/json-store.ts";
import { registerOperatorCompact } from "../../src/operator-compact.ts";
import { OPERATOR_NOTE } from "../../src/operator-note.ts";
import { operatorStartContext } from "../../src/operator-context.ts";
import { ALWAYS_AVAILABLE, registryProbe } from "../../src/routing.ts";

export const BRIDGE_TOOL = "cp_parent";

export interface OperatorTarget { home: string; mode: Mode; hostPid: number; parentPid: number }

function targetRoot(env: NodeJS.ProcessEnv): string {
	return resolve(env.PI_HOME || `${homedir()}/.pi`, "command-post", "operator-targets");
}

export function operatorTargetFile(home: string, env: NodeJS.ProcessEnv = process.env): string {
	const key = createHash("sha256").update(resolve(home)).digest("hex");
	return resolve(targetRoot(env), `${key}.json`);
}

function selectorFile(env: NodeJS.ProcessEnv): string {
	return resolve(targetRoot(env), "selected.json");
}

export function saveOperatorTarget(target: OperatorTarget, env: NodeJS.ProcessEnv = process.env): void {
	atomicWriteJson(operatorTargetFile(target.home, env), target);
	atomicWriteJson(selectorFile(env), { home: resolve(target.home), mode: target.mode });
}

export function readOperatorTarget(home?: string, env: NodeJS.ProcessEnv = process.env): OperatorTarget | undefined {
	const explicit = home !== undefined;
	let selected: { home?: string } | undefined = home ? { home } : undefined;
	if (!selected && existsSync(selectorFile(env))) {
		try { selected = JSON.parse(readFileSync(selectorFile(env), "utf8")) as { home: string }; }
		catch (error) { throw new CpBridgeError(`operator target selector unreadable: ${selectorFile(env)}: ${(error as Error).message}`); }
	}
	if (!selected?.home) return undefined;
	const file = operatorTargetFile(selected.home, env);
	if (!existsSync(file)) {
		if (explicit) return undefined;
		throw new CpBridgeError(`operator target for ${selected.home} is missing: ${file}`);
	}
	let value: Partial<OperatorTarget>;
	try {
		value = JSON.parse(readFileSync(file, "utf8")) as Partial<OperatorTarget>;
	} catch (error) {
		throw new CpBridgeError(`operator target unreadable: ${file}: ${(error as Error).message}`);
	}
	if ((value?.mode as unknown) === "single") {
		throw new CpBridgeError(
			`operator target ${file} is for single-project home ${value.home} — ${SINGLE_MODE_REMOVED}: stop that parent (host pid ${value.hostPid}, parent pid ${value.parentPid}) with the previous release, then delete ${file}`,
		);
	}
	if (value?.home !== resolve(selected.home) || !MODES.includes(value.mode as Mode) || !Number.isInteger(value.hostPid) || !Number.isInteger(value.parentPid)) {
		throw new CpBridgeError(`operator target unreadable: ${file}: invalid home, mode or pid`);
	}
	return value as OperatorTarget;
}

/**
 * Forget a saved target whose pids died. The one thing never forgotten is a
 * parent still alive and holding the lock under this target: that parent
 * (orphaned by a dead host) is tracked by this file. A live lock held by a
 * different pid is a new parent this stale file never pointed at; retiring
 * the file is safe, and attachParentHost still refuses any second parent.
 */
export function retireStaleOperatorTarget(target: OperatorTarget, env: NodeJS.ProcessEnv = process.env): void {
	configureLayout(target.mode, target.home);
	const lock = readParentLock(target.home);
	if (lock.state === "unreadable") throw new CpBridgeError(`cannot retire operator target: parent lock unreadable: ${lock.reason}`);
	if (lock.state === "held" && lock.record.pid === target.parentPid && isPidAlive(lock.record.pid)) {
		throw new CpBridgeError(`cannot retire operator target for ${target.home}: its parent pid ${lock.record.pid} is alive and holds the parent lock`);
	}
	clearOperatorTarget(target, env);
}

export function validateOperatorTarget(target: OperatorTarget): void {
	configureLayout(target.mode, target.home);
	if (!isPidAlive(target.hostPid)) throw new CpBridgeError(`operator target host pid ${target.hostPid} is dead for ${target.home}`);
	if (!isPidAlive(target.parentPid)) throw new CpBridgeError(`operator target parent pid ${target.parentPid} is dead for ${target.home}`);
	const lock = readParentLock(target.home);
	if (lock.state !== "held" || lock.record.pid !== target.parentPid) throw new CpBridgeError(`operator target pid ${target.parentPid} does not own ${target.home}'s parent lock`);
}

export function clearOperatorTarget(target: OperatorTarget, env: NodeJS.ProcessEnv = process.env): void {
	rmSync(operatorTargetFile(target.home, env), { force: true });
	try {
		const selected = JSON.parse(readFileSync(selectorFile(env), "utf8")) as { home?: string };
		if (selected.home === resolve(target.home)) rmSync(selectorFile(env), { force: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export function resolveOperatorTarget(home?: string, mode?: Mode, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): OperatorTarget {
	if (home && mode) {
		const saved = readOperatorTarget(home, env);
		if (saved && saved.mode !== mode) throw new CpBridgeError(`operator target for ${home} is ${saved.mode}, not requested ${mode}`);
		return saved ?? { home: resolve(home), mode, hostPid: 0, parentPid: 0 };
	}
	const saved = readOperatorTarget(undefined, env);
	if (saved) return saved;
	return { ...resolveRuntime({ cwd, env, packageRoot: PACKAGE_ROOT }), hostPid: 0, parentPid: 0 };
}

export function assertOperatorTarget(target: OperatorTarget, requested: OperatorTarget): void {
	if (resolve(target.home) !== resolve(requested.home) || target.mode !== requested.mode) {
		throw new CpBridgeError(`operator client is attached to ${target.mode} home ${target.home}; disconnect before starting ${requested.mode} home ${requested.home}`);
	}
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

/**
 * The operator session's own pi file, recorded for the viewer on `cp_parent
 * start` and `cp_parent send` (cp-sessions-operator-transcript-9giu). This runs
 * in the operator session, the only place that knows its `PI_SESSION_FILE`; a
 * relaunch is a new file, and the older ones stay listed. Never fails a call.
 */
function noteOperatorSession(target: OperatorTarget | undefined): void {
	if (!target) return;
	recordOperatorSession(join(target.home, layoutForHome(target.mode, target.home).sessions), process.env.PI_SESSION_FILE);
}

/** The `cp-bridge` send ids in `messages`, as the minimal messages the host's `observe` reads. */
export function observedSendStubs(messages: unknown): Array<{ customType: "cp-bridge"; details: { send_id: string } }> {
	if (!Array.isArray(messages)) return [];
	return messages.flatMap((message) => {
		const id = sendIdOfMessage(message);
		return id ? [{ customType: "cp-bridge" as const, details: { send_id: id } }] : [];
	});
}

export default function (pi: ExtensionAPI): void {
	let client: ParentHostClient | undefined;
	let connectedTarget: OperatorTarget | undefined;
	const compaction = registerOperatorCompact(pi, () => connectedTarget ?? resolveOperatorTarget());
	const operatorAsks = () => {
		const target = connectedTarget ?? resolveOperatorTarget();
		return new OperatorAsks(resolve(target.home, layoutForHome(target.mode, target.home).state, "operator/asks.jsonl"));
	};
	const seenRelays = new Set<string>();
	// Read before a stop or rotate kills the parent's workers: drained, or how many die.
	const killNotice = (): string => {
		try {
			const target = connectedTarget ?? resolveOperatorTarget();
			configureLayout(target.mode, target.home);
			return restartNotice(target.home, () => new FleetStore({ home: target.home }).list());
		} catch (error) {
			return `warning: drain state and live workers unknown (${(error as Error).message})`;
		}
	};
	const ensureClient = async (home?: string, mode?: Mode, readOnly = false): Promise<ParentHostClient> => {
		if (client && home && mode && connectedTarget) assertOperatorTarget(connectedTarget, { home, mode, hostPid: 0, parentPid: 0 });
		if (!client) {
			const runtime = resolveOperatorTarget(home, mode);
			let hasLiveTarget = runtime.hostPid !== 0;
			if (hasLiveTarget) {
				if (!isPidAlive(runtime.hostPid) || !isPidAlive(runtime.parentPid)) {
					if (readOnly) throw new CpBridgeError(`parent unavailable for ${runtime.home}; call cp_parent start`);
					retireStaleOperatorTarget(runtime);
					hasLiveTarget = false;
				} else validateOperatorTarget(runtime);
			}
			connectedTarget = runtime;
			const record = readOnly ? currentHost(parentHostPaths(runtime.home, runtime.mode)).record : undefined;
			if (readOnly && !record) throw new CpBridgeError("parent is not running; call cp_parent start");
			const attached = record ? await ParentHostClient.connect(record)
				: await attachParentHost({ home: runtime.home, mode: runtime.mode });
			if (client) { attached.disconnect(); return client; } // the reattach loop (or a racing call) attached first
			track(attached);
			if (hasLiveTarget && (attached.hostPid !== runtime.hostPid || attached.parentPid !== runtime.parentPid)) throw new CpBridgeError(`operator target pid mismatch for ${runtime.home}`);
			await attached.onRelay(onRelay);
			afterAttach(attached);
			return attached;
		}
		return client;
	};
	const observe = (messages: unknown) => {
		// Only send-id stubs cross the socket: a whole session context can exceed the host's frame cap.
		const stubs = observedSendStubs(messages);
		if (client && stubs.length) void client.request("observe", stubs).catch(() => undefined);
	};
	// The home the escalation backstop and its ledger read: the connected target, else the runtime's own.
	const backstopTarget = (): { home: string; mode: Mode } => {
		let target: { home: string; mode: Mode };
		try { target = connectedTarget ?? resolveOperatorTarget(); }
		catch { target = resolveRuntime({ cwd: process.cwd(), env: process.env, packageRoot: PACKAGE_ROOT }); }
		configureLayout(target.mode, target.home);
		return target;
	};
	// Coordinator busy: followUp waits out the current turn, then triggers. A turn started while
	// compaction runs would race the summarizer, so wakes wait for it to end.
	const relays = new OperatorRelayQueue((relay) => compaction.whenIdle(() => pi.sendMessage(
		{ customType: "cp-bridge", content: formatBridgeRelay(relay), display: true, details: relay.sendId ? { send_id: relay.sendId } : {} },
		{ deliverAs: "followUp", triggerTurn: true },
	)), (relay) => {
		if (!connectedTarget) return relay;
		configureLayout(connectedTarget.mode, connectedTarget.home);
		return currentEscalationRelay(connectedTarget.home, relay);
	});
	const onRelay = (relay: Parameters<typeof formatBridgeRelay>[0]) => {
		const identity = relay.sendId ? `send:${relay.sendId}` : relay.escalationId ? `escalation:${relay.escalationId}` : undefined;
		if (identity && seenRelays.has(identity)) return;
		if (identity) seenRelays.add(identity);
		// Recorded so the escalation backstop never relays this id again; a failed write still delivers.
		if (relay.kind === "escalation" && relay.escalationId) {
			try {
				const target = backstopTarget();
				noteBridgeRelay(target.home, target.mode, relay);
			} catch (error) {
				setStatusLine(sessionCtx, "escalation-backstop", `escalation backstop: ledger write failed (${(error as Error).message})`);
			}
		}
		relays.push(relay);
	};

	let control: DashboardControl | undefined;
	let sessionCtx: ExtensionContext | undefined;
	// Status lines, not toasts: they stay visible and never displace a command's own notice.
	const setStatusLine = (ctx: ExtensionContext | undefined, key: string, line: string) => { if (ctx?.hasUI) ctx.ui.setStatus(key, line); else process.stderr.write(`${line}\n`); };
	const sayParent = (line: string) => setStatusLine(sessionCtx, "cp-parent", line);
	const attachedLine = (hostPid: number, parentPid: number | undefined) => `cp-parent: attached (host pid ${hostPid}${parentPid ? `, parent pid ${parentPid}` : ", no parent yet"})`;

	// mz0: relays raised during the operator's own turn wait for it to settle, then recheck.
	pi.on("agent_start", async (_event, ctx) => { sessionCtx = ctx ?? sessionCtx; relays.started(); });
	pi.on("agent_settled", async (_event, ctx) => { sessionCtx = ctx ?? sessionCtx; relays.settled(); });

	pi.on("message_start", async (event) => {
		const message = (event as { message?: unknown }).message;
		observe([message]);
		control?.observe(message);
	});
	pi.on("context", async (event) => {
		const messages = (event as { messages?: unknown }).messages;
		observe(messages);
		if (control && Array.isArray(messages)) for (const message of messages) control.observe(message);
	});
	// cp-daemon P2: attach read-only at session start (never spawning a host) so the host's relay backlog
	// arrives now. cp-bridge-auto-reattach: a connection the host closed re-attaches read-only (never starting a
	// host or parent; 1 s backoff, 30 s cap) while the session lives, then replays the escalations raised in the gap.
	let lost = false;
	const reattach = reattachLoop(() => reattachOnce());
	let shuttingDown = false;
	// cp-gb8d: an escalation open 10 min with no open ask that never reached this session is relayed once.
	let backstopTimer: NodeJS.Timeout | undefined;
	let backstopRunning = false;
	const backstopTick = (afterSeconds?: number): void => {
		if (backstopRunning || shuttingDown) return;
		backstopRunning = true;
		try {
			const target = backstopTarget();
			runEscalationBackstop({
				home: target.home,
				open: () => new EscalationStore({ home: target.home }).open(),
				asks: () => operatorAsks().list(),
				ledger: new EscalationRelayLedger(escalationRelayLedgerFile(target.home, target.mode)),
				relay: (relay) => { seenRelays.add(`escalation:${relay.escalationId}`); relays.push(relay, true); },
				...(afterSeconds !== undefined ? { afterSeconds } : {}),
			});
		} catch (error) {
			setStatusLine(sessionCtx, "escalation-backstop", `escalation backstop: paused (${(error as Error).message})`);
		} finally {
			backstopRunning = false;
		}
	};
	/** `attached` is now the client: drop it when the host closes it, and re-attach unless that was deliberate. */
	const track = (attached: ParentHostClient): void => {
		client = attached;
		void attached.closed.then(() => {
			const unexpected = client === attached;
			if (unexpected) client = undefined;
			if (client || shuttingDown) return;
			if (!unexpected) return sayParent("cp-parent: not attached (host connection closed)");
			lost = true;
			sayParent("cp-parent: host connection closed; re-attaching read-only");
			reattach.schedule();
		});
	};
	// After a loss: say it once, then relay every open escalation the ledger never saw (the live relay and this replay share seenRelays and the ledger).
	const afterAttach = (attached: ParentHostClient): void => {
		if (!lost) return sayParent(attachedLine(attached.hostPid, attached.parentPid));
		lost = false;
		sayParent(`cp-parent: reattached (pid ${attached.hostPid})`);
		backstopTick(0);
	};
	const reattachOnce = async (): Promise<void> => {
		if (client || shuttingDown) return;
		const target = backstopTarget();
		const { record } = currentHost(parentHostPaths(target.home, target.mode));
		if (!record) throw new CpBridgeError("parent host is not running");
		const attached = await ParentHostClient.connect(record);
		try { await attached.onRelay(onRelay); }
		catch (error) { attached.disconnect(); throw error; }
		if (client || shuttingDown) return attached.disconnect();
		track(attached);
		afterAttach(attached);
	};
	const attachReadOnly = async (): Promise<void> => {
		if (shuttingDown) return;
		try {
			await ensureClient(undefined, undefined, true);
		} catch (error) {
			sayParent(`cp-parent: not attached (${(error as Error).message})`);
		}
	};
	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		reattach.cancel();
		clearInterval(backstopTimer);
		backstopTimer = undefined;
		control?.stop();
		control = undefined;
		client?.disconnect();
	});

	// Dashboard control needs only a home: a saved target that is missing, unreadable or stale must not stop it,
	// so a failed saved-target read falls back to the runtime's own home (CP_HOME/CP_MODE). Only when no home
	// resolves at all does control wait for the next successful `cp_parent start`.
	let controlAwaitsHome = false;
	const startControl = async (ctx: ExtensionContext | undefined): Promise<void> => {
		const say = (line: string) => setStatusLine(ctx, "dashboard-control", line);
		let target: { home: string; mode: Mode };
		try {
			try { target = connectedTarget ?? resolveOperatorTarget(); }
			catch { target = resolveRuntime({ cwd: process.cwd(), env: process.env, packageRoot: PACKAGE_ROOT }); }
			controlAwaitsHome = false;
		} catch (error) {
			controlAwaitsHome = true;
			return say(`dashboard control: waiting for cp_parent start (${(error as Error).message})`);
		}
		try {
			configureLayout(target.mode, target.home);
			const layout = layoutForHome(target.mode, target.home);
			const started = await startDashboardControl({
				stateDir: join(resolve(target.home), layout.state),
				ports: {
					inject: (text, deliverAs) => new Promise<void>((done, fail) => compaction.whenIdle(() => {
						try { Promise.resolve(pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined) as unknown).then(() => done(), fail); }
						catch (error) { fail(error); }
					})),
					abort: () => sessionCtx?.abort(),
					isIdle: () => sessionCtx?.isIdle() ?? true,
					hasPendingMessages: () => sessionCtx?.hasPendingMessages() ?? false,
					sessionFile: () => sessionCtx?.sessionManager?.getSessionFile() ?? process.env.PI_SESSION_FILE,
				},
			});
			if (started.state === "listening") {
				control = started;
				// A fresh session, and what the dashboard sends into it, shows in the Full transcript before any cp_parent call.
				recordOperatorSession(join(target.home, layout.sessions), ctx?.sessionManager?.getSessionFile() ?? process.env.PI_SESSION_FILE);
				say(`dashboard control: on (${started.socket})`);
			} else if (started.state === "refused") say(`dashboard control: refused (${started.reason})`);
		} catch (error) {
			say(`dashboard control: not started (${(error as Error).message})`);
		}
	};

	// cp-dashboard-operator-control: the dashboard's Full transcript steers this session over an owner-only
	// socket; every message arrives as a user message, exactly what the human could type here.
	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		control?.stop();
		control = undefined;
		await startControl(ctx);
		// A fresh session (no messages) gets the standing orders, learnings and newest handoff once; a resumed one already has them.
		try {
			if (!ctx.sessionManager.getEntries().some((entry) => entry.type === "message")) {
				let target: { home: string; mode: Mode };
				try { target = connectedTarget ?? resolveOperatorTarget(); }
				catch { target = resolveRuntime({ cwd: process.cwd(), env: process.env, packageRoot: PACKAGE_ROOT }); }
				const content = operatorStartContext(target.home, target.mode);
				if (content) pi.sendMessage({ customType: "cp-operator-context", content, display: false }, { triggerTurn: false });
			}
		} catch (error) {
			setStatusLine(ctx, "operator-context", `operator context: not loaded (${(error as Error).message})`);
		}
		shuttingDown = false;
		await attachReadOnly();
		clearInterval(backstopTimer);
		backstopTick();
		backstopTimer = setInterval(backstopTick, ESCALATION_BACKSTOP_TICK_MS);
		backstopTimer.unref();
		if (process.env.CP_OPERATOR_WEB_STATUS) setStatusLine(ctx, "operator-web", process.env.CP_OPERATOR_WEB_STATUS);
	});

	// autonomy-programme-cur.5.3: a bounded, static note so the main LLM knows
	// how to operate the parent without a human explaining it. Appended once
	// per turn at a fixed position — nothing here varies by state, which is
	// what keeps the prefix cacheable.
	pi.on("before_agent_start", async (event) => {
		return { systemPrompt: `${event.systemPrompt}\n\n${OPERATOR_NOTE}` };
	});

	pi.registerCommand("cp-bridge", {
		description: "List cp_* tools in this main session (must not include fleet tools)",
		handler: async (_args, ctx) => {
			const names = pi
				.getAllTools()
				.map((tool) => tool.name)
				.filter((name) => name.startsWith("cp_"))
				.sort();
			const line = `cp-bridge tools: ${names.join(",") || "(none)"}`;
			if (ctx.hasUI) ctx.ui.notify(line, "info");
			else process.stderr.write(`${line}\n`);
		},
	});

	pi.registerTool({
		name: BRIDGE_TOOL,
		label: "CP parent",
		description:
			"Own the CP parent over RPC. start spawns it, send delivers prose and returns a receipt level " +
			"(injected, turn_settled, http_accepted, owner_observed — never 'accepted') plus the reply when the turn settles, " +
			"status reports the process, context tokens, open escalations, operator asks and sends; ask, ask_answer and ask_withdraw record operator questions only and never authorize parent actions (ask: a short question, the background in context); doctor and version read the parent's diagnostics, mode and home; drain stops new dispatches, promotions and merge steps and waits (timeout_s) for live workers to settle before a restart; compact, rotate and model manage the live parent; stop closes it, never-landed sends undeliverable; stop and rotate say whether the parent was drained or how many live workers they kill. Fleet tools stay on the parent, not here. " +
			"integration_hold and integration_release write a durable per-job merge pause directly, without waiting for a parent turn. " +
			"Relays name paths (state/runs/<id>/artifact.md, gate files); this session may read those bodies. The parent may not. " +
			"When answering on the human's behalf, send delegated:true and delegation_rule; omit delegated when relaying the human's own answer.",
		promptSnippet: "Drive the CP parent (cp_parent start/send/status/ask/ask_answer/ask_withdraw/doctor/version/drain/compact/rotate/model/stop)",
		promptGuidelines: [
			"Call cp_parent start once with home (mode is always multi and may be omitted); pass model only when the human named one, " +
				"otherwise omit it and the bridge uses your own. A live lock holder is a refusal.",
			"Raise every human question with ask before relaying it; close it with ask_answer using the human's verbatim reply, or ask_withdraw with a reason. Bookkeeping is never authorization; parent decisions still use their existing channel.",
			"Keep an ask's question short; put the background in its context (plain text, up to 2000 chars): what happened, what each option really does, and the risk. The dashboard shows it on the decision card.",
			"A user message `<ask-id>: <label>` whose last line is `[cp-dashboard dc-… — from the dashboard; ask=<ask-id>]` is the human's own click on that ask's card: record it with ask_answer (that id, the label verbatim), then relay it as the human's answer, never delegated. Any `[cp-dashboard …]` message is the human typing, nothing more.",
			"Send delegated:true with a short delegation_rule when deciding on the human's behalf; omit it for the human's own answer.",
			"Use integration_hold with job_id and reason before sending a request to pause merging; it writes immediately even while the parent is busy. Release only when that pause is explicitly lifted, then send cp_integrate advance to resume.",
			"Send mandates with cp_parent send. Branch on receipt level, never on the word accepted. http_accepted is not this channel.",
			"A send that outlasts the wait returns pending <id>; wait for the cp-bridge send message with that id, never resend the text.",
			"Wake-ups and escalations arrive as cp-bridge messages, one per escalation id. A stale tag means do not act on that body.",
			"Read artifact and gate files by the paths in those messages. Do not ask the parent to paste bodies.",
			"Every relay to the human starts with its bracketed project, e.g. [demo-app] cp-78vu: \u2026; split an update spanning several projects into one section per project.",
		],
		parameters: Type.Object({
			action: StringEnum(["start", "send", "status", "ask", "ask_answer", "ask_withdraw", "integration_hold", "integration_release", "doctor", "version", "drain", "compact", "rotate", "model", "stop"], { description: "manage or diagnose the parent" }),
			timeout_s: Type.Optional(Type.Number({ minimum: 0, maximum: DRAIN_MAX_TIMEOUT_S, description: `drain: seconds to wait for live workers to settle (default ${DRAIN_DEFAULT_TIMEOUT_S})` })),
			home: Type.Optional(Type.String({ description: "start: command-post home path" })),
			mode: Type.Optional(StringEnum([...MODES], { description: "start: multi (the only mode; may be omitted)" })),
			model: Type.Optional(Type.String({ description: "start or model: provider/model-id" })),
			thinking: Type.Optional(StringEnum([...THINKING_LEVELS], { description: "start: optional thinking level" })),
			ask: Type.Optional(OperatorAskInputSchema),
			id: Type.Optional(Type.String({ description: "ask_answer or ask_withdraw: ask id" })),
			answer: Type.Optional(Type.String({ description: "ask_answer: human's verbatim words" })),
			job_id: Type.Optional(Type.String({ description: "integration_hold or integration_release: delivery:pr ship job" })),
			reason: Type.Optional(Type.String({ description: "ask_withdraw or integration_hold: reason" })),
			...ParentSendDelegationSchema.properties,
			text: Type.Optional(Type.String({ description: "send: prose; compact: optional instructions" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				if (params.action === "integration_hold" || params.action === "integration_release") {
					if (!params.job_id) throw new CpBridgeError(`${params.action} needs job_id`);
					const target = connectedTarget ?? resolveOperatorTarget();
					configureLayout(target.mode, target.home);
					const holds = new IntegrationHolds(target.home);
					const hold = params.action === "integration_hold" ? holds.hold(params.job_id, params.reason ?? "") : (holds.release(params.job_id), null);
					return textResult(hold ? `${params.job_id}: integration held: ${hold.reason}` : `${params.job_id}: integration hold released; send the parent cp_integrate advance to resume with all gates rechecked.`, { job_id: params.job_id, hold });
				}
				if (["ask", "ask_answer", "ask_withdraw"].includes(params.action)) {
					const asks = operatorAsks();
					if (params.action === "ask") {
						if (!params.ask) throw new CpBridgeError("cp_parent ask needs ask details");
						const ask = asks.open(params.ask);
						return textResult(JSON.stringify(ask), { ...ask });
					}
					if (!params.id) throw new CpBridgeError(`${params.action} needs id`);
					if (params.action === "ask_answer") asks.answer(params.id, params.answer ?? "");
					else asks.withdraw(params.id, params.reason ?? "");
					return textResult(`${params.action}: ${params.id} recorded (bookkeeping only)`, { id: params.id });
				}
				if (params.action === "start") {
					if ((params.mode as string | undefined) === "single") throw new CpBridgeError(`cp_parent start: ${SINGLE_MODE_REMOVED}; omit mode or pass multi`);
					if (!params.home) throw new CpBridgeError("cp_parent start needs home");
					const mode: Mode = "multi";
					// cur.5.4: never let the LLM guess a model. Explicit beats resolved;
					// resolved is CP_PARENT_MODEL, then the operator's own model.
					const sessionModel = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
					const model =
						params.model?.trim() ||
						resolveParentModel(
							{
								CP_PARENT_MODEL: process.env.CP_PARENT_MODEL,
								PI_PROVIDER: process.env.PI_PROVIDER,
								PI_MODEL: process.env.PI_MODEL,
							},
							sessionModel,
						);
					requireAvailableParentModel(model, ctx?.modelRegistry ? registryProbe(ctx.modelRegistry) : ALWAYS_AVAILABLE);
					const startDeadline = Date.now() + 10_000;
					let started: { already: boolean; pid?: number; sessionFile: string };
					for (;;) {
						const activeClient = await ensureClient(params.home, mode);
						try {
							started = await activeClient.request("start", {
								home: params.home,
								mode,
								model,
								...(params.thinking ? { thinking: params.thinking } : {}),
								...(process.env.CP_PARENT_PI_BIN ? { piBin: process.env.CP_PARENT_PI_BIN } : {}),
							}) as { already: boolean; pid?: number; sessionFile: string };
							break;
						} catch (error) {
							if (!(error instanceof Error) || error.message !== "parent host is stopping") throw error;
							if (Date.now() >= startDeadline) {
								const lock = readParentLock(params.home);
								const pid = lock.state === "held" ? lock.record.pid : activeClient.parentPid;
								throw new CpBridgeError(`parent host pid ${activeClient.hostPid} is still stopping after the start deadline; parent lock ${lock.path} (pid ${pid ?? "unknown"}); refusing to start a second host`);
							}
							activeClient.disconnect();
							if (client === activeClient) client = undefined;
							connectedTarget = undefined;
							await new Promise((resolve) => setTimeout(resolve, 50));
						}
					}
					const target = { home: resolve(params.home), mode, hostPid: client!.hostPid, parentPid: started.pid ?? client!.parentPid ?? 0 };
					saveOperatorTarget(target);
					connectedTarget = target;
					noteOperatorSession(target);
					setStatusLine(ctx ?? sessionCtx, "cp-parent", attachedLine(target.hostPid, target.parentPid));
					if (controlAwaitsHome && !control) await startControl(ctx ?? sessionCtx);
					return textResult(
						started.already
							? `already running pid=${started.pid ?? "?"} session=${started.sessionFile}`
							: `started pid=${started.pid ?? "?"} session=${started.sessionFile}`,
						started,
					);
				}
				if (params.action === "send") {
					if (!params.text) throw new CpBridgeError("cp_parent send needs text");
					const activeClient = await ensureClient();
					// The send proves this operator session is driving the parent; record its file for the viewer.
					noteOperatorSession(connectedTarget);
					const receipt = await activeClient.request("send", params.text, undefined, {
						...(params.delegated !== undefined ? { delegated: params.delegated } : {}),
						...(params.delegation_rule !== undefined ? { delegation_rule: params.delegation_rule } : {}),
					}) as import("../../src/cp-bridge.ts").BridgeReceipt;
					const lines = [
						`receipt: ${receipt.level ?? "none"}`,
						`reached: ${receipt.reached.join(",") || "none"}`,
						receipt.send_id ? `send: ${receipt.send_id}` : "",
						receipt.pending ? `pending: ${receipt.pending} — the parent's turn is still running; its reply arrives as a [cp-bridge send send=${receipt.pending}] message. Do not resend.` : "",
						receipt.reply !== undefined ? `reply:\n${receipt.reply}` : "",
						receipt.error ? `error: ${receipt.error}` : "",
					].filter((line) => line.length > 0);
					relays.replied(receipt.reply);
					return textResult(lines.join("\n"), { ...receipt });
				}
				if (params.action === "doctor" || params.action === "version" || params.action === "drain") {
					const activeClient = await ensureClient(undefined, undefined, true);
					const result = await activeClient.request(params.action, ...(params.action === "drain" && params.timeout_s !== undefined ? [params.timeout_s] : [])) as import("../../src/parent-diagnostics.ts").ParentDiagnostic;
					return { ...textResult(result.text, { ...result }), isError: result.level === "error" };
				}
				if (params.action === "model") {
					if (!params.model) throw new CpBridgeError("cp_parent model needs provider/model-id");
					requireAvailableParentModel(params.model, ctx?.modelRegistry ? registryProbe(ctx.modelRegistry) : ALWAYS_AVAILABLE);
				}
				if (["status", "compact", "rotate", "model"].includes(params.action)) {
					const activeClient = await ensureClient();
					const notice = params.action === "rotate" ? killNotice() : undefined;
					const result = params.action === "status" ? { ...await activeClient.request("statusWithContext") as Record<string, unknown>, asks: operatorAsks().open() }
						: params.action === "compact" ? await activeClient.request("compact", params.text)
						: params.action === "rotate" ? await activeClient.request("rotate") : await activeClient.request("model", params.model!);
					return textResult(`${notice ? `${notice}\n` : ""}${JSON.stringify(result)}`, { ...result as Record<string, unknown>, ...(notice ? { notice } : {}) });
				}
				const activeClient = await ensureClient();
				const target = connectedTarget;
				const notice = killNotice();
				const exit = await activeClient.request("stop", { discardPending: true }) as { code: number | null; signal: NodeJS.Signals | null } | null;
				if (exit && target) clearOperatorTarget(target);
				activeClient.disconnect();
				client = undefined;
				connectedTarget = undefined;
				return textResult(
					exit
						? `stopped code=${exit.code ?? "null"} signal=${exit.signal ?? "null"}\n${notice}`
						: "not running",
					exit ? { code: exit.code, signal: exit.signal, notice } : { running: false },
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ...textResult(message), ...(["doctor", "version", "ask", "ask_answer", "ask_withdraw", "integration_hold", "integration_release"].includes(params.action) ? { isError: true } : {}) };
			}
		},
	});
}
