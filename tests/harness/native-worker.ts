/**
 * Native worker parity fixture (WP0): a dispatchS29 home, native switches on, the claude mock provider behind a fake
 * HOME's settings, fake-claude as `claude` (the real one with CP_E2E_REAL_CLAUDE=1); denials, env keys, origin refs.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { TestContext } from "node:test";
import { type Delivery, type JobKind, LAYOUT, paths } from "../../src/contracts.ts";
import { NATIVE_SESSION_FILE, readNativeSession } from "../../src/drivers/claude-followup.ts";
import { SCAFFOLD_MANDATE_DEFAULTS } from "../../src/mandate-defaults.ts";
import { type ClaudeStep, FAKE_CLAUDE_AUTH_TOKEN, FAKE_NATIVE_MODEL, installClaudeStub, routeNativeModel, startClaudeMockProvider } from "./claude-mock-provider.ts";
import { dispatchS29 } from "./dispatch-s29.ts";
import { installGhStub } from "./gh-stub.ts";
import { readFleet, readRunEvents, routeDriver, type ScriptStep, waitFor } from "./index.ts";
import { REAL_CLAUDE } from "./native-parent.ts";

export { NATIVE } from "./native-parent.ts";
// An operator's custom list, not the old shipped default, so the workflows migration leaves it and the exclusion
// mechanics tests keep proving a configured `.github/workflows/` exclusion still binds.
export const EXCLUDE_PATHS = [".github/workflows/", "secrets/", "**/.env*", "private/"];

type Tool = { toolName: string; isError?: boolean; result: { details?: Record<string, unknown>; content?: unknown } };

/** A loopback web server (the external service at the boundary): every path serves `page`; `paths` logs each request. */
export async function startFakeWeb(t: TestContext, page: string): Promise<{ url: string; paths: string[] }> {
	const seen: string[] = [];
	const server = createServer((req, res) => {
		seen.push(req.url ?? "");
		res.writeHead(200, { "content-type": "text/plain" });
		res.end(page);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	t.after(() => new Promise<void>((done) => (server.closeAllConnections(), server.close(() => done()))));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths: seen };
}

/** `files` seed the project repo; `settingsEnv` joins the fake settings env (fake-claude's knobs); `run`'s extra env
 * joins the parent's, which the worker inherits; `mandateDefaults: "scaffold"` leaves the file to the parent's scaffold. */
export async function nativeWorkerHome(
	t: TestContext,
	script: readonly ClaudeStep[],
	opts: { files?: Record<string, string>; settingsEnv?: Record<string, string>; mandateDefaults?: "scaffold" } = {},
) {
	const b = await dispatchS29(t, { files: opts.files });
	if (opts.mandateDefaults !== "scaffold") writeFileSync(join(b.home, LAYOUT.mandateDefaultsFile), JSON.stringify({ ...SCAFFOLD_MANDATE_DEFAULTS, exclude_paths: EXCLUDE_PATHS }));
	writeFileSync(join(b.home, LAYOUT.data, "native.json"), JSON.stringify({ claude_research: true, claude_ship: true }));
	routeNativeModel(b.home);
	// The CLI is configured, not chosen per job (cp-qmry P3): the demo planner and implementer rows run claude.
	routeDriver(b.home, "claude", FAKE_NATIVE_MODEL);
	const claude = await startClaudeMockProvider(script);
	const fakeHome = mkdtempSync(join(tmpdir(), "cp-native-worker-home-"));
	const gh = installGhStub();
	t.after(async () => { await claude.close(); rmSync(fakeHome, { recursive: true, force: true }); rmSync(gh, { recursive: true, force: true }); });
	const settings = join(fakeHome, ".claude", "settings.json");
	mkdirSync(join(fakeHome, ".claude"), { recursive: true, mode: 0o700 });
	writeFileSync(settings, JSON.stringify({ env: { ...opts.settingsEnv, ANTHROPIC_BASE_URL: claude.url, ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_AUTH_TOKEN } }));
	// commitIdentityEnv reads git config, not the GIT_AUTHOR_* the preload exports: a native implementer needs this.
	writeFileSync(join(fakeHome, ".gitconfig"), "[user]\n\tname = native worker e2e\n\temail = native-worker@test.invalid\n");
	const bin = join(fakeHome, "bin");
	mkdirSync(bin);
	if (!REAL_CLAUDE) installClaudeStub(bin);
	const env = { HOME: fakeHome, PATH: [bin, gh, process.env.PATH ?? ""].join(delimiter) };
	const record = (id: string) => readFleet(b.home).jobs.find((job) => job.job_id === id);

	/** A ledger job and the parent step that dispatches it natively. */
	async function job(kind: JobKind, delivery: Delivery = "local", profile?: string) {
		const created = await b.ledger.create({ title: `native ${kind} ${Math.random()}`, project: "demo", delivery, kind });
		const dispatch = (task: string): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: {
			job_id: created.id, task, model: FAKE_NATIVE_MODEL, driver: "claude", queue: false, when_ready: false, ...(profile ? { profile } : {}),
		} }] });
		return { id: created.id, dispatch };
	}
	/** The parent step that waits (up to 60 s) for `id`'s envelope file. */
	const awaitEnvelope = (id: string): ScriptStep => {
		const file = join(b.home, paths.envelopeFile(id));
		return { kind: "tool_calls", calls: [{ name: "bash", args: { command: `for i in $(seq 300); do [ -f "${file}" ] && break; sleep 0.2; done; sleep 1` } }] };
	};
	/** Every `native_run` of `id`, once the first one is recorded. */
	const runs = async (id: string) => (await waitFor(() => readRunEvents(b.home, id).filter((event) => event.type === "native_run"), (found) => found.length > 0,
		{ timeoutMs: 60_000, what: `${id}'s native_run` })).map((event) => event.payload as { denials: number; denied: string[]; lockdown: string; report: boolean; stop?: string });
	/** The hook denials of `id`'s runs: their count, the first lines (`tool: reason`, paths redacted) and the runs. */
	const denials = async (id: string) => {
		const all = await runs(id);
		return { count: all.reduce((sum, run) => sum + run.denials, 0), lines: all.flatMap((run) => run.denied), runs: all };
	};
	/** The env key names fake-claude saw at its last spawn for `id`; undefined under the real CLI. */
	const spawnedEnvKeys = (id: string): string[] | undefined => {
		if (REAL_CLAUDE) return undefined;
		const scratch = readNativeSession(join(b.home, paths.runDir(id), NATIVE_SESSION_FILE)).scratch_dir;
		const lines = readFileSync(join(scratch, "config", "fake-claude", "spawns.jsonl"), "utf8").trim().split("\n");
		return (JSON.parse(lines.at(-1)!) as { envKeys: string[] }).envKeys;
	};
	/** Links `fixture` into the bin dir on every worker's PATH as `name` (a boundary stand-in, e.g. chromium). */
	const installStubBin = (name: string, fixture: string): void => symlinkSync(fixture, join(bin, name));
	/** Every ref on the project's scratch bare origin, `ref → sha`. */
	const originRefs = (): Record<string, string> => Object.fromEntries(execFileSync("git", ["ls-remote", "origin"], { cwd: b.clone, encoding: "utf8" })
		.trim().split("\n").filter(Boolean).map((line) => line.split("\t").reverse() as [string, string]));
	const run = async (steps: ScriptStep[], extraEnv: Record<string, string> = {}) => (await b.run(steps, { ...env, ...extraEnv }, undefined, 240_000)) as Tool[];
	const worktree = (id: string): string => {
		const found = record(id)?.worktree;
		if (!found || !existsSync(found)) throw new Error(`${id} has no worktree yet`);
		return found;
	};
	return { b, claude, settings, fakeHome, env, job, awaitEnvelope, runs, denials, spawnedEnvKeys, installStubBin, originRefs, run, record, worktree };
}
