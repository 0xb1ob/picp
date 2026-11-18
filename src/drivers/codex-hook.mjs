// picp's Codex PreToolUse hook client: `node codex-hook.mjs <socket> [timeout ms]`. It forwards the hook's stdin JSON
// to the worker's unix socket and exits 0 only on a well-formed allow; every other path exits 2 (deny).
import { createConnection } from "node:net";

const STDIN_CAP = 1024 * 1024;
let done = false;

function fail(cause) {
	if (done) return;
	done = true;
	process.stderr.write(`Refused: picp's hook could not reach its worker (${cause}); a hook that cannot decide denies.\n`);
	process.exit(2);
}

process.on("uncaughtException", (error) => fail(`uncaught: ${error?.message ?? error}`));
process.on("unhandledRejection", (error) => fail(`unhandled: ${error?.message ?? error}`));

const [socket, timeoutArg] = process.argv.slice(2);
const timeoutMs = Number(timeoutArg ?? 10_000);
if (!socket) fail("no socket argument");
setTimeout(() => fail(`no verdict in ${timeoutMs} ms`), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000).unref();

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	input += chunk;
	if (input.length > STDIN_CAP) fail("hook input over 1 MiB");
});
process.stdin.on("error", (error) => fail(`stdin: ${error.message}`));
process.stdin.on("end", () => {
	let hook;
	try {
		hook = JSON.parse(input);
	} catch {
		return fail("hook input is not JSON");
	}
	const conn = createConnection(socket);
	let reply = "";
	conn.setEncoding("utf8");
	conn.on("error", (error) => fail(`connect: ${error.code ?? error.message}`));
	conn.on("connect", () => conn.write(`${JSON.stringify({ v: 1, hook })}\n`));
	conn.on("data", (chunk) => {
		reply += chunk;
		const cut = reply.indexOf("\n");
		if (cut < 0) return;
		let verdict;
		try {
			verdict = JSON.parse(reply.slice(0, cut));
		} catch {
			return fail("malformed verdict");
		}
		conn.destroy();
		if (verdict?.decision === "allow") {
			done = true;
			process.exit(0);
		}
		if (verdict?.decision === "deny" && typeof verdict.reason === "string") {
			done = true;
			process.stderr.write(`${verdict.reason}\n`);
			process.exit(2);
		}
		fail("malformed verdict");
	});
	conn.on("end", () => fail("socket closed before a verdict"));
});
