/**
 * Stand-in `codex` CLI for hosts without one: `--version`, `login status` and an `app-server` speaking the C0 subset of
 * the 0.170.0 wire. `FAKE_CODEX_SCRIPT` (JSON `{knobs, turns}`) plays the model; `FAKE_CODEX_STATE` holds threads and
 * logs (argv and env key names, never values). A failed hook fails open here, the worst case the CLI docs leave open.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type HookMode = "run" | "skip" | "kill" | "stall" | "unlink";
type Step =
	| { kind: "shell"; command: string; hook?: HookMode; background?: boolean }
	| { kind: "tool"; tool: string; arguments: unknown; hook?: HookMode }
	| { kind: "patch"; patch: string }
	| { kind: "message"; text: string }
	| { kind: "hold"; marker: string };
interface Knobs {
	version?: string;
	loginStatus?: number;
	trust?: "ignore";
	/** `lie` answers `terminated: true` and kills nothing, as 0.170.0 did for an interrupted sandboxed command. */
	terminate?: "noop" | "lie";
	/** `omit` lists background terminals with no `osPid`, as the real CLI does. */
	osPid?: "omit";
	/** `fail`: the stub systemd-run cannot reach a user manager (tests/fixtures/fake-systemd-run.ts). */
	containment?: "fail";
	usage?: boolean;
	account?: "none";
	extraHooks?: number;
	extraMcpServers?: number;
	extraSkills?: number;
	instructionSources?: number;
}
interface Script { knobs?: Knobs; turns?: Step[][] }
interface Totals { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number; totalTokens: number }

const STATE = process.env.FAKE_CODEX_STATE ?? "";
const script = JSON.parse(readFileSync(process.env.FAKE_CODEX_SCRIPT ?? "", "utf8")) as Script;
const knobs = script.knobs ?? {};
const FLOOR = "0.170.0";
const STEP_USAGE: Totals = { inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 5, totalTokens: 110 };
const HOOK_KEY = "/<session-flags>/config.toml:pre_tool_use:0:0";

const log = (file: string, entry: unknown) => {
	mkdirSync(STATE, { recursive: true });
	appendFileSync(join(STATE, file), `${JSON.stringify(entry)}\n`);
};
const argv = process.argv.slice(2);
log("spawns.jsonl", { pid: process.pid, argv, env: Object.keys(process.env).sort() });

if (argv[0] === "--version") {
	process.stdout.write(`codex-cli ${knobs.version ?? FLOOR}\n`);
	process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status") process.exit(knobs.loginStatus ?? 0);
if (argv[0] !== "app-server") {
	process.stderr.write(`fake codex: unsupported ${argv.join(" ")}\n`);
	process.exit(64);
}

const configs = argv.flatMap((arg, i) => (argv[i - 1] === "-c" ? [arg] : []));
const hookFlag = configs.find((c) => c.startsWith("hooks.PreToolUse="));
const hookCommand = hookFlag === undefined ? undefined : (JSON.parse(/command=("(?:[^"\\]|\\.)*")/.exec(hookFlag)?.[1] ?? '""') as string);
const hookTimeoutSec = Number(/timeout=(\d+)/.exec(hookFlag ?? "")?.[1] ?? 600);
const hookHash = `sha256:${createHash("sha256").update(`${hookCommand}\n${hookTimeoutSec}`).digest("hex")}`;
const trustFlag = /^hooks\.state=\{("(?:[^"\\]|\\.)*")=\{trusted_hash=("(?:[^"\\]|\\.)*")\}\}$/.exec(configs.find((c) => c.startsWith("hooks.state=")) ?? "");
const trusted = knobs.trust !== "ignore" && trustFlag !== null && JSON.parse(trustFlag[1] as string) === HOOK_KEY && JSON.parse(trustFlag[2] as string) === hookHash;

process.on("SIGTERM", () => process.exit(0));

const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method: string, params: unknown) => write({ method, params });
const pending = new Map<number, (result: unknown) => void>();
let serverIds = 0;
function ask(method: string, params: unknown): Promise<unknown> {
	const id = ++serverIds + 100_000;
	return new Promise((done) => {
		pending.set(id, done);
		write({ id, method, params });
	});
}

interface Thread { id: string; total: Totals; lastTurnId?: string; cwd: string; policy: string; replay: boolean }
let thread: Thread | undefined;
let interrupted = false;
let wakeHold: () => void = () => {};
let counter = 0;
const terminals = new Map<string, { pid: number; command: string; itemId: string }>();
const threadFile = (id: string) => join(STATE, "threads", `${id}.json`);
const save = (t: Thread) => {
	mkdirSync(join(STATE, "threads"), { recursive: true });
	writeFileSync(threadFile(t.id), JSON.stringify({ total: t.total, lastTurnId: t.lastTurnId }));
};
const zero = (): Totals => ({ inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 });

function nextTurn(): Step[] {
	const file = join(STATE, "cursor.json");
	const cursor = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as number) : 0;
	writeFileSync(file, JSON.stringify(cursor + 1));
	return script.turns?.[cursor] ?? [];
}

function threadResponse(t: Thread, params: Record<string, unknown>) {
	const mode = String(params.sandbox ?? "read-only");
	return {
		thread: { id: t.id }, approvalPolicy: t.policy, cwd: t.cwd, model: params.model ?? "gpt-picp-fake",
		sandbox: { type: mode === "read-only" ? "readOnly" : mode === "workspace-write" ? "workspaceWrite" : "dangerFullAccess" },
		instructionSources: Array.from({ length: knobs.instructionSources ?? 0 }, (_, i) => `${t.cwd}/AGENTS-${i}.md`),
	};
}

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
	if (method === "initialize") return { userAgent: `picp-fake/${knobs.version ?? FLOOR}`, codexHome: process.env.CODEX_HOME ?? "", platformFamily: "unix", platformOs: "linux" };
	if (method === "account/read") {
		return { account: knobs.account === "none" ? null : { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true };
	}
	if (method === "hooks/list") {
		const ours = hookCommand === undefined ? [] : [{
			key: HOOK_KEY, currentHash: hookHash, eventName: "preToolUse", source: "sessionFlags", trustStatus: trusted ? "trusted" : "untrusted",
			enabled: true, isManaged: false, timeoutSec: hookTimeoutSec, handlerType: "command", command: hookCommand, displayOrder: 0,
		}];
		const extra = Array.from({ length: knobs.extraHooks ?? 0 }, (_, i) => ({
			key: `/stray/hooks.json:pre_tool_use:${i}:0`, currentHash: "sha256:stray", eventName: "preToolUse", source: "user", trustStatus: "trusted",
			enabled: true, isManaged: false, timeoutSec: 600, handlerType: "command", command: "stray-hook-command", displayOrder: i + 1,
		}));
		return { data: [{ cwd: process.cwd(), hooks: [...ours, ...extra], errors: [], warnings: [] }] };
	}
	if (method === "mcpServerStatus/list") return { data: Array.from({ length: knobs.extraMcpServers ?? 0 }, (_, i) => ({ name: `stray-mcp-${i}`, tools: {}, resources: [], resourceTemplates: [], authStatus: "unsupported" })) };
	if (method === "skills/list") {
		const skills = Array.from({ length: knobs.extraSkills ?? 0 }, (_, i) => ({ name: `stray-skill-${i}`, scope: "user", enabled: true, description: "", path: "/stray" }));
		return { data: [{ cwd: process.cwd(), skills, errors: [] }] };
	}
	if (method === "thread/start") {
		thread = { id: `thr_${process.pid}_${Date.now()}`, total: zero(), cwd: String(params.cwd), policy: String(params.approvalPolicy), replay: false };
		save(thread);
		return threadResponse(thread, params);
	}
	if (method === "thread/resume") {
		const id = String(params.threadId);
		const stored = JSON.parse(readFileSync(threadFile(id), "utf8")) as { total: Totals; lastTurnId?: string };
		thread = { id, total: stored.total, lastTurnId: stored.lastTurnId, cwd: String(params.cwd), policy: String(params.approvalPolicy), replay: true };
		return threadResponse(thread, params);
	}
	if (method === "thread/delete") {
		rmSync(threadFile(String(params.threadId)), { force: true });
		return {};
	}
	if (method === "turn/start") {
		const id = `turn_${process.pid}_${++counter}`;
		setImmediate(() => void runTurn(id, nextTurn()));
		return { turn: { id, status: "inProgress", items: [] } };
	}
	if (method === "turn/interrupt") {
		interrupted = true;
		wakeHold();
		return {};
	}
	if (method === "thread/backgroundTerminals/list") {
		return { data: [...terminals].map(([processId, t]) => ({ processId, ...(knobs.osPid === "omit" ? {} : { osPid: t.pid }), command: t.command, cwd: thread?.cwd ?? "", itemId: t.itemId })) };
	}
	if (method === "thread/backgroundTerminals/terminate") {
		const entry = terminals.get(String(params.processId));
		if (entry !== undefined && knobs.terminate === "lie") return { terminated: true };
		if (entry === undefined || knobs.terminate === "noop") return { terminated: false };
		try {
			process.kill(entry.pid, "SIGKILL");
		} catch {
			// Already gone.
		}
		terminals.delete(String(params.processId));
		return { terminated: true };
	}
	throw Object.assign(new Error(`fake codex: no method ${method}`), { code: -32601 });
}

function socketOf(command: string): string | undefined {
	return /'([^']*)' \d+$/.exec(command)?.[1];
}

/** Runs the configured hook as the CLI would: exit 2 blocks; any other failure fails open. */
async function runHook(tool: string, input: unknown, useId: string, turnId: string, mode: HookMode = "run"): Promise<"allow" | "blocked"> {
	if (hookCommand === undefined || !trusted || mode === "skip") return "allow";
	const runId = `hook_${++counter}`;
	notify("hook/started", { threadId: thread?.id, turnId, run: { id: runId, status: "running", eventName: "preToolUse" } });
	if (mode === "unlink") {
		const socket = socketOf(hookCommand);
		if (socket !== undefined && existsSync(socket)) unlinkSync(socket);
	}
	const child: ChildProcess = spawn("sh", ["-c", `exec ${hookCommand}`], { cwd: thread?.cwd, stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => (stderr += chunk));
	child.stdin?.on("error", () => {});
	const stdin = JSON.stringify({
		session_id: thread?.id, cwd: thread?.cwd, hook_event_name: "PreToolUse", model: "gpt-picp-fake", permission_mode: thread?.policy,
		turn_id: turnId, tool_name: tool, tool_use_id: useId, tool_input: input,
	});
	if (mode === "kill") child.kill("SIGKILL");
	else if (mode === "stall") child.stdin?.write(stdin);
	else child.stdin?.end(stdin);
	const timer = setTimeout(() => child.kill("SIGKILL"), hookTimeoutSec * 1000);
	const [code, signal] = await new Promise<[number | null, string | null]>((done) => child.once("exit", (c, s) => done([c, s])));
	clearTimeout(timer);
	const status = code === 0 ? "completed" : code === 2 ? "blocked" : "failed";
	log("hooks.jsonl", { tool, mode, status, code, signal, stderr });
	notify("hook/completed", { threadId: thread?.id, turnId, run: { id: runId, status, eventName: "preToolUse" } });
	return status === "blocked" ? "blocked" : "allow";
}

async function shellStep(step: Extract<Step, { kind: "shell" }>, turnId: string): Promise<void> {
	const itemId = `item_${++counter}`;
	if ((await runHook("Bash", { command: step.command }, itemId, turnId, step.hook)) === "blocked") return;
	const cwd = thread?.cwd ?? process.cwd();
	const base = { type: "commandExecution", id: itemId, command: step.command, cwd, commandActions: [] };
	if (thread?.policy !== "never") {
		const answer = (await ask("item/commandExecution/requestApproval", { itemId, threadId: thread?.id, turnId, command: step.command, cwd, startedAtMs: Date.now() })) as { decision?: unknown } | undefined;
		if (answer?.decision !== "accept") {
			notify("item/completed", { threadId: thread?.id, turnId, item: { ...base, status: "declined" } });
			return;
		}
	}
	const processId = `proc_${counter}`;
	log("executed.jsonl", { command: step.command });
	if (step.background === true) {
		const child = spawn("sh", ["-c", `exec ${step.command}`], { cwd, detached: true, stdio: "ignore" });
		child.unref();
		terminals.set(processId, { pid: child.pid ?? -1, command: step.command, itemId });
		log("pids.jsonl", { pid: child.pid });
		notify("item/started", { threadId: thread?.id, turnId, item: { ...base, status: "inProgress", processId } });
		return;
	}
	notify("item/started", { threadId: thread?.id, turnId, item: { ...base, status: "inProgress", processId } });
	const run = spawnSync("sh", ["-c", step.command], { cwd, encoding: "utf8" });
	notify("item/completed", { threadId: thread?.id, turnId, item: { ...base, status: run.status === 0 ? "completed" : "failed", exitCode: run.status, aggregatedOutput: `${run.stdout}${run.stderr}` } });
}

async function runStep(step: Step, turnId: string): Promise<void> {
	if (step.kind === "shell") return shellStep(step, turnId);
	if (step.kind === "message") {
		notify("item/completed", { threadId: thread?.id, turnId, item: { type: "agentMessage", id: `item_${++counter}`, text: step.text } });
		return;
	}
	if (step.kind === "patch") {
		await ask("item/fileChange/requestApproval", { itemId: `item_${++counter}`, threadId: thread?.id, turnId });
		return;
	}
	if (step.kind === "hold") {
		writeFileSync(join(STATE, step.marker), "");
		if (!interrupted) await new Promise<void>((done) => (wakeHold = done));
		return;
	}
	const callId = `call_${++counter}`;
	if ((await runHook(step.tool, step.arguments, callId, turnId, step.hook)) === "blocked") return;
	const result = await ask("item/tool/call", { tool: step.tool, arguments: step.arguments, callId, threadId: thread?.id, turnId });
	log("tool-results.jsonl", { tool: step.tool, result });
	notify("item/completed", { threadId: thread?.id, turnId, item: { type: "dynamicToolCall", id: callId, tool: step.tool, arguments: step.arguments, status: "completed" } });
}

function addUsage(t: Thread, turnId: string, last: Totals): void {
	for (const key of Object.keys(t.total) as Array<keyof Totals>) t.total[key] += last[key];
	t.lastTurnId = turnId;
	save(t);
	notify("thread/tokenUsage/updated", { threadId: t.id, turnId, tokenUsage: { total: { ...t.total }, last, modelContextWindow: 475_000 } });
}

async function runTurn(turnId: string, steps: Step[]): Promise<void> {
	const t = thread as Thread;
	interrupted = false;
	notify("turn/started", { threadId: t.id, turn: { id: turnId, status: "inProgress", items: [] } });
	const usage = knobs.usage !== false;
	if (t.replay && usage && t.lastTurnId !== undefined) {
		notify("thread/tokenUsage/updated", { threadId: t.id, turnId: t.lastTurnId, tokenUsage: { total: { ...t.total }, last: zero() } });
	}
	t.replay = false;
	for (const step of steps) {
		if (interrupted) break;
		await runStep(step, turnId);
		if (usage) addUsage(t, turnId, STEP_USAGE);
	}
	if (usage) notify("thread/tokenUsage/updated", { threadId: t.id, turnId, tokenUsage: { total: { ...t.total }, last: STEP_USAGE } });
	notify("turn/completed", { threadId: t.id, turn: { id: turnId, status: interrupted ? "interrupted" : "completed", items: [] } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	for (let cut = buffer.indexOf("\n"); cut >= 0; cut = buffer.indexOf("\n")) {
		const line = buffer.slice(0, cut);
		buffer = buffer.slice(cut + 1);
		if (line.trim() === "") continue;
		const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
		if (message.method !== undefined) log("rpc.jsonl", { pid: process.pid, method: message.method });
		if (message.id !== undefined && message.method === undefined) {
			pending.get(message.id)?.(message.result ?? { error: message.error });
			pending.delete(message.id);
		} else if (message.id !== undefined && message.method !== undefined) {
			const id = message.id;
			handle(message.method, message.params ?? {}).then(
				(result) => write({ id, result }),
				(error: Error & { code?: number }) => write({ id, error: { code: error.code ?? -32603, message: error.message } }),
			);
		}
	}
});
process.stdin.on("end", () => process.exit(0));
