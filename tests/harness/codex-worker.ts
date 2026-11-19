/**
 * Codex worker fixture (C1b): a dispatchS29 home with its own data/native.json (codex_research on unless `native`
 * says otherwise), a routing allow for `openai/gpt-picp-fake`, fake-codex and the fake `systemd-run` first on PATH,
 * and `CP_CODEX_HOME` on a temp dir holding the synthetic auth sentinel. The real `cp_dispatch` selects the driver.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { type Delivery, type JobKind, LAYOUT, paths } from "../../src/contracts.ts";
import { NATIVE_CODEX_SESSION_FILE, readNativeSession } from "../../src/drivers/claude-followup.ts";
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
	return { b, root, bin, state, codexHome, outside, nativeFile, env, record, job, report, reporting, setScript, awaitEnvelope, awaitFile, pause, runs, session, homeListing, lines, run };
}
