/**
 * The operator's slash commands: /cp-version, /status, /memory, /doctor, /cp-drain, /watch, /cp-ask, /cp-plan,
 * /cp-mandate-defaults and /cp-revive.
 * Moved from index.ts as is, except that index.ts's closure state is read through `deps` (./shared.ts).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatQuota } from "../../src/quota.ts";
import { describeRuntime } from "../../src/mode.ts";
import { AWAITING_DIALOG_TIMEOUT_MS } from "../../src/contracts.ts";
import { formatDispatchResult } from "../../src/dispatch.ts";
import { DOCTOR_EXIT_BROKEN, formatDoctor, formatDoctorJson } from "../../src/doctor.ts";
import { snapshotSessionTools } from "../../src/session-tools.ts";
import { formatParentSession, parentSession } from "../../src/parent-session.ts";
import { formatMemoryStatus } from "../../src/memory.ts";
import { formatCurationAudit, formatCurationPlan, formatMemoryReport } from "../../src/curation.ts";
import { formatStatusJson, formatStatusTable } from "../../src/status.ts";
import { formatRevivePlan, formatReviveResult } from "../../src/revive.ts";
import { formatMandateDefaults, loadMandateDefaults, setMandateDefault } from "../../src/mandate-defaults.ts";
import { formatRunView } from "../../src/watch.ts";
import { DRAIN_DEFAULT_TIMEOUT_S, DRAIN_PREFIX, formatDrain } from "../../src/drain.ts";
import { openPlanViewer } from "./plan-viewer.ts";
import { runtimeOrRefusal, formatVersionLine, readPackageIdentity, parseStatusArgs, parseWatchArgs, parsePlanArgs, type PlanArgs, parseAskArgs, memoryArgumentCompletions } from "./helpers.ts";
import type { ExtensionDeps } from "./shared.ts";

export function registerCommands(pi: ExtensionAPI, deps: ExtensionDeps): void {
	const { commandPost, setLive, emit, refreshWidget, planViewerDeps, askQuestion } = deps;

	pi.registerCommand("cp-version", {
		description: "Show the pi-command-post package version, package root and home",
		handler: async (_args, ctx) => {
			// A refused mode has no runtime to describe; saying so here is the whole
			// point of the command, so it reports rather than throws.
			const resolved = runtimeOrRefusal();
			const detail = "refusal" in resolved ? resolved.refusal : describeRuntime(resolved.runtime);
			const line = `${formatVersionLine(readPackageIdentity())}\n${detail}`;
			if (ctx.hasUI) {
				ctx.ui.notify(line, "refusal" in resolved ? "error" : "info");
			} else {
				// print/json modes: stdout belongs to the transcript/event stream.
				process.stderr.write(`${line}\n`);
			}
		},
	});

	// The fleet view. `/status` is the operator's surface (the model has the
	// widget, the envelope messages and its own tools); it never returns an
	// artifact body, only headlines the job records already carry.
	pi.registerCommand("status", {
		description: "Show the fleet: one line per worker, or --json for the full snapshot",
		getArgumentCompletions: (prefix: string) => {
			const flags = ["--json", "--all", "--project", "--no-titles"]
				.filter((flag) => flag.startsWith(prefix))
				.map((flag) => ({ value: flag, label: flag }));
			return flags.length > 0 ? flags : null;
		},
		handler: async (args, ctx) => {
			setLive(ctx);
			let text: string;
			let json = false;
			try {
				const parsed = parseStatusArgs(args);
				json = parsed.json;
				const active = commandPost(ctx.modelRegistry);
				const snapshot = await active.status(parsed.query);
				// The drain projection is this process's live workers, which no file
				// records — so it rides on the render, not on the snapshot (and
				// `--json` stays exactly the pinned snapshot).
				text = json ? formatStatusJson(snapshot) : formatStatusTable(snapshot, { drain: active.quiesce() });
				if (!json && active.capacity.quota.latest) text += `\n${formatQuota(active.capacity.quota.latest)}`;
				refreshWidget(ctx);
			} catch (error) {
				const message = (error as Error).message;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				else process.stderr.write(`${message}\n`);
				return;
			}
			emit(ctx, "status", text, { json });
		},
	});

	// Memory. Status is the mechanical half of the cp-memory skill (budget, decay
	// windows, untiered lines); capture is the only append, and it goes to
	// candidates.md by construction, so "capture is not promotion" is code.
	pi.registerCommand("memory", {
		description:
			"Session memory: status (budget, decay, candidates), curate (what the parent's pass would do), " +
			"audit (every promotion/rejection/retirement) or `capture <one-line lesson>`",
		getArgumentCompletions: (prefix: string) => memoryArgumentCompletions(prefix),
		handler: async (args, ctx) => {
			setLive(ctx);
			const trimmed = args.trim();
			const post = commandPost(ctx.modelRegistry);
			let text: string;
			try {
				if (trimmed === "" || trimmed === "status") {
					text = formatMemoryReport(formatMemoryStatus(post.memory()), post.curationPlan());
				} else if (trimmed === "curate") {
					// Read-only on purpose: this shows the worklist and today's remaining
					// bounds. The pass itself is the parent's (cp_memory), not a chore the
					// operator has to run.
					text = formatCurationPlan(post.curationPlan());
				} else if (trimmed === "audit" || trimmed.startsWith("audit ")) {
					const line = trimmed.slice("audit".length).trim();
					text = formatCurationAudit(post.curationAudit(line.length > 0 ? line : undefined));
				} else if (trimmed.startsWith("capture")) {
					const lesson = trimmed.slice("capture".length).trim();
					if (lesson.length === 0) {
						throw new Error("/memory capture needs a one-line lesson — usage: /memory capture <one-line lesson>");
					}
					const result = post.capture(lesson);
					text = `captured in ${result.file} (${result.candidates} candidate(s)): ${result.line}`;
				} else {
					throw new Error(
						`/memory: unknown argument ${JSON.stringify(trimmed)} — usage: /memory [status | curate | audit [<line>] | capture <lesson>]`,
					);
				}
			} catch (error) {
				const message = (error as Error).message;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				else process.stderr.write(`${message}\n`);
				return;
			}
			emit(ctx, "memory", text);
		},
	});

	// Diagnosis. Read-only and honest about degradation: a fresh home with no
	// optional config is green, and only "this home cannot dispatch" is an error.
	pi.registerCommand("doctor", {
		description: "Diagnose this command post: host tools, ledger, package resources, models, scaffold, fleet",
		getArgumentCompletions: (prefix: string) =>
			"--json".startsWith(prefix) ? [{ value: "--json", label: "--json" }] : null,
		handler: async (args, ctx) => {
			setLive(ctx);
			const trimmed = args.trim();
			if (trimmed !== "" && trimmed !== "--json") {
				const message = `/doctor: unknown argument ${JSON.stringify(trimmed)} \u2014 usage: /doctor [--json]`;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				else process.stderr.write(`${message}\n`);
				return;
			}
			// pi's version is read by running `pi --version`, like every other host
			// tool: the extension API does not expose it, and inventing a number from
			// our own package would diagnose the wrong binary.
			let tools = deps.sessionTools;
			try {
				tools = snapshotSessionTools(pi.getAllTools());
			} catch {
				// Keep the session_start snapshot if the live list cannot be read.
			}
			const report = await commandPost(ctx.modelRegistry).doctor({
				...(tools ? { sessionTools: tools } : {}),
			});
			const json = trimmed === "--json";
			const sessionText = formatParentSession(parentSession(ctx), {
				widget: Boolean(deps.widgetTimer),
				keys: false,
				ciWatch: Boolean(deps.ciWatchTimer),
				orchestration: Boolean(deps.widgetTimer || deps.orchestrationTimer),
			});
			const text = json ? formatDoctorJson(report) : `${formatDoctor(report)}\n\n${sessionText}`;
			emit(ctx, "doctor", text, { level: report.ok ? "info" : "error", ...(json ? { json: true } : {}) });
			// Headless callers script on this (ported `cmdp doctor` exit code).
			if (!ctx.hasUI && !report.ok) process.exitCode = DOCTOR_EXIT_BROKEN;
		},
	});

	// Graceful drain before a restart (src/drain.ts); the operator's `cp_parent drain` runs this same command.
	pi.registerCommand("cp-drain", {
		description: `Start a drain and return: refuse new processes and merge steps; one wake follows when live workers and reviewers settle, or after [seconds] (default ${DRAIN_DEFAULT_TIMEOUT_S}); /cp-drain cancel withdraws a draining or timed-out drain`,
		handler: async (args, ctx) => {
			setLive(ctx);
			const trimmed = args.trim();
			const cancel = trimmed === "cancel";
			const timeoutS = trimmed === "" || cancel ? undefined : Number(trimmed);
			let text: string;
			let level: "info" | "error" = "error";
			if (timeoutS !== undefined && !(Number.isFinite(timeoutS) && timeoutS >= 0)) {
				text = `${DRAIN_PREFIX}refused: ${JSON.stringify(trimmed)} is not a timeout in seconds \u2014 usage: /cp-drain [seconds|cancel]`;
			} else {
				// Returns at once: the outcome is one cp-recovery wake from the ordinary tick (DrainControl.check).
				try {
					const post = commandPost(ctx.modelRegistry);
					if (cancel) {
						text = post.drain.cancel();
						level = "info";
					} else {
						const record = post.drain.start(timeoutS);
						text = formatDrain(record, post.home);
						if (record.state !== "timeout") level = "info";
					}
				} catch (error) {
					text = `${DRAIN_PREFIX}failed: ${(error as Error).message}`;
				}
			}
			emit(ctx, "cp-drain", text, { level });
		},
	});

	// The run viewer, bounded. `--export` prints the command instead of running
	// it: a session export is a whole transcript, and the one thing this session
	// must not become is a place where other sessions' contents are pasted.
	pi.registerCommand("watch", {
		description: "Render a job's run log (state/runs/<job-id>/events.jsonl); no follow, this session never polls",
		handler: async (args, ctx) => {
			setLive(ctx);
			let text: string;
			try {
				const parsed = parseWatchArgs(args);
				const post = commandPost(ctx.modelRegistry);
				const watcher = post.watcher();
				if (parsed.exportRun) {
					const { argv, session_file } = watcher.exportCommand(parsed.jobId);
					text = `session ${session_file}\nrun: pi ${argv.join(" ")}`;
				} else {
					text = formatRunView(watcher.render(parsed.jobId, { mode: parsed.mode, last: parsed.last }));
					// cp-9c5: a pointer only — path and byte count, never a body. The
					// checkpoint's own evidence already carries both; this just saves a
					// trip to look them up.
					if (post.artifacts.has(parsed.jobId)) {
						const info = post.artifacts.info(parsed.jobId);
						text += `\nplan: /cp-plan ${parsed.jobId} (${info.bytes} bytes, ${info.path})`;
					}
				}
			} catch (error) {
				const message = (error as Error).message;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				else process.stderr.write(`${message}\n`);
				return;
			}
			emit(ctx, "watch", text);
		},
	});

	/**
	 * `/cp-ask <project> <question…>` (cp-u3o4) — the deterministic door to the
	 * Q&A path. The operator has already decided this is a question, so no model
	 * turn is spent classifying it, and `cp_ask` (below) is the same code path for
	 * a question the operator asked in chat instead.
	 */
	pi.registerCommand("cp-ask", {
		description:
			"Ask a small question about an onboarded project. A read-only worker answers it and the answer arrives " +
			"as a card in this transcript — no plan to open. Usage: /cp-ask <project> <question…> [--model <ref>]",
		getArgumentCompletions: (prefix: string) => {
			try {
				const names = commandPost().registry.names().filter((name) => name.startsWith(prefix));
				return names.length > 0 ? names.map((name) => ({ value: name, label: name })) : null;
			} catch {
				return null;
			}
		},
		handler: async (args, ctx) => {
			setLive(ctx);
			try {
				const parsed = parseAskArgs(args);
				const result = await askQuestion({
					project: parsed.project,
					question: parsed.question,
					...(parsed.model ? { model: parsed.model } : {}),
					registry: ctx.modelRegistry,
				});
				refreshWidget(ctx);
				// The dispatch record, never an answer: the answer arrives on its own as
				// a card when the worker reports.
				emit(ctx, "cp-ask", `${result.job_id} asked — the answer will appear here as a card.\n${formatDispatchResult(result.dispatch)}`);
			} catch (error) {
				const message = (error as Error).message;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				else process.stderr.write(`${message}\n`);
			}
		},
	});

	pi.registerCommand("cp-plan", {
		description:
			"Open a research plan (or, with --gate [n], a gate decision) in your own pager. Operator-only: no tool reaches " +
			"this, and outside a real TUI it degrades to a path and byte count — never the body.",
		getArgumentCompletions: (prefix: string) => {
			try {
				const ids = commandPost().artifacts.list().filter((id) => id.startsWith(prefix));
				return ids.length > 0 ? ids.map((id) => ({ value: id, label: id })) : null;
			} catch {
				return null;
			}
		},
		handler: async (args, ctx) => {
			setLive(ctx);
			let parsed: PlanArgs;
			try {
				parsed = parsePlanArgs(args);
			} catch (error) {
				const message = (error as Error).message;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				else process.stderr.write(`${message}\n`);
				return;
			}
			const post = commandPost(ctx.modelRegistry);
			let jobId = parsed.jobId;
			if (!jobId) {
				const ids = post.artifacts.list();
				if (ids.length === 0) {
					const message = "no viewable plans — no research artifacts are on this home yet";
					if (ctx.hasUI) ctx.ui.notify(message, "info");
					else process.stderr.write(`${message}\n`);
					return;
				}
				if (ctx.mode === "tui") {
					const choice = await ctx.ui.select("Which plan?", ids, { timeout: AWAITING_DIALOG_TIMEOUT_MS });
					if (!choice) return;
					jobId = choice;
				} else {
					const text = ["viewable plans:", ...ids.map((id) => `  - ${id}`), "", "run /cp-plan <job-id>"].join("\n");
					emit(ctx, "cp-plan", text);
					return;
				}
			}
			const target = post.planTarget(jobId, parsed.gate !== undefined ? { gate: parsed.gate } : {});
			await openPlanViewer(ctx, target, planViewerDeps(target));
		},
	});

	// The operator's own door to data/mandate-defaults.json (autonomy-programme-cur.2.5):
	// show what a bare "fix <project> #N" mandate would resolve to, or change one field.
	pi.registerCommand("cp-mandate-defaults", {
		description: "Show or set a mandate default (data/mandate-defaults.json): /cp-mandate-defaults [show | set <key> <value>]",
		handler: async (args, ctx) => {
			setLive(ctx);
			const trimmed = args.trim();
			const post = commandPost(ctx.modelRegistry);
			let text: string;
			try {
				if (trimmed === "" || trimmed === "show") {
					text = formatMandateDefaults(loadMandateDefaults(post.home));
				} else if (trimmed.startsWith("set ")) {
					const [key, ...rest] = trimmed.slice("set ".length).trim().split(/\s+/);
					if (!key || rest.length === 0) {
						throw new Error(`/cp-mandate-defaults set needs a key and a value \u2014 usage: /cp-mandate-defaults set <key> <value>`);
					}
					const defaults = setMandateDefault(post.home, key, rest.join(" "));
					text = `${key} set\n${formatMandateDefaults(defaults)}`;
				} else {
					throw new Error(
						`/cp-mandate-defaults: unknown argument ${JSON.stringify(trimmed)} \u2014 usage: /cp-mandate-defaults [show | set <key> <value>]`,
					);
				}
			} catch (error) {
				const message = (error as Error).message;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				else process.stderr.write(`${message}\n`);
				return;
			}
			emit(ctx, "cp-mandate-defaults", text);
		},
	});

	// The operator's own path to revival (cp-8km), alongside cp_revive: plan
	// first, show the interrupted tool call and any worktree hazard, then ask
	// before relaunching anything — revival is explicit, never automatic.
	pi.registerCommand("cp-revive", {
		description:
			"Relaunch a dead job's worker from its own session file (plans first, then asks before relaunching); " +
			"--continue-failed continues a failed job on its original lease",
		handler: async (args, ctx) => {
			setLive(ctx);
			const words = args.trim().split(/\s+/).filter((word) => word.length > 0);
			const options = words.includes("--continue-failed") ? { continueFailed: true } : {};
			const jobId = words.find((word) => !word.startsWith("--"));
			if (!jobId) {
				ctx.ui.notify("usage: /cp-revive <job-id> [--continue-failed]", "error");
				return;
			}
			const reviver = commandPost(ctx.modelRegistry).reviver();
			const plan = await reviver.plan(jobId, options);
			const planText = formatRevivePlan(plan);
			if (!plan.ok) {
				ctx.ui.notify(planText, "error");
				return;
			}
			if (!ctx.hasUI) {
				// Headless: printing the plan is the whole of it — revival never happens
				// without a human confirming, and there is no dialog to confirm with here.
				process.stderr.write(`${planText}\n`);
				return;
			}
			const choice = await ctx.ui.select(planText, ["revive", "cancel"]);
			if (choice !== "revive") {
				ctx.ui.notify(`${jobId}: revival cancelled`, "info");
				return;
			}
			try {
				const result = await reviver.revive(jobId, options);
				refreshWidget(ctx);
				ctx.ui.notify(formatReviveResult(result), "info");
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
			}
		},
	});
}
