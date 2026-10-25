/** Behavior 11, P9c: where a command's output goes (cp-8v1, cp-iuu), read off a real pi TUI on a pty (util-linux
 * `script`), a real RPC pi and `pi -p`; the consumer is what the operator or the calling program actually receives. */
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { paths } from "../../src/contracts.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, startRpc, waitFor } from "../harness/index.ts";

/** A seeded run log of `turns` turn_end events: what `/watch <job>` renders. */
function seedRun(home: string, job: string, turns: number): void {
	mkdirSync(join(home, paths.runDir(job)), { recursive: true });
	const event = (n: number) => JSON.stringify({ seq: n + 1, ts: `2026-08-27T11:00:${String(n).padStart(2, "0")}Z`, job_id: job, source: "pi", type: "turn_end", payload: {} });
	writeFileSync(join(home, paths.eventsFile(job)), `${Array.from({ length: turns }, (_, n) => event(n)).join("\n")}\n`);
}

async function bench(t: TestContext) {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript(`p9-output-${t.name.slice(0, 12).replace(/\W/g, "")}`, [{ kind: "text", text: "Ready." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	t.after(async () => { agent.cleanup(); await provider.stop(); home.cleanup(); });
	seedRun(home.path, "cp-watch", 40);
	seedRun(home.path, "cp-six", 4);
	const env = { ...agent.env, CP_HOME: home.path, CP_MODE: "multi" };
	const piArgs = ["--no-extensions", "--no-context-files", "-e", COMMAND_POST_EXTENSION, "--model", model];
	return { home: home.path, model, env, piArgs };
}

const strip = (text: string) => text.replace(/\x1b\[[0-9;?<>=]*[A-Za-z~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b[_P][^\x1b]*\x1b\\/g, "");

/** pi's interactive TUI on a pty; `run` types a command, presses Enter and returns the screen text drawn after it. */
function startTui(t: TestContext, cwd: string, env: NodeJS.ProcessEnv, args: string[]) {
	const command = ["pi", ...args].map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
	const child: ChildProcess = spawn("script", ["-qfec", command, "/dev/null"], { cwd, env: { ...process.env, ...env, TERM: "xterm-256color", COLUMNS: "160", LINES: "60" }, stdio: ["pipe", "pipe", "pipe"] });
	let raw = "";
	child.stdout?.on("data", (chunk) => { raw += String(chunk); });
	child.stderr?.on("data", (chunk) => { raw += String(chunk); });
	const exited = new Promise<void>((done) => child.once("exit", () => done()));
	t.after(async () => { child.kill("SIGTERM"); await exited; });
	const screen = () => strip(raw);
	return {
		screen,
		async run(text: string, until: (drawn: string) => boolean, what: string): Promise<string> {
			const mark = screen().length;
			child.stdin?.write(text);
			await new Promise((done) => setTimeout(done, 400));
			child.stdin?.write("\r");
			return waitFor(() => screen().slice(mark), until, { timeoutMs: 30_000, what });
		},
	};
}

// P9-output-tui: a long human payload is a durable entry collapsed to its head (/doctor) or, for /watch, to its newest
// tail under a pinned header; 6 lines, /status and any --json stay notices; a short legacy entry renders whole.
test("P9-output-tui: a real TUI files long output as a collapsed entry, /watch keeps its newest tail, short or --json output stays a notice", { timeout: 180_000 }, async (t) => {
	const b = await bench(t);
	const session = join(b.home, "tui.jsonl");
	writeFileSync(session, [
		{ type: "session", version: 3, id: "01a17215-6e55-70c5-a190-2a0f73e4c255", timestamp: "2026-10-01T00:00:00.000Z", cwd: b.home },
		{ type: "custom", customType: "cp-output", data: { source: "watch", text: "run cp-old · turns 2\n\n12:00:00 ⤶ turn 1 end", level: "info" }, id: "0a1b2c3d", parentId: null, timestamp: "2026-10-01T00:00:01.000Z" },
	].map((line) => JSON.stringify(line)).join("\n") + "\n");
	const tui = startTui(t, b.home, b.env, ["--session", session, ...b.piArgs]);
	const resumed = await waitFor(tui.screen, (text) => text.includes("12:00:00 ⤶ turn 1 end"), { timeoutMs: 60_000, what: "the resumed legacy entry" });
	assert.match(resumed, /\[watch\] 3 line\(s\)/);
	assert.doesNotMatch(resumed, /hidden above|more \(expand\)/, "a payload within the limit is never collapsed");

	const watch = await tui.run("/watch cp-watch", (text) => text.includes("turn 40 end"), "/watch entry");
	assert.match(watch, /\[watch\] 42 line\(s\)/);
	assert.match(watch, /… 36 older line\(s\) hidden above \(expand for the full log\)/);
	const at = (needle: string) => watch.indexOf(needle);
	assert.ok(at("run cp-watch · no projection yet") > at("hidden above"), "the header survives the collapse");
	assert.ok([37, 38, 39, 40].every((n, i, all) => at(`⤶ turn ${n} end`) > (i ? at(`⤶ turn ${all[i - 1]} end`) : at("run cp-watch"))), watch);
	assert.equal(at("⤶ turn 36 end"), -1, "older turns are hidden, newest last");

	const doctor = await tui.run("/doctor", (text) => /more \(expand\)/.test(text), "/doctor entry");
	const lines = Number(/\[doctor\] (\d+) line\(s\)/.exec(doctor)?.[1]);
	assert.ok(lines > 6, doctor);
	assert.match(doctor, new RegExp(`… ${lines - 6} more \\(expand\\)`), "other sources collapse to the head");
	assert.ok(doctor.indexOf("DOCTOR ") < doctor.indexOf("more (expand)"), "their summary line comes first");

	const six = await tui.run("/watch cp-six", (text) => text.includes("turn 4 end"), "/watch of exactly six lines");
	assert.doesNotMatch(six, /\[watch\]/, "a payload of exactly LONG_OUTPUT_LINES is a notice");
	const status = await tui.run("/status", (text) => text.includes("DRAIN "), "/status");
	assert.doesNotMatch(status, /\[status\]/, "a short notice is still a notice");
	const json = await tui.run("/status --json ", (text) => text.includes('"unclaimed"'), "/status --json");
	assert.ok(json.split('"').length > 40, "the JSON snapshot is long");
	assert.doesNotMatch(json, /\[status\]/, "--json always notifies, whatever its size");
});

// P9-output-headless: RPC keeps every payload a notice (hasUI, but the client is a program); with no UI (-p) the whole
// text goes to stderr and stdout stays the transcript's.
test("P9-output-headless: RPC receives long output as one notice and pi -p writes it to stderr, never stdout", { timeout: 120_000 }, async (t) => {
	const b = await bench(t);
	const rpc = startRpc({ cwd: b.home, env: b.env, args: ["--no-session", ...b.piArgs] });
	t.after(() => rpc.close().then(() => undefined));
	rpc.send({ id: "watch", type: "prompt", message: "/watch cp-watch" });
	const notice = await rpc.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).startsWith("run cp-watch"), 60_000);
	assert.equal(String(notice.message).split("\n").length, 42, "the whole log, uncollapsed");
	assert.match(String(notice.message), /⤶ turn 1 end[\s\S]*⤶ turn 40 end$/);
	rpc.send({ id: "json", type: "prompt", message: "/status --json" });
	const json = await rpc.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).includes('"unclaimed"'), 60_000);
	assert.ok(String(json.message).split("\n").length > 6, "a long --json snapshot is still one notice");

	for (const command of ["/watch cp-watch", "/status --json"]) {
		const printed = spawnSync("pi", ["-p", "--no-session", ...b.piArgs, command], { cwd: b.home, env: { ...process.env, ...b.env }, encoding: "utf8", timeout: 60_000 });
		assert.equal(printed.status, 0, printed.stderr);
		assert.equal(printed.stdout, "", `${command}: stdout belongs to the transcript`);
		assert.match(printed.stderr, command === "/status --json" ? /"unclaimed": \[\]/ : /⤶ turn 1 end[\s\S]*⤶ turn 40 end/, command);
	}
});
