/**
 * Codex worker fixture (C1b): a dispatchS29 home with its own data/native.json (codex_research on unless `native`
 * says otherwise), a routing allow for `openai/gpt-picp-fake`, fake-codex and the fake `systemd-run` first on PATH,
 * and `CP_CODEX_HOME` on a temp dir holding the synthetic auth sentinel. The real `cp_dispatch` selects the driver.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { DEFAULT_ORIGIN, type Delivery, type DiffVerdict, EMPTY_USAGE, isoTimestamp, type JobKind, LAYOUT, paths } from "../../src/contracts.ts";
import { NATIVE_CODEX_SESSION_FILE, readNativeSession } from "../../src/drivers/claude-followup.ts";
import { FleetStore } from "../../src/fleet.ts";
import { routeNativeModel } from "./claude-mock-provider.ts";
import { AUTH_SENTINEL, type FakeCodexScript, type FakeCodexStep, installCodexStub, writeCodexScript } from "./codex-mock.ts";
import { dispatchS29 } from "./dispatch-s29.ts";
import { readFleet, readRunEvents, type ScriptStep, waitFor } from "./index.ts";

export const FAKE_CODEX_REF = "openai/gpt-picp-fake";

export async function codexWorkerHome(t: TestContext, opts: { native?: Record<string, unknown> | null } = {}) {
	const b = await dispatchS29(t);
	const nativeFile = join(b.home, LAYOUT.data, "native.json");
	if (opts.native !== null) writeFileSync(nativeFile, JSON.stringify(opts.native ?? { codex_research: true }));
	routeNativeModel(b.home, [FAKE_CODEX_REF]);
	const root = mkdtempSync(join(tmpdir(), "cp-codex-worker-e2e-"));
	t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
	const [bin, state, codexHome, outside] = ["codex-release/bin", "state", "codex-home", "outside"].map((name) => join(root, name)) as [string, string, string, string];
	for (const dir of [bin, state, codexHome, outside]) mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(codexHome, "auth.json"), `${AUTH_SENTINEL}\n`, { mode: 0o600 });
	const script = join(root, "script.json");
	writeCodexScript(script, { turns: [] });
	installCodexStub(bin, { script, stateDir: state });
	const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, CP_CODEX_HOME: codexHome };
	const record = (id: string) => readFleet(b.home).jobs.find((job) => job.job_id === id);

	/** A ledger job, its artifact dir made, and the parent step that dispatches it (explicit codex unless `driver` says). */
	async function job(delivery: Delivery = "local", kind: JobKind = "research") {
		const created = await b.ledger.create({ title: `codex ${kind} ${Math.random()}`, project: "demo", delivery, kind });
		mkdirSync(join(b.home, paths.artifactDir(created.id)), { recursive: true });
		const dispatch = (over: Record<string, unknown> = {}): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: {
			job_id: created.id, task: "Report what README.md says.", model: FAKE_CODEX_REF, driver: "codex", queue: false, when_ready: false, ...over,
		} }] });
		return { id: created.id, artifact: join(b.home, paths.artifactFile(created.id)), dispatch };
	}
	const report = (id: string, over: Record<string, unknown> = {}) => ({
		job_id: id, kind: "research", status: "done", summary: "Codex research filed.", artifact_path: join(b.home, paths.artifactFile(id)),
		plan_summary: { goal: "g", approach: ["a"], acceptance: ["x"], risk: "r", touched: ["t"] }, ...over,
	});
	/** The fake's steps: write the artifact with a heredoc-free printf, then the given steps, then the report. */
	const reporting = (id: string, steps: FakeCodexStep[] = []): FakeCodexStep[] => [
		{ kind: "shell" as const, command: `printf '# codex findings\\n' > ${join(b.home, paths.artifactFile(id))}` },
		...steps,
		{ kind: "tool" as const, tool: "report_result", arguments: report(id) },
		{ kind: "message" as const, text: "Reported." },
	];
	const setScript = (next: FakeCodexScript) => writeCodexScript(script, next);
	/** The parent step that waits (up to 60 s) for `file`. */
	const awaitFile = (file: string): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "bash", args: { command: `for i in $(seq 300); do [ -f "${file}" ] && break; sleep 0.2; done; sleep 1` } }] });
	const awaitEnvelope = (id: string) => awaitFile(join(b.home, paths.envelopeFile(id)));
	/** The parent step that waits (up to 120 s) until `pattern` appears `count` times in the job's run log. */
	const waitEvent = (id: string, pattern: string, count = 1): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "bash", args: {
		command: `for i in $(seq 600); do [ "$(grep -c '${pattern}' "${join(b.home, paths.eventsFile(id))}" 2>/dev/null)" -ge ${count} ] && break; sleep 0.2; done; sleep 1`,
	} }] });
	/** The parent step that sleeps `seconds` (a worker exit or a teardown settling). */
	const pause = (seconds: number): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "bash", args: { command: `sleep ${seconds}` } }] });
	const runs = async (id: string) => (await waitFor(() => readRunEvents(b.home, id).filter((event) => event.type === "native_run"), (found) => found.length > 0,
		{ timeoutMs: 60_000, what: `${id}'s native_run` })).map((event) => event.payload as Record<string, unknown>);
	const session = (id: string) => readNativeSession(join(b.home, paths.runDir(id), NATIVE_CODEX_SESSION_FILE));
	const homeListing = () => readdirSync(codexHome).sort();
	const lines = <T>(file: string): T[] => {
		try {
			return readFileSync(join(state, file), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
		} catch {
			return [];
		}
	};
	const run = async (steps: ScriptStep[], extraEnv: Record<string, string> = {}, prompt?: string) =>
		(await b.run(steps, { ...env, ...extraEnv }, prompt, 240_000)) as Array<{ toolName: string; isError?: boolean; result: { details?: Record<string, unknown>; content?: unknown } }>;
	const agentDir = b.agent.path;

	/** C6: a held ship job whose branch (one commit) is pushed to the project's origin, as cp_review needs. */
	async function heldShipJob(id: string): Promise<void> {
		const origin = execFileSync("git", ["-C", b.clone, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
		const work = join(root, `src-${id}`);
		execFileSync("git", ["clone", "--quiet", origin, work]);
		const git = (...args: string[]) => execFileSync("git", ["-C", work, "-c", "user.name=picp", "-c", "user.email=picp@example.invalid", ...args], { stdio: "ignore" });
		git("checkout", "--quiet", "-b", id);
		writeFileSync(join(work, `${id}.txt`), `${id} REVIEWED-CHANGE-LINE\n`);
		git("add", "-A");
		git("commit", "--quiet", "-m", id);
		git("push", "--quiet", "-u", "origin", id);
		const now = isoTimestamp();
		await new FleetStore({ home: b.home }).add({
			job_id: id, project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "held", reported_at: now, dispatched_at: now, usage: EMPTY_USAGE, branch: id,
			worker: { pid: process.pid, session_id: "legacy", session_file: join(b.home, "legacy.jsonl"), profile: "implementer", role: "implementer", model: "mock/model", started_at: now },
			worktree: join(b.home, "recycled", id),
		});
	}
	/** C6: the `reviews` row on codex with a pi `fallback`, replacing any earlier one. */
	function reviewsRow(fallback: string): void {
		const file = join(b.home, LAYOUT.routingFile);
		const config = JSON.parse(readFileSync(file, "utf8")) as { allow: string[]; rubric: Array<{ id: string }> };
		config.rubric = [...config.rubric.filter((row) => row.id !== "reviews"), { id: "reviews", role: "gate-reviewer", model: FAKE_CODEX_REF, fallbacks: [fallback], driver: "codex" } as { id: string }];
		config.allow = [...new Set([...config.allow, "mock/*", FAKE_CODEX_REF])];
		writeFileSync(file, JSON.stringify(config));
	}
	const review = (id: string): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "cp_review", args: { job_id: id } }] });
	/** A finished review's run dir, events, routing payload, `verdict.json` review (if any) and `review-<n>.json`. */
	async function reviewRun(id: string, attempt = 1) {
		const file = join(b.home, paths.reviewFile(id, attempt));
		await waitFor(() => existsSync(file), Boolean, { timeoutMs: 180_000, what: `${id}'s review-${attempt}.json` });
		const run = join(b.home, paths.reviewRunDir(id, attempt));
		const events = readFileSync(join(run, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
		const routed = events.find((event) => event.type === "routing_resolved")?.payload;
		const verdictFile = join(b.home, paths.reviewVerdictFile(id, attempt));
		const verdict = existsSync(verdictFile) ? (JSON.parse(readFileSync(verdictFile, "utf8")) as { review: unknown }).review : undefined;
		return { run, events, routed, verdict, result: JSON.parse(readFileSync(file, "utf8")) as DiffVerdict };
	}
	return {
		b, agentDir, root, bin, state, codexHome, outside, nativeFile, env, record, job, report, reporting, setScript, awaitEnvelope, awaitFile, waitEvent, pause, runs, session, homeListing,
		lines, run, heldShipJob, reviewsRow, review, reviewRun,
	};
}
