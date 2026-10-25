/**
 * P12 (behavior 16), slice 2: the tunnel through real processes — `bin/cp-tunnel`, `bin/cp-daemon` with its inner,
 * cp-view and device-notify, and a stand-in cloudflared on PATH (never the real one, never the network).
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { pathToFileURL } from "node:url";
import { initPush } from "../../src/push/keys.ts";
import { Ecc, QrCode } from "../../src/qr/code.ts";
import { daemonPaths } from "../../src/service/daemon-files.ts";
import { tunnelConfigFile, tunnelRuntimeFile } from "../../src/service/daemon-tunnel-files.ts";
import { DNS_SCOPE, TUNNEL_SCOPE, tunnelNameFor } from "../../src/tunnel/cloudflare-api.ts";
import { QUIET_ZONE } from "../../src/tunnel/qr.ts";
import { pushConfigFile, vapidKeyFile } from "../../src/viewer/push-files.ts";
import { createScratchHome, REPO_ROOT } from "../harness/index.ts";
import { call } from "../harness/remote.ts";

const QUICK = "https://amber-otter.trycloudflare.com";
const SECRET = "eyJhIjoiMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MCJ9";
const TOKEN = "eyJhIjoic2VjcmV0LXR1bm5lbC10b2tlbiJ9";
/** Env for a child preloaded with one of tests/harness's `--import` fakes (process-clock.ts, fake-fetch.ts). */
const preload = (file: string, vars: Record<string, string>) => ({ ...vars, NODE_OPTIONS: `--import ${pathToFileURL(join(REPO_ROOT, "tests/harness", file)).href}` });

/** The stand-in: probes answer like cloudflared 2026.10; a run waits for `go`, then prints a quick banner and more. */
const CLOUDFLARED = `#!/bin/sh
F=$(dirname "$0")
echo "$$ $*" >> "$F/calls"
case "$*" in
  --version) echo "cloudflared version 2026.10.0 (built 2026-10-01)"; exit 0 ;;
  "tunnel --help") echo "  --no-autoupdate  --url value  --http-host-header value"; exit 0 ;;
  "tunnel run --help") echo "  --token-file value"; exit 0 ;;
esac
if [ -e "$F/stubborn" ]; then trap '' TERM; else trap 'exit 0' TERM; fi
echo 'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp' >&2
echo "INF see https://evil.trycloudflare.com.example.net/" >&2
for u in http://abc.trycloudflare.com https://a.b.trycloudflare.com https://-abc.trycloudflare.com https://ABC.trycloudflare.com/x; do echo "INF $u" >&2; done
echo "INF Registered tunnel connection connIndex=9" >&2
while [ ! -e "$F/go" ]; do sleep 0.1; done
printf '\\033[31mERR\\033[0m bad\\ttoken ${SECRET}\\r\\n' >&2
echo "INF |  ${QUICK}  |" >&2
echo "INF Registered tunnel connection connIndex=0" >&2
echo "INF |  https://second-origin.trycloudflare.com  |" >&2
echo "INF Registered tunnel connection connIndex=1" >&2
i=0; while [ $i -lt 250 ]; do echo "INF line $i" >&2; i=$((i+1)); done
while :; do
  if [ -e "$F/crash" ]; then rm -f "$F/crash"; exit 1; fi
  sleep 0.2
done
`;

const freePort = (): Promise<number> =>
	new Promise((done) => {
		const probe = createServer().listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => done(port));
		});
	});

async function until<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, what: string, ms = 30_000): Promise<T> {
	let last: T | undefined;
	for (const end = Date.now() + ms; Date.now() < end; await new Promise((done) => setTimeout(done, 100))) {
		last = await read();
		if (ok(last)) return last;
	}
	throw new Error(`timed out waiting for ${what}; last = ${JSON.stringify(last)}`);
}

const json = (file: string): Record<string, unknown> | undefined => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

type Run = { code: number; stdout: string; stderr: string; tty: string };

/**
 * A scratch home and app: the real daemon, inner, viewer and sender sources, stand-ins for the parent and the
 * periodic jobs (the tunnel never consults them), `data/daemon.json` unless `daemon: false`, nothing started.
 */
async function rig(t: TestContext, { daemon = true, gated = false, cloudflared = true } = {}) {
	const scratch = createScratchHome();
	const home = scratch.path, paths = daemonPaths(home);
	const app = join(home, "app"), fake = join(home, "fake-bin");
	for (const dir of [paths.dataDir, paths.stateDir, join(app, "src/service"), join(app, "src/viewer"), join(app, "src/push"), fake]) mkdirSync(dir, { recursive: true });
	for (const file of ["src/service/daemon.ts", "src/service/daemon-runtime.ts", "src/viewer/cli.ts", "src/push/device-notify.ts"]) symlinkSync(join(REPO_ROOT, file), join(app, file));
	for (const role of ["supervise", "health", "update"]) writeFileSync(join(app, `src/service/${role}.ts`), 'process.on("SIGTERM", () => process.exit(0));\nsetInterval(() => {}, 1 << 30);\n');
	if (cloudflared) writeFileSync(join(fake, "cloudflared"), CLOUDFLARED, { mode: 0o755 });
	if (!gated) writeFileSync(join(fake, "go"), "");
	const [localPort, remotePort] = [await freePort(), await freePort()];
	// Without the stand-in, PATH holds only node and dirname, so a cloudflared installed on this host is never found.
	if (!cloudflared) for (const [tool, target] of [["node", process.execPath], ["dirname", "/usr/bin/dirname"]]) symlinkSync(target!, join(fake, tool!));
	const PATH = cloudflared ? `${fake}:${dirname(process.execPath)}:/usr/bin:/bin` : fake;
	if (daemon) writeFileSync(paths.config, JSON.stringify({ schema_version: 1, generated_by: "cp-install", backend: "detached", node: process.execPath, app, home, path: PATH, port: localPort, viewer_host: "127.0.0.1" }));
	const env = { PATH, HOME: home };
	const cli = (bin: string, argv: string[], { tty = false, input, env: extra = {} }: { tty?: boolean; input?: string; env?: Record<string, string> } = {}) =>
		new Promise<Run>((done) => {
			const command = [join(REPO_ROOT, "bin", bin), ...argv, "--home", home];
			const out = join(home, "run.out"), err = join(home, "run.err");
			// Under `script` the command gets a pty as its controlling terminal; its stdout and stderr stay files.
			const child: ChildProcess = tty
				? spawn("script", ["-qfec", `${command.map((part) => `'${part}'`).join(" ")} >${out} 2>${err}`, "/dev/null"], { env, stdio: ["pipe", "pipe", "pipe"] })
				: spawn(command[0]!, command.slice(1), { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "", stderr = "";
			child.stdout!.on("data", (chunk) => (stdout += chunk));
			child.stderr!.on("data", (chunk) => (stderr += chunk));
			if (tty) child.stdin!.end(input ?? "");
			child.once("exit", (code) => {
				if (!tty) return done({ code: code ?? 1, stdout, stderr, tty: "" });
				const exit = /COMMAND_EXIT_CODE="(\d+)"/.exec(stdout)?.[1];
				done({ code: Number(exit ?? code ?? 1), stdout: readFileSync(out, "utf8"), stderr: readFileSync(err, "utf8"), tty: stdout });
			});
		});
	const tunnel = (...argv: string[]) => cli("cp-tunnel", argv);
	t.after(async () => {
		await cli("cp-daemon", ["stop"]);
		scratch.cleanup();
	});
	const runtime = () => json(tunnelRuntimeFile(paths.stateDir));
	const config = () => json(tunnelConfigFile(paths.dataDir));
	const log = () => (existsSync(paths.log) ? readFileSync(paths.log, "utf8") : "");
	/** The stand-in's tunnel runs so far: `[pid, argv]`. */
	const runs = () => (existsSync(join(fake, "calls")) ? readFileSync(join(fake, "calls"), "utf8") : "").split("\n").filter((line) => line.includes(" tunnel --no-autoupdate")).map((line) => [Number(line.split(" ")[0]), line.slice(line.indexOf(" ") + 1)] as const);
	const settled = (state: string, revision: number) => until(runtime, (r) => r?.state === state && r.revision === revision, `${state} at revision ${revision}\n${log()}`, 60_000);
	return { home, paths, fake, localPort, remotePort, env, cli, tunnel, runtime, config, log, runs, settled, touch: (name: string) => writeFileSync(join(fake, name), "") };
}

const quickArgv = (port: number) => `tunnel --no-autoupdate --url http://127.0.0.1:${port} --http-host-header 127.0.0.1:${port}`;

test("P12b-lifecycle: cp-daemon runs the quick, then the named cloudflared for cp-tunnel up, restarts a crash and stops on down", async (t) => {
	const s = await rig(t, { gated: true });
	assert.equal((await s.cli("cp-daemon", ["start"])).code, 0, s.log());
	await new Promise((done) => setTimeout(done, 6_000)); // past the inner's first 5 s tick
	assert.doesNotMatch((await s.cli("cp-daemon", ["status"])).stdout, /device-notify/, "a plain home runs no pairing-alert sender");
	assert.equal(existsSync(tunnelRuntimeFile(s.paths.stateDir)), false, "a home with no tunnel config keeps no runtime record");
	assert.deepEqual(s.runs(), []);

	const up = s.tunnel("up", "--remote-port", String(s.remotePort));
	await until(s.log, (text) => text.includes("evil.trycloudflare.com.example.net"), "the stand-in's first lines");
	assert.match((await s.tunnel("status")).stdout, /^cloudflared: starting pid \d+, origin none, generation 0, revision 1$/m, "a connection before any origin is not running");
	s.touch("go");
	const first = await up;
	assert.equal(first.code, 1, "up, but no terminal for the pairing link");
	assert.equal(first.stdout, `${QUICK}\n`, "stdout is the origin alone");
	assert.match(first.stderr, new RegExp(`cloudflared 2026\\.10\\.0 \\(path: ${s.fake}/cloudflared\\)`));
	assert.match(first.stderr, /quick tunnel up \(generation 1\)\. Its hostname changes whenever cloudflared restarts/);
	assert.match(first.stderr, /pairing display refused: no controlling terminal \(\/dev\/tty: ENXIO\); run cp-tunnel pair from an interactive terminal/);
	assert.deepEqual(s.config(), { schema_version: 1, enabled: true, mode: "quick", port: s.remotePort, binary: `${s.fake}/cloudflared`, revision: 1 });
	assert.equal(statSync(tunnelConfigFile(s.paths.dataDir)).mode & 0o777, 0o600);
	const [[pid, argv]] = s.runs() as [[number, string]];
	assert.equal(argv, quickArgv(s.remotePort), "the fixed argv, no shell");
	assert.deepEqual({ ...s.runtime(), updated_at: "", started_at: "" }, { schema_version: 1, origin: QUICK, generation: 1, revision: 1, state: "running", mode: "quick", port: s.remotePort, pid, binary: `${s.fake}/cloudflared`, argv: argv.split(" "), started_at: "", updated_at: "" });
	assert.equal(statSync(tunnelRuntimeFile(s.paths.stateDir)).mode & 0o777, 0o600);
	await until(s.log, (text) => /further output of pid \d+ suppressed/.test(text), "the bounded child log");
	const lines = s.log().split("\n").filter((line) => line.includes("tunnel: cloudflared: "));
	assert.equal(lines.length, 201, "200 child lines, then one suppressed line");
	assert.ok(lines.some((line) => line.endsWith("tunnel: cloudflared: ERR bad token [redacted]")), "escapes and control bytes gone, the token redacted");
	assert.ok(!s.log().includes(SECRET));
	assert.equal(s.log().match(/tunnel: running on /g)?.length, 1, "the first origin of a run is the run's origin");
	assert.match((await s.cli("cp-daemon", ["status"])).stdout, /^device-notify: running pid \d+/m, "a tunnel config turns the sender on");
	assert.equal(existsSync(pushConfigFile(s.paths.dataDir)), false, "quick never touches push");
	assert.deepEqual((await s.tunnel("status")).stdout.split("\n").filter(Boolean), [
		`config: enabled, quick, port ${s.remotePort}, revision 1`,
		`cloudflared: running pid ${pid}, origin ${QUICK}, generation 1, revision 1`,
		`viewer: remote listener open for ${QUICK} (generation 1, revision 1)`,
	]);

	// The same command line again is a new revision only: acknowledged, never restarted.
	assert.equal((await s.tunnel("up")).code, 1);
	await s.settled("running", 2);
	assert.deepEqual([s.runs().length, s.runtime()?.pid], [1, pid]);

	// Named: the token travels as a 0600 file path only; a new command line replaces the child, a new origin bumps generation.
	initPush({ dataDir: s.paths.dataDir, origin: "https://old.example.com" });
	const pushBytes = readFileSync(pushConfigFile(s.paths.dataDir)), keyBytes = readFileSync(vapidKeyFile(s.paths.dataDir));
	writeFileSync(join(s.home, "given-token"), `${TOKEN}\n`);
	const named = await s.tunnel("up", "--hostname", "CP.Example.com", "--token-file", join(s.home, "given-token"));
	assert.equal(named.stdout, "https://cp.example.com\n", named.stderr);
	assert.equal(alive(pid), false, "the quick child exited");
	const stored = join(s.paths.dataDir, "tunnel", "token");
	assert.deepEqual(s.config(), { schema_version: 1, enabled: true, mode: "named", port: s.remotePort, binary: `${s.fake}/cloudflared`, hostname: "cp.example.com", token_file: stored, revision: 3 });
	assert.deepEqual([readFileSync(stored, "utf8"), statSync(stored).mode & 0o777], [TOKEN, 0o600]);
	assert.equal(s.runs().at(-1)?.[1], `tunnel --no-autoupdate run --token-file ${stored}`);
	assert.deepEqual([s.runtime()?.origin, s.runtime()?.generation], ["https://cp.example.com", 2]);
	assert.match(named.stderr, /push kept on https:\/\/old\.example\.com; cp-tunnel up --push-origin accept points it at https:\/\/cp\.example\.com/);
	assert.deepEqual([readFileSync(pushConfigFile(s.paths.dataDir)), readFileSync(vapidKeyFile(s.paths.dataDir))], [pushBytes, keyBytes], "no terminal: push is kept byte for byte");

	// At the terminal: keep never asks; a typed y moves push to the tunnel origin and keeps the keys.
	const keep = await s.cli("cp-tunnel", ["up", "--push-origin", "keep"], { tty: true });
	assert.doesNotMatch(keep.tty, /Switch them/);
	assert.equal(s.config()?.token_file, stored, "a bare up keeps the named mode, hostname and stored token");
	const before = json(pushConfigFile(s.paths.dataDir));
	const typed = await s.cli("cp-tunnel", ["up"], { tty: true, input: "y\n" });
	assert.match(typed.tty, /Push notifications use https:\/\/old\.example\.com\. Switch them to https:\/\/cp\.example\.com\? The keys stay/);
	assert.match(typed.stderr, /push now uses https:\/\/cp\.example\.com \(keys kept\)/);
	assert.deepEqual([json(pushConfigFile(s.paths.dataDir))?.origin, json(pushConfigFile(s.paths.dataDir))?.public_key], ["https://cp.example.com", before?.public_key]);
	assert.deepEqual(readFileSync(vapidKeyFile(s.paths.dataDir)), keyBytes);
	initPush({ dataDir: s.paths.dataDir, origin: "https://old.example.com" });
	const flag = await s.tunnel("up", "--push-origin", "accept");
	assert.match(flag.stderr, /push now uses https:\/\/cp\.example\.com \(keys kept\)/, "the flag accepts without asking");
	assert.deepEqual([json(pushConfigFile(s.paths.dataDir))?.public_key, readFileSync(vapidKeyFile(s.paths.dataDir))], [before?.public_key, keyBytes]);
	for (const text of [named.stdout, named.stderr, keep.stdout, keep.stderr, typed.stdout, typed.stderr, flag.stdout, flag.stderr, s.log(), JSON.stringify(s.runtime()), JSON.stringify(s.config()), readFileSync(join(s.fake, "calls"), "utf8")]) {
		assert.ok(!text.includes(TOKEN) && !/\bsudo\b/.test(text), text);
	}

	// A crash restarts on the supervisor's backoff and keeps the named origin's generation.
	const named1 = s.runtime()?.pid as number;
	s.touch("crash");
	const restarting = await until(s.runtime, (r) => r?.state === "restarting", "restarting");
	assert.match(String(restarting?.detail), new RegExp(`cloudflared pid ${named1} exited \\(1\\); restart 1 in 5s`));
	assert.deepEqual([restarting?.pid, restarting?.origin], [undefined, "https://cp.example.com"], "a stopped tunnel keeps its last binding");
	const back = await until(s.runtime, (r) => r?.state === "running", "running again", 20_000);
	assert.deepEqual([back?.generation, back?.pid !== named1], [2, true], "the same named origin keeps its sessions");

	const down = await s.tunnel("down");
	assert.equal(down.code, 0, down.stderr);
	assert.match(down.stdout, /tunnel down: cloudflared exited and the remote listener is closed; the local dashboard is unchanged/);
	assert.deepEqual([s.config()?.enabled, s.config()?.revision], [false, 7]);
	assert.deepEqual([s.runtime()?.state, s.runtime()?.revision, s.runtime()?.pid], ["stopped", 7, undefined]);
	assert.equal(alive(back?.pid as number), false, "the exit was observed, so the process is gone");
	assert.match((await s.cli("cp-daemon", ["status"])).stdout, /^device-notify: running/m, "alerts outlive down");

	assert.equal((await s.cli("cp-daemon", ["stop"])).code, 0);
	const off = await s.tunnel("down");
	assert.deepEqual([off.code, s.config()?.revision], [0, 8]);
	assert.match(off.stdout, /cp-daemon is not running, so it stays off/);
	assert.match((await s.cli("cp-daemon", ["status"])).stdout, /^cp-daemon: not running/m, "down never starts the daemon");
	assert.match((await s.tunnel("status")).stdout, /^config: disabled, named cp\.example\.com, port \d+, revision 8$/m);
});

test("P12b-pair: up starts a stopped cp-daemon; the link and QR reach the terminal only; devices and revoke use the owner socket", async (t) => {
	const s = await rig(t);
	const up = await s.cli("cp-tunnel", ["up", "--level", "view", "--remote-port", String(s.remotePort)], { tty: true });
	assert.equal(up.code, 0, `${up.stderr}\n${s.log()}`);
	assert.match(up.stderr, /cp-daemon is not running; starting it/);
	assert.equal(up.stdout, `${QUICK}\n`);
	assert.match(up.stderr, /one View-only pairing link is on the terminal, valid until /);
	const link = new RegExp(`Pairing link \\(secret, one use, five minutes\\): (${QUICK}/pair#([A-Za-z0-9_-]+))`).exec(up.tty);
	assert.ok(link, up.tty);
	assert.ok(!up.stdout.includes(link[2]!) && !up.stderr.includes(link[2]!) && !s.log().includes(link[2]!), "the code is on the terminal only");

	// The drawing is the code: black on white, a four-module quiet zone, two module rows per line, module for module.
	const code = QrCode.encodeText(link[1]!, Ecc.LOW);
	const span = code.size + QUIET_ZONE * 2;
	const drawn = up.tty.split(/\r?\n/).filter((line) => line.startsWith("\x1b[30;47m"));
	assert.equal(drawn.length, Math.ceil(span / 2));
	const cells = drawn.map((line) => {
		assert.ok(line.endsWith("\x1b[0m"));
		return [...line.slice("\x1b[30;47m".length, -"\x1b[0m".length)];
	});
	for (const row of cells) assert.equal(row.slice(0, QUIET_ZONE).join("") + row.slice(-QUIET_ZONE).join("") + String(row.length), `${" ".repeat(QUIET_ZONE * 2)}${span}`);
	assert.equal(cells.slice(0, QUIET_ZONE / 2).flat().join("").trim(), "");
	for (let y = 0; y < code.size; y += 1) {
		for (let x = 0; x < code.size; x += 1) {
			const cell = cells[Math.floor((y + QUIET_ZONE) / 2)]?.[x + QUIET_ZONE];
			const dark = cell === "█" || ((y + QUIET_ZONE) % 2 === 0 ? cell === "▀" : cell === "▄");
			assert.equal(dark, code.getModule(x, y), `module ${x},${y}`);
		}
	}

	const claimed = await call(s.remotePort, "/api/pair/claim", { method: "POST", headers: { origin: QUICK, "content-type": "application/json", "cf-connecting-ip": "198.51.100.7" }, body: JSON.stringify({ code: link[2], name: "Phone", level: "view" }) });
	assert.equal(claimed.status, 200, claimed.text);
	const listed = await s.tunnel("devices");
	assert.match(listed.stdout, /^dev-[0-9a-f]{16} {2}"Phone" {2}view {2}created \S+ {2}last seen \S+ {2}active\n0 unclaimed pairing code\(s\)\n$/);
	const id = listed.stdout.split(" ")[0];

	const refused = await s.tunnel("pair");
	assert.equal(refused.code, 1);
	assert.match(refused.stderr, /pairing display refused: no controlling terminal/);
	assert.match((await s.tunnel("devices")).stdout, /^0 unclaimed pairing code\(s\)$/m, "no code is issued without a display");
	const paired = await s.cli("cp-tunnel", ["pair"], { tty: true });
	assert.equal(paired.code, 0, paired.stderr);
	assert.match(paired.stderr, /one Full-control pairing link is on the terminal/);
	assert.match((await s.tunnel("devices")).stdout, /^1 unclaimed pairing code\(s\)$/m);

	const revoked = await s.tunnel("revoke", "Phone");
	assert.equal(revoked.code, 0, revoked.stderr);
	assert.match(revoked.stdout, new RegExp(`^revoked ${id} "Phone" at \\S+\\n$`));
	assert.match((await s.tunnel("devices")).stdout, new RegExp(`^${id} {2}"Phone" .* revoked \\S+$`, "m"));
	const unknown = await s.tunnel("revoke", "Tablet");
	assert.equal(unknown.code, 1);
	assert.equal(unknown.stderr, "cp-tunnel revoke: not_found\n");

	// Paired devices alone keep the remote feature on: with no tunnel config a restarted cp-daemon still runs the sender.
	assert.equal((await s.cli("cp-daemon", ["stop"])).code, 0);
	rmSync(tunnelConfigFile(s.paths.dataDir));
	assert.equal((await s.cli("cp-daemon", ["start"])).code, 0);
	assert.match((await s.cli("cp-daemon", ["status"])).stdout, /^device-notify: running pid \d+/m);
});

test("P12b-refusals: bad arguments, flags or records, no cp-daemon config, a held lock and a failed daemon start are named; nothing half-written", async (t) => {
	const none = await rig(t, { daemon: false });
	assert.match((await none.tunnel("up")).stderr, /cp-daemon runs the tunnel, and this home has none .*: run cp-install first/);
	const s = await rig(t);
	for (const argv of [[], ["launch"], ["pair", "--hostname", "x.example.com"], ["pair", "--api-token-file", "/x"], ["devices", "--level", "view"], ["revoke"], ["status", "extra"], ["up", "--level", "admin"], ["up", "--push-origin", "maybe"], ["up", "--bogus"]]) {
		const run = await s.tunnel(...argv);
		assert.equal(run.code, 2, argv.join(" "));
		assert.match(run.stderr, /usage: cp-tunnel up/, argv.join(" "));
	}
	const bare = await new Promise<number>((done) => spawn(join(REPO_ROOT, "bin/cp-tunnel"), ["status"], { env: s.env, stdio: "ignore" }).once("exit", (code) => done(code ?? 1)));
	assert.equal(bare, 2, "no --home and no CP_HOME");
	const tokenFile = join(s.home, "given-token");
	writeFileSync(tokenFile, TOKEN);
	const cases: Array<[string[], RegExp]> = [
		[["up", "--quick", "--hostname", "cp.example.com"], /--quick takes no --hostname/],
		[["up", "--quick", "--push-origin", "accept"], /push is never pointed at it/],
		[["up", "--hostname", "not a host"], /needs --hostname HOST/],
		[["up", "--hostname", "cp.example.com"], /needs --token-file FILE/],
		[["up", "--remote-port", String(s.localPort)], /the local dashboard's port/],
		[["up", "--remote-port", "80"], /--remote-port must be 1024-65535/],
		[["up", "--hostname", "cp.example.com", "--token-file", "/nonexistent/token"], /cannot read --token-file: ENOENT/],
		[["up", "--hostname", "cp.example.com", "--api-token-file", tokenFile, "--token-file", tokenFile], /--api-token-file takes no --quick or --token-file/],
		[["up", "--quick", "--api-token-file", tokenFile], /--api-token-file takes no --quick or --token-file/],
		[["up", "--api-token-file", tokenFile], /--api-token-file needs --hostname HOST/],
		[["up", "--hostname", "cp.example.com", "--api-token-file", "/nonexistent/cf-token"], /cannot read --api-token-file: ENOENT/],
		[["down"], /no tunnel is configured/],
	];
	for (const [argv, refusal] of cases) {
		const run = await s.tunnel(...argv);
		assert.equal(run.code, 1, argv.join(" "));
		assert.match(run.stderr, refusal, argv.join(" "));
	}
	writeFileSync(join(s.paths.dataDir, "tunnel.lock"), `${process.pid}\n`);
	for (const argv of [["up"], ["up", "--hostname", "cp.example.com", "--token-file", tokenFile]]) {
		const run = await s.tunnel(...argv);
		assert.equal(run.code, 1, argv.join(" "));
		assert.match(run.stderr, new RegExp(`cp-tunnel pid ${process.pid} is changing the tunnel`));
	}
	assert.equal(existsSync(join(s.paths.dataDir, "tunnel", "token")), false, "a racing up never stores a token outside the lock");
	assert.deepEqual([s.config(), s.runs()], [undefined, []], "no config, no cloudflared run");
	assert.match((await s.cli("cp-daemon", ["status"])).stdout, /^cp-daemon: not running/m);

	// cp-tunnel status reads both records strictly: a valid pair reads back, each bad field is named, nothing repaired.
	const quick = { schema_version: 1, enabled: true, mode: "quick", port: 8767, binary: "/opt/cf/cloudflared", revision: 1 };
	const named = { ...quick, mode: "named", hostname: "cp.example.com", token_file: "/srv/home/.pi-command-post/data/tunnel/token" };
	const ids = { tunnel_id: "f70ff985-a4ef-4643-bbbc-4a0ed4fc8415", zone_id: "023e105f4ecef8ad9ca31a8372d0c353", account_id: "699d98642c564d2e855e9661899b7252" };
	const runtime = { schema_version: 1, origin: "https://a.trycloudflare.com", generation: 1, revision: 2, state: "running", mode: "quick", port: 8767, pid: 4242, binary: "/opt/cf/cloudflared", argv: ["tunnel"], updated_at: "x" };
	const status = async (config: unknown, record: unknown) => {
		writeFileSync(tunnelConfigFile(s.paths.dataDir), JSON.stringify(config));
		writeFileSync(tunnelRuntimeFile(s.paths.stateDir), JSON.stringify(record));
		return (await s.tunnel("status")).stdout.split("\n");
	};
	assert.deepEqual((await status({ ...named, ...ids }, runtime)).slice(0, 2), ["config: enabled, named cp.example.com, port 8767, revision 1", "cloudflared: running pid 4242, origin https://a.trycloudflare.com, generation 1, revision 2"]);
	for (const [field, bad] of [["port", { ...quick, port: 80 }], ["binary", { ...quick, binary: "cloudflared" }], ["hostname", { ...named, hostname: "localhost" }], ["hostname", { ...quick, hostname: "a.b" }], ["token_file", { ...named, token_file: "token" }], ["revision", { ...quick, revision: 0 }], ["mode", { ...quick, mode: "x" }], ["tunnel_id", { ...named, tunnel_id: "../zones" }], ["zone_id", { ...quick, zone_id: ids.zone_id }]] as const) {
		assert.match((await status(bad, runtime))[0]!, new RegExp(`^config: unreadable \\(.*${field}\\)$`), field);
	}
	for (const bad of [{ ...runtime, state: "up" }, { ...runtime, pid: 1 }, { ...runtime, binary: undefined }, { ...runtime, revision: 0 }]) {
		assert.match((await status(quick, bad))[1]!, /^cloudflared: runtime unreadable \(/, JSON.stringify(bad));
	}
	assert.equal(readFileSync(tunnelRuntimeFile(s.paths.stateDir), "utf8"), JSON.stringify({ ...runtime, revision: 0 }));

	// A cp-daemon that cannot start is named, and the tunnel it would run stays enabled.
	rmSync(join(s.paths.dataDir, "tunnel.lock"));
	rmSync(tunnelRuntimeFile(s.paths.stateDir));
	writeFileSync(s.paths.config, JSON.stringify({ ...json(s.paths.config), node: "/nonexistent/node" }));
	const unstarted = await s.tunnel("up", "--quick", "--remote-port", String(s.remotePort));
	assert.equal(unstarted.code, 1);
	assert.match(unstarted.stderr, /cp-daemon did not start; the tunnel is enabled and starts with it/);
	assert.deepEqual([s.config()?.enabled, s.config()?.revision], [true, 2]);
});

test("P12b-ready: up fails once its bound passes while the viewer cannot open the listener, and issues no pairing code", async (t) => {
	const s = await rig(t);
	assert.equal((await s.cli("cp-daemon", ["start"])).code, 0, s.log());
	const clock = join(s.home, "clock-offset-ms");
	writeFileSync(clock, "0");
	const blocker: Server = createServer();
	const blocked = await freePort();
	await new Promise<void>((done) => blocker.listen(blocked, "127.0.0.1", done));
	t.after(() => blocker.close());
	const failing = s.cli("cp-tunnel", ["up", "--remote-port", String(blocked)], { env: preload("process-clock.ts", { CP_TEST_CLOCK_FILE: clock }) });
	await s.settled("running", 1);
	writeFileSync(clock, String(121_000));
	const failed = await failing;
	assert.equal(failed.code, 1);
	assert.match(failed.stderr, /not ready within 120s: the viewer has not opened the remote listener for this origin yet\. The tunnel stays enabled .* cp-tunnel down turns it off/);
	assert.equal(failed.stdout, "");
	assert.match((await s.tunnel("devices")).stdout, /^0 unclaimed pairing code\(s\)$/m, "no pairing code is issued");
});

test("P12b-fail-closed: an unreadable runtime record starts nothing until fixed; an unreadable config stops the child and says why", async (t) => {
	const s = await rig(t);
	writeFileSync(tunnelConfigFile(s.paths.dataDir), JSON.stringify({ schema_version: 1, enabled: true, mode: "quick", port: s.remotePort, binary: `${s.fake}/cloudflared`, revision: 1 }));
	writeFileSync(tunnelRuntimeFile(s.paths.stateDir), "{torn");
	assert.equal((await s.cli("cp-daemon", ["start"])).code, 0, s.log());
	await until(s.log, (text) => text.includes("the runtime record is unreadable, so no tunnel starts until it is fixed or removed"), "the refusal");
	await new Promise((done) => setTimeout(done, 6_000));
	assert.deepEqual(s.runs(), [], "nothing starts across ticks");
	assert.equal(readFileSync(tunnelRuntimeFile(s.paths.stateDir), "utf8"), "{torn", "the record is never reset");
	writeFileSync(tunnelRuntimeFile(s.paths.stateDir), JSON.stringify({ schema_version: 1, origin: "https://a.trycloudflare.com", generation: 3, revision: 1, state: "stopped", updated_at: "x" }));
	const running = await s.settled("running", 1);
	assert.match(s.log(), /the runtime record is readable again/);
	assert.equal(running?.generation, 4, "the re-read generation is kept, so older sessions stay ended");

	const pid = running?.pid as number;
	writeFileSync(tunnelConfigFile(s.paths.dataDir), "not json");
	const failed = await until(s.runtime, (r) => r?.state === "failed", "failed");
	assert.match(String(failed?.detail), /^config refused: .*tunnel\.json/);
	assert.equal(alive(pid), false, "the child is stopped");
	await new Promise((done) => setTimeout(done, 6_000));
	assert.equal(s.runtime()?.updated_at, failed?.updated_at, "an unchanged refusal is not rewritten every tick");
	assert.equal(s.runs().length, 1);
});

test("P12b-orphan: a crashed inner's cloudflared is stopped by its exact command line before a fresh one starts; a stubborn child gets SIGKILL", async (t) => {
	const s = await rig(t);
	s.touch("stubborn");
	writeFileSync(tunnelConfigFile(s.paths.dataDir), JSON.stringify({ schema_version: 1, enabled: true, mode: "quick", port: s.remotePort, binary: `${s.fake}/cloudflared`, revision: 1 }));
	assert.equal((await s.cli("cp-daemon", ["start"])).code, 0, s.log());
	const first = await s.settled("running", 1);
	const orphan = first?.pid as number;
	t.after(() => void (alive(orphan) && process.kill(orphan, "SIGKILL"))); // a stubborn orphan outlives a failed run
	const inner = Number(/^inner: ready pid (\d+)/m.exec((await s.cli("cp-daemon", ["status"])).stdout)?.[1]);
	process.kill(inner, "SIGKILL");
	await until(s.log, (text) => text.includes(`tunnel: stopping cloudflared pid ${orphan} of a previous runtime`), "the orphan stop", 60_000);
	await until(s.log, (text) => text.includes(`tunnel: cloudflared pid ${orphan} of a previous runtime ignored SIGTERM: SIGKILL`), "the orphan SIGKILL");
	const fresh = await until(s.runtime, (r) => r?.state === "running" && r.pid !== orphan, "a fresh child", 30_000);
	assert.equal(alive(orphan), false);
	assert.equal(fresh?.generation, 1, "the stand-in prints the same quick origin, so the generation stays");
	assert.equal(s.runs().length, 2);

	const down = await s.tunnel("down");
	assert.equal(down.code, 0, down.stderr);
	assert.match(s.log(), new RegExp(`tunnel: cloudflared pid ${fresh?.pid} ignored SIGTERM: SIGKILL`));
	assert.equal(alive(fresh?.pid as number), false);
	await new Promise((done) => setTimeout(done, 6_000));
	assert.equal(s.runs().length, 2, "nothing restarts a disabled tunnel");
});

const API_TOKEN = "cfapi-SECRET-api-token-0123456789";
const RUN_TOKEN = "eyJhIjoicnVuLXRva2VuIn0";
const ZONE = "023e105f4ecef8ad9ca31a8372d0c353";
const ACCOUNT = "699d98642c564d2e855e9661899b7252";
const TUNNEL = "f70ff985-a4ef-4643-bbbc-4a0ed4fc8415";
const HOST = "cp.lab.example.co.uk";
type CfItem = Record<string, unknown>;

/** api.cloudflare.com and the GitHub release host behind tests/harness/fake-fetch.ts: one zone, scripted refusals. */
async function fakeRemote(t: TestContext) {
	const fresh = () => ({ records: [] as CfItem[], tunnels: [] as CfItem[], calls: [] as Array<{ call: string; body?: CfItem }>, auth: new Set<string>(), downloads: [] as string[], refuse: undefined as undefined | ((call: string) => [number, unknown] | undefined) });
	const state = fresh();
	const server = httpServer((req, res) => {
		let text = "";
		req.on("data", (chunk) => (text += chunk));
		req.on("end", () => {
			const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
			const url = new URL(req.url ?? "/", "http://fake");
			if (url.pathname.startsWith("/github.com/")) return void (state.downloads.push(url.pathname), res.writeHead(200).end("not cloudflared"));
			const path = url.pathname.slice("/api.cloudflare.com/client/v4".length), q = url.searchParams;
			const call = `${req.method} ${path}${url.search}`;
			const body = text ? (JSON.parse(text) as CfItem) : undefined;
			state.calls.push({ call, ...(body ? { body } : {}) });
			state.auth.add(String(req.headers.authorization));
			const refused = state.refuse?.(call);
			if (refused) return send(...refused);
			const ok = (result: unknown) => send(200, { success: true, errors: [], messages: [], result });
			if (path === "/zones") return ok(q.get("name") === "example.co.uk" ? [{ id: ZONE, name: "example.co.uk", account: { id: ACCOUNT } }] : []);
			if (path === `/zones/${ZONE}/dns_records` && req.method === "GET") return ok(state.records.filter((record) => record.name === q.get("name")));
			if (path === `/zones/${ZONE}/dns_records`) return (state.records.push(body!), ok({ id: "rec-1", ...body }));
			if (path === `/accounts/${ACCOUNT}/cfd_tunnel` && req.method === "GET") return ok(state.tunnels.filter((tunnel) => (q.has("uuid") ? tunnel.id === q.get("uuid") : tunnel.name === q.get("name"))));
			if (path === `/accounts/${ACCOUNT}/cfd_tunnel`) return (state.tunnels.push({ id: TUNNEL, ...body }), ok({ id: TUNNEL, ...body }));
			if (path === `/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`) return ok({ tunnel_id: TUNNEL, version: 1 });
			if (path === `/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/token`) return ok(RUN_TOKEN);
			send(404, { success: false, errors: [{ code: 7003, message: `no route ${call}` }] });
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	t.after(() => server.close());
	const env = preload("fake-fetch.ts", { CP_TEST_FETCH_BASE: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
	return { state, env, seen: () => state.calls.map((entry) => entry.call), reset: () => Object.assign(state, fresh()) };
}

test("P12b-api: --api-token-file creates the named tunnel through the Cloudflare API, never overwrites DNS, names a missing scope", async (t) => {
	const cf = await fakeRemote(t);
	const homes = async () => {
		const r = await rig(t);
		writeFileSync(join(r.home, "cf-token"), `${API_TOKEN}\n`);
		const up = () => r.cli("cp-tunnel", ["up", "--hostname", HOST, "--api-token-file", join(r.home, "cf-token"), "--remote-port", String(r.remotePort)], { env: cf.env });
		/** The API token never leaves memory: not in output, a data file or the daemon log. */
		const clean = (...runs: Run[]) => {
			const data = [tunnelConfigFile(r.paths.dataDir), join(r.paths.dataDir, "tunnel", "token"), pushConfigFile(r.paths.dataDir)].filter(existsSync).map((file) => readFileSync(file, "utf8"));
			for (const text of [...runs.flatMap((run) => [run.stdout, run.stderr]), ...data, r.log()]) assert.ok(!text.includes(API_TOKEN), text);
		};
		return { r, up, clean };
	};
	const { r, up, clean } = await homes();
	const name = tunnelNameFor(r.home);
	const zones = ["GET /zones?name=cp.lab.example.co.uk", "GET /zones?name=lab.example.co.uk", "GET /zones?name=example.co.uk"];
	const first = await up();
	assert.equal(first.stdout, `https://${HOST}\n`, first.stderr);
	assert.deepEqual(cf.state.calls, [
		...zones.map((call) => ({ call })),
		{ call: `GET /accounts/${ACCOUNT}/cfd_tunnel?is_deleted=false&name=${name}` },
		{ call: `GET /zones/${ZONE}/dns_records?name=${HOST}` },
		{ call: `POST /accounts/${ACCOUNT}/cfd_tunnel`, body: { name, config_src: "cloudflare" } },
		{ call: `PUT /accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`, body: { config: { ingress: [{ hostname: HOST, service: `http://127.0.0.1:${r.remotePort}`, originRequest: { httpHostHeader: `127.0.0.1:${r.remotePort}` } }, { service: "http_status:404" }] } } },
		{ call: `POST /zones/${ZONE}/dns_records`, body: { type: "CNAME", name: HOST, content: `${TUNNEL}.cfargotunnel.com`, proxied: true } },
		{ call: `GET /accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/token` },
	]);
	assert.deepEqual([...cf.state.auth], [`Bearer ${API_TOKEN}`]);
	const stored = join(r.paths.dataDir, "tunnel", "token");
	const ids = { tunnel_id: TUNNEL, zone_id: ZONE, account_id: ACCOUNT };
	assert.deepEqual(r.config(), { schema_version: 1, enabled: true, mode: "named", port: r.remotePort, binary: `${r.fake}/cloudflared`, hostname: HOST, token_file: stored, ...ids, revision: 1 });
	assert.deepEqual([readFileSync(stored, "utf8"), statSync(stored).mode & 0o777], [RUN_TOKEN, 0o600]);
	assert.equal(r.runs().at(-1)?.[1], `tunnel --no-autoupdate run --token-file ${stored}`, "the run token reaches cloudflared as a path");
	assert.match(first.stderr, new RegExp(`created tunnel ${name} \\(${TUNNEL}\\)`));
	assert.match(first.stderr, new RegExp(`created DNS record: ${HOST} CNAME ${TUNNEL}\\.cfargotunnel\\.com \\(proxied\\)`));
	assert.equal(first.stderr.trim().split("\n").at(-2), "cp-tunnel: You can now delete the API token in Cloudflare; it is only needed to change the hostname.");

	// An idempotent re-run reuses the saved tunnel and its own CNAME: nothing is created twice.
	cf.state.calls.length = 0;
	const again = await up();
	assert.deepEqual(cf.seen(), [...zones, `GET /accounts/${ACCOUNT}/cfd_tunnel?is_deleted=false&uuid=${TUNNEL}`, `GET /zones/${ZONE}/dns_records?name=${HOST}`, `PUT /accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`, `GET /accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/token`]);
	assert.match(again.stderr, new RegExp(`reusing tunnel ${TUNNEL}[\\s\\S]*${HOST} already points to this tunnel`));
	assert.deepEqual([r.config()?.revision, r.config()?.tunnel_id, cf.state.tunnels.length, cf.state.records.length], [2, TUNNEL, 1, 1]);
	clean(first, again);

	for (const record of [{ type: "A", name: HOST, content: "192.0.2.7" }, { type: "CNAME", name: HOST, content: "other.cfargotunnel.com" }]) {
		cf.reset();
		cf.state.records.push(record);
		const foreign = await homes();
		const run = await foreign.up();
		assert.equal(run.code, 1);
		assert.match(run.stderr, new RegExp(`${HOST} already has DNS records \\(${record.type} ${record.content}\\); cp-tunnel never overwrites one`));
		assert.deepEqual(cf.seen().filter((call) => !call.startsWith("GET")), [], "nothing created");
		assert.deepEqual([foreign.r.config(), existsSync(join(foreign.r.paths.dataDir, "tunnel", "token")), existsSync(join(foreign.r.fake, "calls"))], [undefined, false, false], "no config, token or cloudflared probe");
		foreign.clean(run);
	}

	const denied = (status: number, code: number): [number, unknown] => [status, { success: false, errors: [{ code, message: `Authentication error for ${API_TOKEN}` }] }];
	cf.reset();
	cf.state.refuse = (call) => (call === `POST /accounts/${ACCOUNT}/cfd_tunnel` ? denied(403, 10000) : undefined);
	const tunnelScope = await homes();
	const noTunnel = await tunnelScope.up();
	assert.equal(noTunnel.stderr.trim().split("\n").at(-1), `cp-tunnel up: the Cloudflare API token lacks the ${TUNNEL_SCOPE} permission (POST /accounts/${ACCOUNT}/cfd_tunnel was refused)`);
	tunnelScope.clean(noTunnel);
	cf.reset();
	cf.state.refuse = (call) => (call.startsWith("GET /zones?") ? denied(400, 10000) : undefined);
	const dnsScope = await homes();
	const noDns = await dnsScope.up();
	assert.match(noDns.stderr.trim().split("\n").at(-1)!, new RegExp(`lacks the ${DNS_SCOPE} permission`));
	dnsScope.clean(noDns);

	// The DNS create fails after the tunnel exists: it stays, and the re-run finds it by name (no config was saved).
	cf.reset();
	cf.state.refuse = (call) => (call === `POST /zones/${ZONE}/dns_records` ? [400, { success: false, errors: [{ code: 1004, message: "DNS Validation Error" }] }] : undefined);
	const partial = await homes();
	const half = await partial.up();
	assert.match(half.stderr.trim().split("\n").at(-1)!, new RegExp(`HTTP 400 \\(1004: DNS Validation Error\\)\\. The tunnel ${TUNNEL} stays in place; re-run the same cp-tunnel up command`));
	assert.equal(partial.r.config(), undefined);
	cf.state.refuse = undefined;
	const rerun = await partial.up();
	assert.equal(rerun.stdout, `https://${HOST}\n`, rerun.stderr);
	assert.deepEqual([cf.state.tunnels.length, partial.r.config()?.tunnel_id], [1, TUNNEL], "the re-run reused the tunnel");
	partial.clean(half, rerun);
});

test("P12b-download: with no usable cloudflared the pinned download is verified first, so a mismatch writes no config or token", async (t) => {
	const cf = await fakeRemote(t);
	const s = await rig(t, { cloudflared: false });
	writeFileSync(join(s.home, "given-token"), TOKEN);
	for (const argv of [["up"], ["up", "--hostname", "cp.example.com", "--token-file", join(s.home, "given-token")]]) {
		const run = await s.cli("cp-tunnel", argv, { env: cf.env });
		assert.equal(run.code, 1, argv.join(" "));
		assert.match(run.stderr, /no usable cloudflared: .*checksum mismatch for cloudflared-/, argv.join(" "));
	}
	assert.equal(cf.state.downloads.length, 2);
	assert.match(cf.state.downloads[0]!, /^\/github\.com\/cloudflare\/cloudflared\/releases\/download\//);
	assert.deepEqual([s.config(), existsSync(join(s.paths.dataDir, "tunnel", "token")), existsSync(join(dirname(s.paths.dataDir), "bin", "cloudflared"))], [undefined, false, false], "nothing published or written");
});
