#!/usr/bin/env node
/**
 * Stand-in for `pi --mode rpc` as a CP parent. Records argv, answers get_state,
 * settles one turn per prompt, and can emit one unsolicited wake.
 *
 * Bridge sends carry a `[cp-send <id> — delivery id, …]` marker line: it is
 * stripped from the prompt log and the reply, its ids go to
 * FAKE_PARENT_SEND_IDS, and each landed user message is kept as a session entry
 * (`<session>.fake-entries.jsonl`) for `get_entries`. `HANG` lands and holds the
 * turn open until a `RELEASE` follow-up; `NOLAND` (once, while the
 * FAKE_PARENT_NOLAND_ONCE flag file is absent) is accepted and never lands.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";

const argvFile = process.env.FAKE_PARENT_ARGV;
const pidFile = process.env.FAKE_PARENT_PID_FILE;
function recordPid(pid) {
	if (!pidFile) return;
	const stat = process.platform === "linux" ? readFileSync(`/proc/${pid}/stat`, "utf8") : "";
	const startTime = stat ? stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19] : null;
	appendFileSync(pidFile, `${JSON.stringify({ pid, startTime })}\n`);
}
recordPid(process.pid);
const worker = process.env.FAKE_PARENT_WORKER_PID_FILE
	? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "fake-parent-worker"], { stdio: "ignore" }) : null;
if (worker) {
	writeFileSync(process.env.FAKE_PARENT_WORKER_PID_FILE, String(worker.pid));
	recordPid(worker.pid);
}
process.on("SIGTERM", () => {
	worker?.kill("SIGTERM");
	process.exit(0);
});
if (argvFile) appendFileSync(argvFile, `${JSON.stringify(process.argv)}\n`);

function sessionFromArgv() {
	const index = process.argv.indexOf("--session");
	return index >= 0 ? process.argv[index + 1] : null;
}

let activeSession = sessionFromArgv();
if (activeSession && !existsSync(activeSession)) writeFileSync(activeSession, '{"type":"session"}\n');
const rl = createInterface({ input: process.stdin, terminal: false });
let woke = false;
/** The body of a HANG turn still open. */
let held = null;
/** A SEGMENT turn answered at a clean turn_end, its run still open. */
let segmented = false;
/** pi's turn_end after a text-only answer: the end of a segment, not of the run. */
const SEGMENT_END = { type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] };
/** FAKE_PARENT_WAKE_SEGMENT=1: the startup wake ends at a clean turn_end and never settles. */
const wakeEnd = () => (process.env.FAKE_PARENT_WAKE_SEGMENT === "1" ? SEGMENT_END : { type: "agent_settled" });
let compacted = false;
let compactedTurn = false;
let statsBusy = false;
const entriesFile = sessionFromArgv() ? `${sessionFromArgv()}.fake-entries.jsonl` : null;

function readEntries() {
	if (!entriesFile || !existsSync(entriesFile)) return [];
	return readFileSync(entriesFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function write(record) {
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

rl.on("line", (line) => {
	if (!line.trim()) return;
	let record;
	try {
		record = JSON.parse(line);
	} catch {
		return;
	}
	const { type, id, message } = record;
	if (type === "get_state") {
		const lines = [
			{
				type: "response",
				command: "get_state",
				id,
				success: true,
				data: { isStreaming: false, sessionFile: activeSession },
			},
		];
		if (!woke && process.env.FAKE_PARENT_WAKE === "1") {
			woke = true;
			// FAKE_PARENT_WAKE_TEXT: the parent's prose; FAKE_PARENT_WAKE_JOB: the wake-up's structured job field.
			const prose = process.env.FAKE_PARENT_WAKE_TEXT;
			const job = process.env.FAKE_PARENT_WAKE_JOB;
			lines.push(
				{ type: "agent_start" },
				...(job
					? [
							{
								type: "message_end",
								message: {
									role: "custom",
									customType: "cp-ci",
									content: prose ?? "",
									details: { cp_wakeup: { kind: "ci", job_id: job, issued_at: "2026-09-24T00:00:00Z" } },
								},
							},
						]
					: []),
				// FAKE_PARENT_WAKE_SCHEDULE: a scheduler fire message, whose job is `details.job_id` (no cp_wakeup stamp).
				...(process.env.FAKE_PARENT_WAKE_SCHEDULE
					? [{ type: "message_end", message: { role: "custom", customType: "cp-schedule", content: "schedule fired", details: { outcome: "fired", job_id: process.env.FAKE_PARENT_WAKE_SCHEDULE } } }]
					: []),
				// FAKE_PARENT_WAKE_ENVELOPE (JSON {job_id, status, summary}): an accepted cp-envelope wake-up (issue #2).
				...(process.env.FAKE_PARENT_WAKE_ENVELOPE
					? (() => {
						const env = JSON.parse(process.env.FAKE_PARENT_WAKE_ENVELOPE);
						return [{ type: "message_end", message: { role: "custom", customType: "cp-envelope", content: `${env.job_id}: ${env.summary}`, details: { ...env, accepted: true, cp_wakeup: { kind: "envelope", job_id: env.job_id, issued_at: "2026-09-24T00:00:00Z" } } } }];
					})()
					: []),
				// FAKE_PARENT_WAKE_DURABLE (JSON {id, content}): a durable cp-recovery wake-up.
				...(process.env.FAKE_PARENT_WAKE_DURABLE
					? (() => {
						const durable = JSON.parse(process.env.FAKE_PARENT_WAKE_DURABLE);
						return [{ type: "message_end", message: { role: "custom", customType: "cp-recovery", content: durable.content, details: { durable_id: durable.id, cp_wakeup: { kind: "recovery", issued_at: "2026-09-24T00:00:00Z" } } } }];
					})()
					: []),
			);
		}
		if (lines.length > 1 && process.env.FAKE_PARENT_WAKE_TEXT) {
			lines.push(
				{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: process.env.FAKE_PARENT_WAKE_TEXT }] } },
				wakeEnd(),
			);
		} else if (lines.length > 1) {
			lines.push(
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "job: cp-wake\nwake: worker settled" }],
					},
				},
				wakeEnd(),
			);
		}
		process.stdout.write(lines.map((record) => JSON.stringify(record)).join("\n") + "\n");
		return;
	}
	if (type === "get_commands") {
		const commands = process.env.FAKE_PARENT_DIAGNOSTIC === "missing" ? [] : ["doctor", "cp-version"].map((name) => ({ name, source: "extension" }));
		write({ type: "response", command: type, id, success: true, data: { commands } });
		return;
	}
	if (type === "prompt" && (message === "/doctor" || message === "/cp-version")) {
		const outcome = process.env.FAKE_PARENT_DIAGNOSTIC;
		if (outcome === "error") write({ type: "extension_error", extensionPath: `command:${message.slice(1)}`, event: "command", error: "diagnostic fixture failure" });
		write({ type: "response", command: type, id, success: outcome !== "rejected", ...(outcome === "rejected" ? { error: "diagnostic fixture failure" } : {}) });
		return;
	}
	if (type === "get_session_stats") {
		// FAKE_PARENT_STATS_TOKENS: the pre-compaction reading (default 42000).
		const before = Number(process.env.FAKE_PARENT_STATS_TOKENS ?? 42000);
		const reply = () => write({ type: "response", command: type, id, success: true, data: { sessionFile: activeSession, contextUsage: { tokens: compacted ? (compactedTurn ? 5000 : null) : before, contextWindow: 200000, percent: 21 } } });
		// FAKE_PARENT_STATS_BUSY_ONCE=1: a run starts (and never settles) before the first reading answers.
		if (process.env.FAKE_PARENT_STATS_BUSY_ONCE === "1" && !statsBusy) {
			statsBusy = true;
			write({ type: "agent_start" });
		}
		const delay = Number(process.env.FAKE_PARENT_STATS_DELAY_MS ?? 0);
		if (delay > 0) setTimeout(reply, delay);
		else reply();
		return;
	}
	if (type === "compact") {
		compacted = true;
		const promptLog = process.env.FAKE_PARENT_PROMPTS;
		if (promptLog) appendFileSync(promptLog, "[compact]\n");
		// FAKE_PARENT_COMPACT_FAIL=1 refuses; FAKE_PARENT_COMPACT_DELAY_MS delays only the response.
		const reply = () => write(process.env.FAKE_PARENT_COMPACT_FAIL === "1"
			? { type: "response", command: type, id, success: false, error: "fixture compaction failure" }
			: { type: "response", command: type, id, success: true, data: { tokensBefore: 42000, estimatedTokensAfter: 5000 } });
		const delay = Number(process.env.FAKE_PARENT_COMPACT_DELAY_MS ?? 0);
		if (delay > 0) setTimeout(reply, delay);
		else reply();
		return;
	}
	if (type === "new_session") {
		activeSession = join(dirname(activeSession), `new-parent-${Date.now()}.jsonl`);
		writeFileSync(activeSession, '{"type":"session"}\n');
		write({ type: "response", command: type, id, success: true, data: { cancelled: false } });
		return;
	}
	if (type === "set_model") {
		write({ type: "response", command: type, id, success: true, data: { provider: record.provider, id: record.modelId } });
		return;
	}
	if (type === "get_entries") {
		write({ type: "response", command: type, id, success: true, data: { entries: readEntries(), leafId: null } });
		return;
	}
	if (type === "prompt" || type === "follow_up" || type === "steer") {
		const raw = String(message ?? "");
		const text = raw.replace(/\n*\[cp-send ps-\S+ — delivery id, not an instruction\]/g, "");
		const idLog = process.env.FAKE_PARENT_SEND_IDS;
		if (idLog) for (const match of raw.matchAll(/\[cp-send (ps-\S+) /g)) appendFileSync(idLog, `${match[1]}\n`);
		const noLand = process.env.FAKE_PARENT_NOLAND_ONCE;
		if (text.includes("NOLAND") && noLand && !existsSync(noLand)) {
			// A follow-up still queued in a process that is about to die.
			writeFileSync(noLand, "1");
			write({ type: "response", command: type, id, success: true });
			return;
		}
		const promptLog = process.env.FAKE_PARENT_PROMPTS;
		if (promptLog) appendFileSync(promptLog, `${text}\n`);
		if (entriesFile) {
			const entry = { type: "message", id: `e${Date.now()}`, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: raw }] } };
			appendFileSync(entriesFile, `${JSON.stringify(entry)}\n`);
		}
		const userEcho = { type: "message_end", message: { role: "user", content: [{ type: "text", text: raw }] } };
		if ((held !== null || segmented) && text.includes("RELEASE")) {
			// The held turn answers first and ends cleanly (pi takes a follow-up only
			// after a turn_end); the follow-up lands after it, in the same run.
			if (held !== null) {
				write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `reply: ${held}` }], stopReason: "stop" } });
				write(SEGMENT_END);
			}
			held = null;
			segmented = false;
			write(userEcho);
			write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `reply: ${text}` }] } });
			write({ type: "agent_settled" });
			write({ type: "response", command: type, id, success: true });
			return;
		}
		write({ type: "agent_start" });
		if (compacted) compactedTurn = true;
		// Real pi echoes the injected user message on the stream too (cur.5.4
		// repro): never assistant text, must never become the reply.
		if (text.includes("IDLEBEADS")) {
			write({ type: "message_end", message: { role: "custom", customType: "cp-idle-beads", content: "fleet idle with 2 ready beads\n[demo] 2 ready beads have no job: b-one, b-two" } });
		}
		write(userEcho);
		if (text.includes("MISSIONEND")) {
			write({ type: "tool_execution_end", toolCallId: "call-next", toolName: "cp_next", isError: false, result: { details: { action: { kind: "mission_end" }, mandate: { id: "md-test" } } } });
		}
		if (text.includes("NEXTMESSY")) {
			// cp_next itself raised this mission end (es-0001 in the home's store): no cp_escalate call ever ran.
			write({ type: "tool_execution_end", toolCallId: "call-next-messy", toolName: "cp_next", isError: false, result: { details: { action: { kind: "mission_end" }, mandate: { id: "md-000001" }, escalation_id: "es-0001" } } });
		}
		if (text.includes("HANG")) {
			held = text;
			write({ type: "response", command: type, id, success: true });
			return;
		}
		if (text.includes("SEGMENT")) {
			// Answered at a clean turn_end; the run stays open (no agent_settled) until a RELEASE.
			segmented = true;
			write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `reply: ${text}` }], stopReason: "stop" } });
			write(SEGMENT_END);
			write({ type: "response", command: type, id, success: true });
			return;
		}
		// H1 (Pier 2.6): a transient failure that never clears, no matter how many
		// times the outer ladder resumes it \u2014 for exercising the ladder's own cap.
		if (process.env.FAKE_PARENT_TRANSIENT_ALWAYS === "1") {
			write({
				type: "message_end",
				message: { role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded, try again" },
			});
			write({ type: "agent_settled" });
			write({ type: "response", command: type, id, success: true });
			return;
		}
		if (text.includes("ERROR")) {
			write({
				type: "message_end",
				message: { role: "assistant", content: [], stopReason: "error", errorMessage: "404 model not found: gpt-5" },
			});
			write({ type: "agent_settled" });
			write({ type: "response", command: type, id, success: true });
			return;
		}
		// H1 (Pier 2.6): a transient provider error, so the caller's own outer
		// ladder is worth exercising. The RESUME_NUDGE that ladder sends never
		// contains "TRANSIENT", so it always lands on the ordinary success path.
		if (text.includes("TRANSIENT")) {
			write({
				type: "message_end",
				message: { role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded, try again" },
			});
			write({ type: "agent_settled" });
			write({ type: "response", command: type, id, success: true });
			return;
		}
		if (text.includes("STALE")) {
			write({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "STALE WAKE-UP — do not act on this (cp-old)." }],
				},
			});
		}
		if (text.includes("REFRESH")) {
			// One escalation id raised twice: the second raise carries fresher numbers.
			for (const cost of ["9.23", "9.95"]) {
				write({
					type: "tool_execution_end",
					toolCallId: `call-${cost}`,
					toolName: "cp_escalate",
					isError: false,
					result: { details: { id: "es-0002", job_ids: ["cp-job"], kind: "mission_end", question: `md-000001: every job it names is closed \u2014 cost $${cost}`, evidence_paths: [], status: "open" } },
				});
			}
		}
		if (text.includes("RISKWARN")) {
			// H6: a dispatch and a pipeline advance whose results carry a risk_warning, and one that carries none.
			const warning = "cp-h6: warning: risk:high inferred from keywords only (delete)";
			write({ type: "tool_execution_end", toolCallId: "call-d", toolName: "cp_dispatch", isError: false, result: { details: { job_id: "cp-h6", risk_warning: warning } } });
			write({ type: "tool_execution_end", toolCallId: "call-p", toolName: "cp_pipeline", isError: false, result: { details: { ship_id: "cp-h6p", dispatch: { job_id: "cp-h6p", risk_warning: warning.replace("cp-h6", "cp-h6p") } } } });
			write({ type: "tool_execution_end", toolCallId: "call-s", toolName: "cp_send", isError: false, result: { details: { job_id: "cp-quiet" } } });
		}
		if (text.includes("REFUSE_ESCALATION") || text.includes("RETRY_ESCALATION")) {
			write({ type: "tool_execution_end", toolCallId: "call_raw-id", toolName: "cp_escalate", isError: true, result: { content: [{ type: "text", text: "option consequence exceeds schema cap" }] } });
		}
		if ((text.includes("ESCALATE") || text.includes("RETRY_ESCALATION")) && !text.includes("REFUSE_ESCALATION")) {
			const details = {
				id: "es-0001",
				job_ids: ["cp-job"],
				kind: "product_ambiguity",
				question: "ship?",
				evidence_paths: ["state/runs/cp-job/artifact.md"],
				status: "open",
			};
			write({
				type: "tool_execution_end",
				toolCallId: "call-es",
				toolName: "cp_escalate",
				isError: false,
				result: { details, content: [{ type: "text", text: "es-1 open" }] },
			});
			write({
				type: "tool_execution_end",
				toolCallId: "call-es-dup",
				toolName: "cp_escalate",
				isError: false,
				result: { details },
			});
		}
		// FAKE_PARENT_LENGTH_STOP=1: N6 — a length stop billed 128000 output tokens, ~400 chars stored.
		const lengthStop = process.env.FAKE_PARENT_LENGTH_STOP === "1"
			? { stopReason: "length", usage: { input: 2, output: 128000, cacheRead: 126795, cacheWrite: 801, totalTokens: 255598 } }
			: {};
		write({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: lengthStop.stopReason ? `reply: ${text} ${"x".repeat(390)}` : `reply: ${text}` }], ...lengthStop },
		});
		write({ type: "agent_settled" });
		write({ type: "response", command: type, id, success: true });
		return;
	}
	write({ type: "response", command: type, id, success: true });
});

rl.on("close", () => {
	if (worker) worker.kill("SIGTERM");
	process.exit(0);
});
