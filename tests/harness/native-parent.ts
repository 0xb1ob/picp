/**
 * The native-Claude parent's e2e fixture: a driver-claude home with a registered project, a no-op script job under a
 * mandate, the claude mock provider, and `claude` on PATH — tests/fixtures/claude-stub.ts unless CP_E2E_REAL_CLAUDE=1.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { isoTimestamp, layoutForHome } from "../../src/contracts.ts";
import { type BridgeRelay, CpBridge } from "../../src/cp-bridge.ts";
import { whichAll } from "../../src/doctor.ts";
import { type ClaudeStep, installClaudeStub, type RecordedClaudeRequest, startClaudeMockProvider, subscriberEnv, FAKE_NATIVE_MODEL } from "./claude-mock-provider.ts";
import { createScratchHome, createScratchLedger, createScratchRepo, enableTreehouse, REPO_ROOT, type ScratchHome, treehouseAvailable } from "./index.ts";

/** The installed `claude` replaces the stub only on request; CI never has one. */
export const REAL_CLAUDE = process.env.CP_E2E_REAL_CLAUDE === "1";
const missing = [REAL_CLAUDE && whichAll("claude", process.env)[0] === undefined && "claude", !treehouseAvailable() && "treehouse"].filter(Boolean);
/** The skip reason for a case that dispatches through treehouse (or asked for the real CLI without one). */
export const NATIVE = missing.length > 0 ? `needs ${missing.join(" and ")} on PATH` : false;

export function scratchHome(parent?: Record<string, unknown>): ScratchHome {
	const home = createScratchHome();
	const data = join(home.path, layoutForHome("multi", home.path).data);
	mkdirSync(data, { recursive: true });
	if (parent) writeFileSync(join(data, "parent.json"), JSON.stringify(parent));
	return home;
}

/** Sets `values` on process.env for the test (the bridge's child inherits them); restored after. */
export function withEnv(t: TestContext, values: Record<string, string>): void {
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	Object.assign(process.env, values);
	t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
}

export const isModelCall = (request: RecordedClaudeRequest) => request.path.split("?")[0] === "/v1/messages" && Array.isArray(request.body.tools) && (request.body.tools as unknown[]).length > 0;
/** Every text a request's user turns carry, string or block content. */
export const userTexts = (request: RecordedClaudeRequest | undefined): string[] => ((request?.body.messages as Array<{ role: string; content: unknown }> | undefined) ?? [])
	.filter((message) => message.role === "user")
	.flatMap((message) => typeof message.content === "string" ? [message.content] : (message.content as Array<{ type?: string; text?: string }>).filter((block) => block.type === "text").map((block) => String(block.text)));
export const recordLines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; session_id?: string; text?: string });
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Live children of `pid` whose argv names a `claude` binary: the entry's CLI process. */
export function claudeChildren(pid: number): number[] {
	const out: number[] = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const ppid = Number(readFileSync(`/proc/${entry}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[1]);
			if (ppid === pid && /claude/.test(readFileSync(`/proc/${entry}/cmdline`, "utf8"))) out.push(Number(entry));
		} catch { /* gone between the listing and the read */ }
	}
	return out;
}

export type NativeFleet = Awaited<ReturnType<typeof nativeFleet>>;

/** A driver-claude home with a registered project, a no-op script job under a mandate, and the fake model behind a
 * fake HOME's Claude settings; the bridge stops before anything is removed. */
export async function nativeFleet(t: TestContext, script: (jobId: () => string) => ClaudeStep[]) {
	let jobId = "";
	const provider = await startClaudeMockProvider(script(() => jobId));
	const scratch = scratchHome({ driver: "claude" });
	const home = scratch.path;
	const repo = createScratchRepo({ name: "demo", files: { "scripts/noop.sh": "printf 'noop ok\\n'\nexit 0\n" } });
	const post = new CommandPost({ home, packageRoot: REPO_ROOT });
	await post.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	execFileSync("git", ["clone", "--quiet", repo.remote as string, post.registry.pathOf("demo")]);
	const pool = treehouseAvailable() ? enableTreehouse(post.registry.pathOf("demo")) : undefined;
	createScratchLedger({ home, knownProjects: ["demo"] });
	jobId = (await post.ledger().create({ title: "cp-poc-noop", project: "demo", kind: "ship", delivery: "local", scriptPath: "scripts/noop.sh" })).id;
	post.mandates.issue({ projects: ["demo"], objective: "native parent", job_ids: [jobId], expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 1, tokens: 100_000 }, job_cap: 2 });
	const fakeHome = mkdtempSync(join(tmpdir(), "cp-native-parent-home-"));
	mkdirSync(join(fakeHome, ".claude"), { recursive: true, mode: 0o700 });
	writeFileSync(join(fakeHome, ".claude", "settings.json"), JSON.stringify({ env: subscriberEnv(provider.url) }));
	// A gh whose main branch has no CI runs: the mandated project's CI watch reads it instead of waking a failure turn.
	const bin = join(fakeHome, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$*" in\n\t*actions/runs*) echo '{"total_count":0,"workflow_runs":[]}'; exit 0 ;;\n\t"api user --jq .login") echo cp-e2e-stub; exit 0 ;;\nesac\nexit 1\n`, { mode: 0o755 });
	if (!REAL_CLAUDE) installClaudeStub(bin);
	withEnv(t, { HOME: fakeHome, PATH: `${bin}:${process.env.PATH ?? ""}` });
	const bridge = new CpBridge();
	const relays: BridgeRelay[] = [];
	bridge.onRelay((relay) => relays.push(relay));
	t.after(async () => {
		try { await bridge.stop(); } finally {
			await provider.close();
			for (const cleanup of [() => pool?.cleanup(), () => repo.cleanup(), () => scratch.cleanup(), () => rmSync(fakeHome, { recursive: true, force: true })]) cleanup();
		}
	});
	const start = () => bridge.start({ home, mode: "multi", model: FAKE_NATIVE_MODEL, requestTimeoutMs: 30_000, settleTimeoutMs: 120_000 });
	return { home, post, jobId, provider, bridge, relays, start };
}
