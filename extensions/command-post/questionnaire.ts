/**
 * Reaching `@juicesharp/rpiv-ask-user-question`, and asking one questionnaire
 * with it (cp-4864, fixed by cp-vvaz).
 *
 * cp-4864 wired the package in as a **shim** behind `driveAwaitingDialog`'s
 * `select`/`input` pair, and resolved it with a single bare `import()`. Both
 * halves were wrong on a real pi TUI:
 *
 *  - the bare specifier resolves against **this repo's** `node_modules`, and
 *    the package the operator actually installed lives in pi's own package
 *    root (`~/.pi/agent/npm/node_modules`, from `packages: ["npm:…"]` in
 *    settings) — a command-post checkout whose `node_modules` predates the
 *    dependency therefore fell back on **every** prompt, silently, to
 *    `ctx.ui.select`. That is the old "Awaiting you — pick one to answer (Done
 *    to stop) (Ns)" dialog with its countdown, which is exactly what the
 *    hand-check found;
 *  - and even when it did load, one overlay per prompt is a select in
 *    questionnaire clothing, not the package's own tabbed dialog.
 *
 * So this module now does two things and no more: it **finds** the package
 * wherever pi put it, and it asks **one questionnaire with up to four
 * questions** (`src/awaiting-questionnaire.ts` builds them). Nothing here
 * decides anything; nothing here writes anything.
 *
 * Three properties are load-bearing:
 *
 *  - **Every failure is a *named* reason, not silence.** `loadAskUserQuestion`
 *    resolves a load record with the specifiers it tried and why each failed,
 *    and `/cp-decide` shows it before it falls back to the plain dialogs. A
 *    silent degrade is the defect this file just had.
 *  - **The package is reached through its public `.` entry only.** No
 *    vendoring, no private subpath: the entry is read from the package's own
 *    `exports["."]` / `main`, its default export is an
 *    `(pi: ExtensionAPI) => void` factory, and we call it with a **shim** API
 *    whose `registerTool` captures the definition instead of publishing it.
 *    The parent model never sees a second `ask_user_question`, because the
 *    shim is not pi.
 *  - **Esc is a skip.** `cancelled: true` comes back as `cancelled`, which
 *    writes nothing anywhere, and is never a decline.
 */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AWAITING_DIALOG_TIMEOUT_MS } from "../../src/contracts.ts";
import type {
	AskQuestionnaireOutcome,
	QuestionnaireAnswer,
} from "../../src/awaiting-questionnaire.ts";
import {
	type AwaitingSurface,
	type CheckpointAsk,
	checkpointQuestion,
	interpretCheckpointAnswer,
	type OverlayQuestion,
	overlayFallbackNotice,
	routeAwaitingUi,
} from "../../src/awaiting-ui.ts";

/** The package's bare specifier. Held in a variable on purpose — see `importAskTool`. */
export const ASK_PACKAGE_SPECIFIER = "@juicesharp/rpiv-ask-user-question";

/** The tool name the package registers. */
export const ASK_TOOL_NAME = "ask_user_question";

/** How pi names the config dir and the agent-dir override, restated locally. */
const PI_CONFIG_DIR = ".pi";
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

// ---------------------------------------------------------------------------
// The package's surface, as little of it as we need
// ---------------------------------------------------------------------------

export interface AskToolAnswer {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "multi";
	answer: string | null;
	selected?: string[];
	notes?: string;
}

export interface AskToolQuestionnaireResult {
	answers: AskToolAnswer[];
	cancelled: boolean;
	globalNote?: string;
	error?: string;
}

export interface AskToolOption {
	label: string;
	description: string;
}

export interface AskToolParams {
	questions: { question: string; header: string; options: AskToolOption[] }[];
}

/** Just enough of pi's `ToolDefinition` to call it ourselves. */
export interface AskToolDefinition {
	name: string;
	execute(
		toolCallId: string,
		params: AskToolParams,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<{ details?: unknown } | undefined>;
}

/** What a load attempt produced: a tool, or every reason it could not. */
export interface AskToolLoad {
	tool?: AskToolDefinition;
	/** The specifier or path the tool came from. */
	source?: string;
	/** Operator-facing: what was tried, why it failed, and the fix. */
	reason?: string;
}

export type AskToolLoader = () => Promise<AskToolLoad>;

// ---------------------------------------------------------------------------
// Where pi puts an installed package
// ---------------------------------------------------------------------------

/** Mirrors pi's own `getAgentDir()`: `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
export function agentDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	const override = env[PI_AGENT_DIR_ENV];
	if (override && override.length > 0) return override;
	return join(home, PI_CONFIG_DIR, "agent");
}

/**
 * The `node_modules` roots a pi-installed package can live in, in the order
 * pi itself resolves them: the user scope (`packages` in
 * `~/.pi/agent/settings.json`, installed under `~/.pi/agent/npm`) and the
 * project scope (`.pi/npm` in the cwd). This repo's own `node_modules` is
 * covered by the bare specifier, which the module resolver handles.
 */
export function packageRoots(options: { cwd?: string; env?: NodeJS.ProcessEnv; home?: string } = {}): string[] {
	const roots = [join(agentDir(options.env ?? process.env, options.home ?? homedir()), "npm", "node_modules")];
	if (options.cwd) roots.push(join(options.cwd, PI_CONFIG_DIR, "npm", "node_modules"));
	return roots;
}

/**
 * The package's own public `.` entry, read from its `package.json` (`exports`
 * first, then `main`, then a bare directory import). Reading the manifest is
 * what keeps this from being a private-subpath import: the entry is whatever
 * the package says it is.
 */
export function publicEntryIn(root: string, specifier: string = ASK_PACKAGE_SPECIFIER): string | undefined {
	const dir = join(root, specifier);
	let manifest: { exports?: unknown; main?: string };
	try {
		manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as typeof manifest;
	} catch {
		return undefined;
	}
	const exported = manifest.exports;
	const dot =
		typeof exported === "string"
			? exported
			: exported && typeof exported === "object"
				? (() => {
						const entry = (exported as Record<string, unknown>)["."];
						if (typeof entry === "string") return entry;
						if (entry && typeof entry === "object") {
							const conditions = entry as Record<string, unknown>;
							for (const key of ["import", "default", "require"]) {
								if (typeof conditions[key] === "string") return conditions[key] as string;
							}
						}
						return undefined;
					})()
				: undefined;
	const relative = dot ?? manifest.main;
	return relative ? join(dir, relative) : dir;
}

/** Every specifier a load will try, in order, with a label for the reason line. */
export function askToolCandidates(
	options: { cwd?: string; env?: NodeJS.ProcessEnv; home?: string; specifier?: string } = {},
): { label: string; specifier: string }[] {
	const specifier = options.specifier ?? ASK_PACKAGE_SPECIFIER;
	const candidates: { label: string; specifier: string }[] = [{ label: specifier, specifier }];
	for (const root of packageRoots(options)) {
		const entry = publicEntryIn(root, specifier);
		if (entry) candidates.push({ label: entry, specifier: entry });
	}
	return candidates;
}

// ---------------------------------------------------------------------------
// Loading the package without registering it
// ---------------------------------------------------------------------------

/**
 * The shim `ExtensionAPI`. `registerTool` captures; everything the package
 * touches at registration time (`on`, `events.emit`, `getActiveTools`,
 * `setActiveTools`) is inert. Because this object is not pi, the captured
 * definition is never published to the model and the reconciler's
 * `before_agent_start` hook is never wired to anything.
 */
function captureApi(captured: AskToolDefinition[]): unknown {
	let active: string[] = [];
	return {
		registerTool: (definition: AskToolDefinition) => {
			captured.push(definition);
		},
		registerCommand: () => undefined,
		on: () => undefined,
		off: () => undefined,
		events: { emit: () => undefined, on: () => undefined, off: () => undefined },
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
	};
}

/** Import one specifier and pull the registered tool out of the factory. */
async function toolFrom(specifier: string): Promise<AskToolDefinition | undefined> {
	// A **variable** specifier, not a literal: `tsc --noEmit` then never has to
	// resolve a `.ts` file inside `node_modules` (the package ships TypeScript,
	// which only pi's jiti loader maps), and an absent package is a caught
	// rejection at the call site rather than a load-time failure.
	const mod = (await import(specifier)) as { default?: unknown };
	const factory = mod.default;
	if (typeof factory !== "function") return undefined;
	const captured: AskToolDefinition[] = [];
	(factory as (pi: unknown) => void)(captureApi(captured));
	return captured.find((tool) => tool?.name === ASK_TOOL_NAME && typeof tool.execute === "function");
}

const INSTALL_HINT =
	`install it as a pi package (settings \`packages\`: "npm:${ASK_PACKAGE_SPECIFIER}") or \`npm install\` in this checkout`;

/**
 * Try every candidate, in order, and say what happened. Resolves — never
 * rejects: a decision must never be taken down by its own renderer.
 */
export async function loadAskToolFrom(
	candidates: { label: string; specifier: string }[],
): Promise<AskToolLoad> {
	const failures: string[] = [];
	for (const candidate of candidates) {
		try {
			const tool = await toolFrom(candidate.specifier);
			if (tool) return { tool, source: candidate.label };
			failures.push(`${candidate.label}: loaded, but registers no ${ASK_TOOL_NAME}`);
		} catch (error) {
			const message = (error as Error).message.split("\n")[0] ?? String(error);
			failures.push(`${candidate.label}: ${message}`);
		}
	}
	return { reason: `${ASK_PACKAGE_SPECIFIER} could not be loaded (${failures.join("; ")}) \u2014 ${INSTALL_HINT}` };
}

let cached: Promise<AskToolLoad> | undefined;

/**
 * Memoised loader over `askToolCandidates`. The bare specifier comes first (so
 * a checkout that depends on the package keeps using its own copy), then pi's
 * own package roots — user scope, then project scope.
 */
export const loadAskUserQuestion: AskToolLoader = () => {
	cached ??= (async () => {
		const [bare, ...roots] = askToolCandidates({ cwd: process.cwd() });
		const ordered = bare ? [bare] : [];
		try {
			// Some loaders refuse a bare runtime string specifier; a resolved path is
			// still the public `.` entry, so it is offered as its own candidate.
			ordered.push({ label: ASK_PACKAGE_SPECIFIER, specifier: createRequire(import.meta.url).resolve(ASK_PACKAGE_SPECIFIER) });
		} catch {
			// Not resolvable from here; pi's own package roots may still have it.
		}
		return loadAskToolFrom([...ordered, ...roots]);
	})().catch((error: unknown) => ({ reason: `${ASK_PACKAGE_SPECIFIER} could not be loaded: ${String(error)}` }));
	return cached;
};

// ---------------------------------------------------------------------------
// Asking one questionnaire
// ---------------------------------------------------------------------------

export interface QuestionnaireDeps {
	/** Injected in tests; defaults to the memoised real loader. */
	loadTool?: AskToolLoader;
	/** Which surface is asking. Only used to route/report; defaults to `/cp-decide`. */
	surface?: AwaitingSurface;
	/**
	 * Close the overlay after this many milliseconds and report `cancelled` — a
	 * skip, so nothing is written anywhere and every item reappears. Absent (the
	 * default) means no deadline. Only the unattended `agent_settled` surface
	 * passes one (`overlayTimeoutMs`), because only that surface opens without
	 * being asked for.
	 */
	timeoutMs?: number;
	/**
	 * Where an operator-facing signal goes. Defaults to `ctx.ui.notify`. The
	 * deadline uses it to say when it could not close the overlay — a silent dead
	 * timeout is the failure mode this whole layer exists to avoid.
	 */
	notify?(text: string, level: "info" | "warning" | "error"): void;
}

/**
 * Said out loud when the deadline fires and this layer holds no way to close
 * the overlay — which means the package no longer renders the way the wrapper
 * assumes. The ask is still settled as a cancel and nothing is written; only
 * the *closing* was not possible, so a package change surfaces as a signal
 * instead of a deadline that quietly does nothing.
 */
export const OVERLAY_NO_CLOSE_HANDLE_NOTICE =
	"Awaiting you: the questionnaire deadline fired but this build could not close the overlay " +
	"(the package did not hand over a close handle through ctx.ui.custom). Nothing was written and nothing was " +
	"answered — the decisions are still open. If the overlay is still on screen, press Esc; that is also a skip.";

/** What Esc produces, and therefore what a deadline produces: a skip. */
export const OVERLAY_CANCELLED_RESULT: AskToolQuestionnaireResult = { answers: [], cancelled: true };

/**
 * Read one property off the real object, faithfully.
 *
 * A method reached through a proxy would otherwise be *called* with the proxy
 * as its receiver — which breaks a class method that touches a private field,
 * and would silently mutate a different `this` for anything that keeps state.
 * So a function is bound to its real owner (memoised, so identity is stable
 * across reads: `ui.notify === ui.notify`), and everything else is read with
 * the real target as the receiver so a getter sees the object it belongs to.
 */
const boundMembers = new WeakMap<object, Map<string | symbol, unknown>>();
function forward(target: object, prop: string | symbol): unknown {
	const value = Reflect.get(target, prop, target);
	if (typeof value !== "function") return value;
	let cache = boundMembers.get(target);
	if (!cache) {
		cache = new Map();
		boundMembers.set(target, cache);
	}
	const cached = cache.get(prop);
	if (cached) return cached;
	const bound = (value as (...args: unknown[]) => unknown).bind(target);
	cache.set(prop, bound);
	return bound;
}

/**
 * A context that can close — or refuse — the package's overlay.
 *
 * The package's `execute` ignores its abort signal and keeps the overlay handle
 * to itself, so the *only* way to close its overlay from here is the `done`
 * callback pi hands the component factory — which travels through the
 * `ExtensionContext` we give the package. So we give it a context whose
 * `ui.custom` wraps the factory and captures `done`, and which forwards every
 * other property to the real one (`Reflect.get` with the real target as the
 * receiver, so nothing is ever called with a proxy as `this`).
 *
 * `expire()` reports **which** of four things it was able to do, and the caller
 * never depends on it having been the first:
 *
 *  - `closed` — the overlay was up and `done({answers: [], cancelled: true})`
 *    closed it: byte-identical to Esc, and a cancel writes nothing anywhere;
 *  - `refused` — the deadline fired **before** the package reached `ui.custom`
 *    (a slow load, a slow `execute`). There is no `done` to call, so the wrapper
 *    refuses to render: the real `ctx.ui.custom` is never invoked and the
 *    package is handed the same cancelled result, so nothing can be left
 *    orphaned on screen after the batch was reported as a skip;
 *  - `no_handle` — the package rendered through something this wrapper does not
 *    intercept, or called `ui.custom` with a shape whose fourth argument is not
 *    a `done` callback. **This is the assumption failing**, and it is reported
 *    rather than swallowed: the ask still settles as a cancel, the latch and the
 *    handler continuation are still released, nothing is written, and the caller
 *    says so out loud. The overlay may stay up until the human dismisses it —
 *    acceptable; an ask that never settles is not;
 *  - `close_failed` — `done` threw. Same treatment as `no_handle`.
 *
 * Nothing here depends on the package's internals, and nothing here can throw
 * into the caller.
 */
export type OverlayExpiry = "closed" | "refused" | "no_handle" | "close_failed";

export function overlayDeadlineContext(ctx: ExtensionContext): {
	ctx: ExtensionContext;
	expire(): OverlayExpiry;
} {
	let done: ((result: unknown) => void) | undefined;
	let expired = false;
	/** Did the package ever reach our wrapper at all? Decides `refused` vs `no_handle`. */
	let rendered = false;
	const realUi = ctx.ui as unknown as Record<string | symbol, unknown>;
	const ui = new Proxy(realUi, {
		get(target, prop) {
			if (prop !== "custom") return forward(target, prop);
			const custom = Reflect.get(target, prop, target) as ((factory: unknown, options: unknown) => unknown) | undefined;
			if (typeof custom !== "function") return custom;
			return (factory: unknown, options: unknown) => {
				rendered = true;
				// Too late to render: the batch has already been reported as a skip.
				if (expired) return Promise.resolve(OVERLAY_CANCELLED_RESULT);
				// A shape we do not recognise (not a factory function) is passed through
				// untouched rather than mangled: we lose the close handle, `expire()`
				// says `no_handle`, and the ask still settles.
				if (typeof factory !== "function") return custom.call(target, factory, options);
				return custom.call(
					target,
					(...args: unknown[]) => {
						const finish = args[3];
						if (typeof finish === "function") {
							done = finish as (result: unknown) => void;
							// Racing the deadline itself: if it fired while the factory was on
							// its way in, close immediately rather than leave it up.
							if (expired) done(OVERLAY_CANCELLED_RESULT);
						}
						return (factory as (...a: unknown[]) => unknown)(...args);
					},
					options,
				);
			};
		},
	});
	const proxied = new Proxy(ctx as unknown as Record<string | symbol, unknown>, {
		get(target, prop) {
			if (prop === "ui") return ui;
			return forward(target, prop);
		},
	}) as unknown as ExtensionContext;
	return {
		ctx: proxied,
		expire(): OverlayExpiry {
			expired = true;
			if (!done) return rendered ? "no_handle" : "refused";
			try {
				done(OVERLAY_CANCELLED_RESULT);
				return "closed";
			} catch {
				// A renderer that cannot be closed still must not hold the caller.
				return "close_failed";
			}
		},
	};
}

function isQuestionnaireResult(value: unknown): value is AskToolQuestionnaireResult {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return Array.isArray(candidate.answers) && typeof candidate.cancelled === "boolean";
}

let callSeq = 0;

/**
 * Race one overlay against its deadline. The losing promise is *abandoned*, not
 * awaited: a package that resolves after we have already reported a skip must
 * not become an unhandled rejection, and its late answer is never read (the
 * operator was not there to give one).
 */
async function withOverlayDeadline<T>(
	promise: Promise<T>,
	ms: number,
): Promise<{ kind: "value"; value: T } | { kind: "timeout" }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<{ kind: "timeout" }>((resolve) => {
		timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
		timer.unref?.();
	});
	const wrapped = promise.then((value) => ({ kind: "value" as const, value }));
	// The race still sees a rejection; this handler only keeps an *abandoned*
	// rejection from surfacing as an unhandled one after we have moved on.
	wrapped.catch(() => undefined);
	try {
		return await Promise.race([wrapped, deadline]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Ask one questionnaire — every question in a single overlay, which is what
 * makes it the package's tabbed dialog rather than a stack of selects — and
 * classify what came back per question.
 *
 * The overlay's per-question notes and its global note are **not** answers and
 * are never recorded: the answer is the row the operator picked or the text
 * they typed, and everything else is a skip.
 */
export async function askQuestionnaire(
	ctx: ExtensionContext,
	questions: readonly OverlayQuestion[],
	deps: QuestionnaireDeps = {},
): Promise<AskQuestionnaireOutcome> {
	// The overlay renders through `ctx.ui.custom`, which is a no-op outside a
	// real TUI. `routeAwaitingUi` is the one place that decides this, for every
	// surface alike (cp-gb3w), and it is checked before the loader so a non-TUI
	// parent never even pays the import.
	const route = routeAwaitingUi(deps.surface ?? "decide", { mode: ctx.mode, hasUI: ctx.hasUI });
	if (route.ui === "plain") return { kind: "unavailable", reason: route.reason };
	if (questions.length === 0) return { kind: "unavailable", reason: "nothing to ask" };

	const load: AskToolLoad = await (deps.loadTool ?? loadAskUserQuestion)().catch(
		(error: unknown): AskToolLoad => ({ reason: String(error) }),
	);
	if (!load.tool) return { kind: "unavailable", reason: load.reason ?? `${ASK_PACKAGE_SPECIFIER} is unavailable` };

	const params: AskToolParams = {
		questions: questions.map((question) => ({
			question: question.question,
			header: question.header,
			options: question.options.map((option) => ({ label: option.label, description: option.description })),
		})),
	};

	let raw: { details?: unknown } | undefined;
	const deadline = deps.timeoutMs === undefined ? undefined : overlayDeadlineContext(ctx);
	try {
		callSeq += 1;
		const execution = load.tool.execute(`cp-awaiting-${callSeq}`, params, undefined, undefined, deadline?.ctx ?? ctx);
		if (deps.timeoutMs === undefined) {
			raw = await execution;
		} else {
			const timed = await withOverlayDeadline(execution, deps.timeoutMs);
			if (timed.kind === "timeout") {
				// Close it on screen (or refuse to open it, if the package has not got
				// that far), then report the batch as a skip. Nothing is written
				// anywhere — not here, not by the caller — and every item is still
				// open, so it reappears at the marker and at the next settle.
				//
				// **The ask settles whatever `expire()` managed to do.** Closing the
				// overlay is best effort and depends on the package's shape; settling
				// this call, releasing the single-run latch and releasing the settle
				// handler's continuation do not, and must not.
				const expiry = deadline?.expire();
				// Anything other than a real close means this layer held no way to take
				// the overlay down — the package may have rendered through a channel it
				// does not intercept, or may not have rendered at all. Both are worth
				// saying: a deadline that quietly closes nothing is the failure mode
				// this signal exists to make visible.
				if (expiry !== undefined && expiry !== "closed") {
					try {
						(deps.notify ?? ((text: string, level: "info" | "warning" | "error") => ctx.ui.notify(text, level)))(
							OVERLAY_NO_CLOSE_HANDLE_NOTICE,
							"warning",
						);
					} catch {
						// Even the signal is best effort: it may never take the ask down.
					}
				}
				return { kind: "cancelled" };
			}
			raw = timed.value;
		}
	} catch (error) {
		deadline?.expire();
		return { kind: "unavailable", reason: `the overlay failed: ${(error as Error).message}` };
	}

	const details = raw?.details;
	if (!isQuestionnaireResult(details)) return { kind: "unavailable", reason: "the overlay returned no answers" };
	// An `error` means the package refused to ask (no UI, a validation guard, a
	// failed session load): the operator never saw the questions, so this is a
	// fallback, not a cancel.
	if (details.error) return { kind: "unavailable", reason: details.error };
	if (details.cancelled) return { kind: "cancelled" };

	const answers: QuestionnaireAnswer[] = questions.map((_question, index) => {
		const entry = details.answers.find((answer) => answer.questionIndex === index);
		if (!entry) return { kind: "none" };
		if (entry.kind === "custom") {
			const text = (entry.answer ?? "").trim();
			return text.length > 0 ? { kind: "custom", text } : { kind: "none" };
		}
		const picked = entry.kind === "multi" ? entry.selected?.[0] : (entry.answer ?? undefined);
		return picked === undefined || picked.length === 0 ? { kind: "none" } : { kind: "option", label: picked };
	});
	return { kind: "answers", answers };
}

// ---------------------------------------------------------------------------
// The checkpoint ask (cp-gb3w)
// ---------------------------------------------------------------------------

/** Named for the call site; `notify` is inherited (free text, and every degrade). */
export type CheckpointPromptDeps = QuestionnaireDeps;

/**
 * Put one pending checkpoint to the operator, overlay first.
 *
 * This is a whole surface in one function so it is **exercised** by a test
 * rather than matched as a source string: the overlay branch, the four ways
 * out that are not a verdict, and the degrade to the plain `ctx.ui.select`.
 *
 * It returns a verdict or nothing. Nothing is T21's "not now": the checkpoint
 * stays pending and reappears in Awaiting you. Free text is a **note** —
 * surfaced, never a verdict, never written here — which is the same rule
 * `resolveAwaitingResponse` enforces for an authorization row. The one writer,
 * `CheckpointStore.decide`, is upstream of this function and is not reachable
 * from it.
 */
export async function askCheckpointDecision(
	ctx: ExtensionContext,
	ask: CheckpointAsk,
	by: string,
	deps: CheckpointPromptDeps = {},
): Promise<{ approved: boolean; by: string } | undefined> {
	const notify = deps.notify ?? ((text: string, level: "info" | "warning" | "error") => ctx.ui.notify(text, level));
	const question = checkpointQuestion(ask);
	if (routeAwaitingUi("checkpoint", { mode: ctx.mode, hasUI: ctx.hasUI }).ui === "overlay") {
		const outcome = await askQuestionnaire(ctx, [question], { ...deps, surface: "checkpoint" });
		if (outcome.kind === "answers") {
			const verdict = interpretCheckpointAnswer(outcome.answers[0]);
			if (verdict && "note" in verdict) {
				notify(`noted on ${ask.job_id}; that is not approve/decline, so the checkpoint stays pending`, "warning");
				return undefined;
			}
			return verdict ? { approved: verdict.approved, by } : undefined;
		}
		// Esc is "not now", never a decline; anything else is a degrade that says
		// why before it falls back to the plain dialog below.
		if (outcome.kind === "cancelled") return undefined;
		notify(overlayFallbackNotice("checkpoint", outcome.reason), "warning");
	}
	const choice = await ctx.ui.select(
		question.question.split("\n")[0] ?? `${ask.job_id}: authorize?`,
		question.options.map((option) => option.label),
	);
	const verdict = interpretCheckpointAnswer(
		typeof choice === "string" ? { kind: "option", label: choice } : { kind: "none" },
	);
	return verdict && "approved" in verdict ? { approved: verdict.approved, by } : undefined;
}

// ---------------------------------------------------------------------------
// The plain dialogs — the fallback, and the unattended auto-open
// ---------------------------------------------------------------------------

export interface AwaitingPrompts {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string): Promise<string | undefined>;
}

/**
 * `ctx.ui.select` / `ctx.ui.input`, both carrying `AWAITING_DIALOG_TIMEOUT_MS`.
 * Since cp-gb3w every surface asks with the overlay first, so this is the
 * **fallback**: what every questionnaire failure degrades to (with the reason
 * named on screen), what answers an item the overlay cannot render, and what
 * every non-TUI context — headless, `pi -p`, `--mode rpc` re-entry, a missing
 * package — gets instead. No awaiting item is ever unanswerable.
 */
export function dialogPrompts(ctx: ExtensionContext): AwaitingPrompts {
	return {
		select: (title, options) =>
			ctx.ui.select(title, options, { timeout: AWAITING_DIALOG_TIMEOUT_MS }) as Promise<string | undefined>,
		input: (title) => ctx.ui.input(title, "", { timeout: AWAITING_DIALOG_TIMEOUT_MS }) as Promise<string | undefined>,
	};
}
