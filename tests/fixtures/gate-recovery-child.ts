import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const [home, source, target, authority, fault, barrier, action = "prepare", model] = process.argv.slice(2);
if (!home || !source || !target || !authority) throw new Error("home/source/target/authority required");
const link = fs.linkSync;
const rename = fs.renameSync;
function publication(operation: typeof fs.linkSync, from: Parameters<typeof fs.linkSync>[0], to: Parameters<typeof fs.linkSync>[1]) {
	const destination = String(to);
	if ((action === "standing" ? /\/gate-\d+-standing\.json$/.test(destination) : destination.endsWith(action === "gate" ? "gate-recovery-claim.json" : "gate-recovery-reservation.json")) && barrier) {
		fs.writeFileSync(`${barrier}.${process.pid}.ready`, "ready");
		const deadline = Date.now() + 15000;
		while (!fs.existsSync(`${barrier}.release`)) {
			if (Date.now() > deadline) throw new Error("filesystem barrier timed out");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
	}
	if (fault === "before-reservation" && destination.endsWith("gate-recovery-reservation.json")) process.exit(73);
	if (fault === "unsupported-link") throw Object.assign(new Error("EOPNOTSUPP: hard links unsupported"), { code: "EOPNOTSUPP" });
	operation(from, to);
	if (fault && destination.endsWith(fault)) process.exit(73);
}
fs.linkSync = (from, to) => publication(link, from, to);
fs.renameSync = (from, to) => publication(rename, from, to);
const childProcess = await import("node:child_process");
const spawn = childProcess.default.spawn;
childProcess.default.spawn = ((...args: Parameters<typeof spawn>) => {
	if (Array.isArray(args[1]) && args[1].includes("rpc")) {
		if (fault === "spawn-failure") throw Object.assign(new Error("spawn EACCES (injected OS boundary failure)"), { code: "EACCES" });
		fs.appendFileSync(`${home}/spawn-observations.jsonl`, `${process.pid}\n`);
	}
	return spawn(...args);
}) as typeof spawn;
syncBuiltinESMExports();
const { CommandPost } = await import("../../src/command-post.ts");
const post = new CommandPost({ home, packageRoot: process.cwd(), parentEnv: process.env });
if (action === "source-race") {
	const registry = {
		find(provider: string, id: string) {
			fs.writeFileSync(`${barrier}.ready`, "ready");
			const deadline = Date.now() + 15000;
			while (!fs.existsSync(`${barrier}.release`)) {
				if (Date.now() > deadline) throw new Error("routing barrier timed out");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
			return { provider, id };
		},
		hasConfiguredAuth: () => true,
	};
	await post.shutdown();
	const routed = new CommandPost({ home, packageRoot: process.cwd(), parentEnv: process.env, modelRegistry: () => registry });
	try { await routed.gate({ jobId: source, model: model ?? "mock/test" }); }
	catch (error) { console.error(String(error)); process.exitCode = 1; }
	finally { await routed.shutdown(); }
	process.exit(process.exitCode ?? 0);
}
try {
	if (action === "gate" || action === "standing") {
		const result = await post.gate({ jobId: target, ...(model ? { model } : {}), ...(action === "standing" ? { recoveryAttemptId: authority } : {}) });
		console.log(JSON.stringify(result));
		if ("key" in result) {
			if (fault === "orphan") {
				await post.manager.shutdown(result.key);
				process.exit(73);
			}
			post.reviewRuns.handBack(result.key);
			await post.reviewRuns.settled(result.key);
		}
	} else console.log(JSON.stringify(await post.replacePlanner(source, target, authority)));
} catch (error) {
	console.error(String(error));
	process.exitCode = 1;
} finally {
	await post.shutdown();
}
