/**
 * Change driver for dashboard load runs: `node tests/harness/dashboard-change-driver.ts --home <scratch> [--seed 1800]
 * [--seconds 60]`. Seeds a fixture home, then rewrites fleet.json every 5 s, jobs.json every 15 s and appends to the
 * operator transcript every 10 s. It writes only under `--home` and refuses the live home; one JSON line on exit.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { layoutForHome, runtimeRootFor } from "../../src/contracts/layout.ts";
import { describeHome } from "../../src/home.ts";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";

const MARKER = ".cp-change-driver";
const LIVE_JOBS = 5;
const EVERY = { fleet: 5_000, jobs: 15_000, transcript: 10_000 };

const { values } = parseArgs({ options: { home: { type: "string" }, seed: { type: "string" }, seconds: { type: "string", default: "60" } } });
const seconds = Number(values.seconds), seed = Number(values.seed ?? 1800);
if (!values.home || !Number.isFinite(seconds) || seconds <= 0 || !Number.isInteger(seed) || seed < LIVE_JOBS) {
	process.stderr.write(`usage: node tests/harness/dashboard-change-driver.ts --home <scratch> [--seed N>=${LIVE_JOBS}, default 1800] [--seconds 60]\n`);
	process.exit(2);
}
const real = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
const home = real(values.home);
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
const live = [join(homedir(), ".pi-command-post"), describeHome().home].map(real);
const clash = live.find((root) => overlaps(home, root) || overlaps(runtimeRootFor(home), root));
const refuse = (why: string) => {
	process.stderr.write(`dashboard-change-driver: refusing --home ${home}: ${why}\n`);
	process.exit(3);
};
if (clash) refuse(`it is, holds or sits inside the live home ${clash}`);
if (existsSync(home) && readdirSync(home).length > 0 && !existsSync(join(home, MARKER))) refuse(`not empty and not seeded by this driver (no ${MARKER})`);

const L = layoutForHome("multi", home);
const at = (path: string) => join(home, path);
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const atomic = (path: string, value: unknown) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(`${path}.tmp`, JSON.stringify(value));
	renameSync(`${path}.tmp`, path);
};
const ids = (n: number) => Array.from({ length: n }, (_, i) => `cp-fixture-${String(i).padStart(4, "0")}`);
const transcript = at(join(L.sessions, "operator", "chat.jsonl"));
const line = (role: "user" | "assistant", text: string) => `${JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role, content: [{ type: "text", text }] } })}\n`;

const jobIds = ids(seed), liveIds = jobIds.slice(-LIVE_JOBS);
const fleet = { jobs: jobIds.map((id, i) => liveIds.includes(id)
	? { job_id: id, project: "demo", kind: "ship", phase: "waiting", dispatched_at: iso(3_600_000) }
	: { job_id: id, project: "demo", kind: "ship", phase: "done", dispatched_at: iso(86_400_000 + i * 1000), closed_at: iso(80_000_000 + i * 1000) }) };
const ledger = { jobs: jobIds.map((id, i) => ({ id, title: `Fixture job ${i}`, labels: ["project:demo", "kind:ship", "delivery:pr"], status: liveIds.includes(id) ? "in_progress" : "closed", created_at: iso(90_000_000), ...(liveIds.includes(id) ? {} : { closed_at: iso(80_000_000 + i * 1000) }) })) };
mkdirSync(home, { recursive: true });
writeFileSync(join(home, MARKER), `seeded ${new Date().toISOString()} with ${seed} jobs\n`);
atomic(at(L.fleetFile), fleet);
atomic(at(L.jobsFile), ledger);
for (const id of liveIds) atomic(at(join(L.runs, id, "status.json")), { phase: "working", started_at: iso(3_600_000) });
mkdirSync(dirname(transcript), { recursive: true });
writeFileSync(transcript, Array.from({ length: 40 }, (_, i) => line(i % 2 ? "assistant" : "user", `Seed message ${i}`)).join(""));
writeFileSync(operatorSessionsFile(at(L.sessions)), `${JSON.stringify({ at: iso(3_600_000), session_file: transcript })}\n`);

const writes = { fleet: 0, jobs: 0, transcript: 0 };
const timers = [
	setInterval(() => {
		writes.fleet++;
		const job = fleet.jobs.find((j) => j.job_id === liveIds[0])!;
		job.phase = job.phase === "waiting" ? "held" : "waiting";
		atomic(at(L.fleetFile), fleet);
	}, EVERY.fleet),
	setInterval(() => {
		writes.jobs++;
		ledger.jobs.find((j) => j.id === liveIds[0])!.title = `Fixture live job · revision ${writes.jobs}`;
		atomic(at(L.jobsFile), ledger);
	}, EVERY.jobs),
	setInterval(() => {
		writes.transcript++;
		appendFileSync(transcript, line("assistant", `Driver line ${writes.transcript}`));
	}, EVERY.transcript),
];
const finish = () => {
	for (const timer of timers) clearInterval(timer);
	process.stdout.write(`${JSON.stringify({ ok: true, home, seeded: seed, seconds, writes })}\n`);
	process.exit(0);
};
setTimeout(finish, seconds * 1000);
process.once("SIGTERM", finish);
process.once("SIGINT", finish);
