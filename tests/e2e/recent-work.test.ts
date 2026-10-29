/**
 * P1 recent-work digest: closed jobs recorded through real cp_job reach a fresh parent and a fresh operator session
 * as the same bounded, project-grouped section; compaction and rotation refresh it, an unchanged resume does not.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { CpBridge } from "../../src/cp-bridge.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, type Job, LAYOUT, paths } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { Ledger, readJobsDocument } from "../../src/ledger.ts";
import { ProjectRegistry } from "../../src/projects.ts";
import { CP_BRIDGE_EXTENSION, COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, startRpc, waitFor } from "../harness/index.ts";
import { bench, job } from "./project-tracker-helpers.ts";

const HEADER = "Recent work (closed jobs";
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
/** The digest as it sits in a provider request: from its header to the end of its JSON string, decoded. */
const digestOf = (body: unknown): string | undefined => {
	const raw = /Recent work (?:\(closed jobs|unavailable)(?:[^"\\]|\\.)*/.exec(JSON.stringify(body))?.[0];
	return raw === undefined ? undefined : JSON.parse(`"${raw}"`);
};
const writeFile = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const seedJobs = (home: string, edit: (jobs: Job[]) => void) => {
	const doc = readJobsDocument(home);
	edit(doc.jobs);
	writeFileSync(join(home, LAYOUT.jobsFile), JSON.stringify(doc));
};
const reported = (home: string, jobId: string, project: string, receipts: unknown[] = []) => new FleetStore({ home }).add({
	job_id: jobId, project, kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "done", reported_at: isoTimestamp(), dispatched_at: isoTimestamp(),
	usage: EMPTY_USAGE, branch: jobId, worktree: home, receipts: receipts as never,
	worker: { pid: 1, session_id: "fixture", session_file: join(home, "worker.jsonl"), profile: "implementer", role: "implementer", model: "mock/worker", started_at: isoTimestamp() },
});

async function operatorRequest(t: TestContext, home: string, name: string): Promise<unknown> {
	const provider = await MockProvider.start();
	const model = provider.addScript(name, [{ kind: "text", text: "Context received." }]);
	const agent = createAgentDir({ provider });
	const rpc = startRpc({ cwd: home, env: { ...agent.env, PI_HOME: home, CP_HOME: home }, args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--no-session", "--model", model] });
	t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); });
	rpc.send({ type: "prompt", id: name, message: "Read the supplied operator context." });
	await rpc.waitFor((r) => r.type === "agent_settled", 60_000);
	return provider.requests(name)[0]?.body;
}

test("P1 recent work: cp_job closes reach fresh parent and operator as one bounded, marked digest", { timeout: 300_000 }, async (t) => {
	const s = await bench(t, "rw-facts");
	for (const name of ["demo-app", "other-app"]) await new ProjectRegistry({ home: s.home }).register({ name, clone_url: `https://example.invalid/${name}.git` });
	const create = (title: string, project = "demo-app") => job(`c-${title}`, { action: "create", title, project, delivery: "pr", kind: "ship" });
	const on = (title: string, args: Record<string, unknown>) => () => ({ ...args, job_id: s.idOf(title) });
	await s.session("Record and close the work.", [
		...["rw-old", "rw-a3", "rw-a4", "rw-drop", "rw-blocked", "rw-first"].map((title) => create(title)),
		create("rw-other", "other-app"), create("rw-open", "other-app"),
		...["rw-old", "rw-a3", "rw-a4", "rw-blocked", "rw-first"].map((title) => job(`x-${title}`, on(title, { action: "close", reason: `landed ${title}` }))),
		job("x-rw-other", on("rw-other", { action: "close", reason: "landed rw-other" })),
		job("x-rw-drop", on("rw-drop", { action: "drop", reason: "superseded" })),
	]);
	const id = Object.fromEntries(["rw-old", "rw-a3", "rw-a4", "rw-drop", "rw-blocked", "rw-first", "rw-other", "rw-open"].map((title) => [title, s.idOf(title)]));
	// Same-second closes would tie: pin distinct close times; rw-first was created long ago but closed last.
	const closedAt: Record<string, string> = { "rw-first": minutesAgo(1), "rw-blocked": minutesAgo(2), "rw-drop": minutesAgo(3), "rw-other": minutesAgo(4), "rw-a4": minutesAgo(5), "rw-a3": minutesAgo(6), "rw-old": minutesAgo(8 * 24 * 60) };
	seedJobs(s.home, (jobs) => {
		for (const entry of jobs) if (closedAt[entry.title]) entry.closed_at = closedAt[entry.title];
		jobs.find((entry) => entry.title === "rw-first")!.created_at = "2020-01-01T00:00:00Z";
	});
	await reported(s.home, id["rw-first"]!, "demo-app", [{ kind: "pr", status: "open", title: "rw", url: "https://example.invalid/demo-app/pull/7" }]);
	await reported(s.home, id["rw-blocked"]!, "demo-app");
	await reported(s.home, id["rw-other"]!, "other-app"); // reported, but its envelope is missing
	writeFile(join(s.home, paths.envelopeFile(id["rw-first"]!)), JSON.stringify({ envelope: { status: "done", summary: "RW first shipped headline" } }));
	writeFile(join(s.home, paths.envelopeFile(id["rw-blocked"]!)), JSON.stringify({ envelope: { status: "blocked", summary: "RW blocked headline" } }));
	writeFile(join(s.home, paths.artifactFile(id["rw-first"]!)), "RW-BODY-SENTINEL findings\n");

	const before = s.requests().length;
	await s.session("Say what recently happened.", []);
	const parent = digestOf(s.requests()[before]?.body);
	const operator = digestOf(await operatorRequest(t, s.home, "rw-operator"));
	assert.ok(parent, "parent request carries the digest");
	assert.equal(operator, parent, "operator and parent see the same digest");
	const order = ["[demo-app]", id["rw-first"]!, id["rw-blocked"]!, id["rw-drop"]!, "[other-app]", id["rw-other"]!].map((needle) => parent.indexOf(needle));
	assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!)), `order ${order.join(",")}\n${parent}`);
	assert.match(parent, new RegExp(`DROPPED ${id["rw-drop"]}`));
	assert.match(parent, /report BLOCKED: RW blocked headline/);
	assert.match(parent, /report DONE: RW first shipped headline \| \S+report\.md https:\/\/example\.invalid\/demo-app\/pull\/7/);
	assert.match(parent, /… 2 more closed in demo-app omitted/);
	assert.match(parent, /Source limited: 1 envelope\(s\) unreadable/);
	for (const absent of [id["rw-old"]!, id["rw-open"]!, id["rw-a3"]!, id["rw-a4"]!, "RW-BODY-SENTINEL", "merged"]) assert.ok(!parent.includes(absent), absent);
	assert.ok(!JSON.stringify(s.requests()).includes("RW-BODY-SENTINEL"), "no report body in any request");
});

test("P1 recent work: overflow keeps the 8 KiB UTF-8 budget and names what was omitted", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const jobs = Array.from({ length: 12 * 4 }, (_, n) => ({
		id: `cp-rw${String(n).padStart(3, "0")}`, title: `RW ${"é".repeat(150)}`, status: "closed", labels: [`project:demo-${Math.floor(n / 4)}`, "delivery:pr"],
		blocked_by: [], comments: [], created_at: minutesAgo(60), updated_at: minutesAgo(n), closed_at: minutesAgo(n), close_reason: `landed ${"ü".repeat(250)}`,
	}));
	writeFile(join(home.path, LAYOUT.jobsFile), JSON.stringify({ schema_version: 1, prefix: "cp", jobs }));
	const digest = digestOf(await operatorRequest(t, home.path, "rw-overflow"));
	assert.ok(digest, "overflow still yields a digest");
	assert.ok(Buffer.byteLength(digest, "utf8") <= 8192, `${Buffer.byteLength(digest, "utf8")} bytes`);
	assert.match(digest, /more line\(s\) omitted \(8192-byte budget\)/);
	assert.match(digest, /… 2 more project\(s\) with 8 closed job\(s\) omitted/);
	assert.ok(digest.includes("cp-rw000") && !digest.includes("cp-rw047"), "newest kept, oldest project dropped");
});

test("P1 recent work: an unreadable ledger is named while standing orders still load", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	writeFile(join(home.path, LAYOUT.data, "standing-orders.md"), "- RW order survives.\n");
	writeFile(join(home.path, LAYOUT.jobsFile), "{ not json");
	const body = JSON.stringify(await operatorRequest(t, home.path, "rw-corrupt"));
	assert.match(body, /RW order survives/);
	assert.match(body, /Recent work unavailable: .*is not JSON/);
});

test("P1 recent work: parent compaction and rotation refresh the digest once; an unchanged resume adds nothing", { timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("rw-life", [{ kind: "text", text: "Done." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } } });
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "parent.json"), "{}");
	const previous = { ...process.env };
	Object.assign(process.env, agent.env);
	const bridge = new CpBridge();
	t.after(async () => {
		await bridge.stop();
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
		agent.cleanup(); await provider.stop(); home.cleanup();
	});
	const start = () => bridge.start({ home: home.path, mode: "multi", model, cwd: home.path, commandPostExtension: COMMAND_POST_EXTENSION });
	const send = async (text: string) => {
		await bridge.send(text);
		await waitFor(() => bridge.status().sends, (sends) => sends.every((entry) => entry.state === "settled"), { timeoutMs: 10_000, what: `${text} settled` });
		return JSON.stringify(provider.requests("rw-life").at(-1)?.body);
	};
	const count = (input: string, text: string) => input.split(text).length - 1;
	const closeOne = async (title: string) => {
		const ledger = new Ledger({ home: home.path });
		await ledger.close((await ledger.create({ title, project: "demo-app", delivery: "pr", kind: "ship" })).id, `landed ${title}`);
	};
	await start();
	assert.equal(count(await send("Begin."), HEADER), 0, "an empty ledger adds no section");
	await closeOne("RW lifecycle first");
	await bridge.compact();
	const compacted = await send("Continue.");
	assert.equal(count(compacted, "RW lifecycle first"), 2, "title and close reason, once"); // `"title"` plus `landed title`
	assert.equal(count(compacted, HEADER), 1);
	await bridge.stop();
	const requests = provider.requests("rw-life").length;
	await start();
	assert.equal(provider.requests("rw-life").length, requests, "resume starts no model turn");
	assert.equal(count(await send("Resume."), HEADER), 1, "unchanged resume adds no copy");
	await closeOne("RW lifecycle second");
	await bridge.rotate();
	const rotated = await send("After rotation.");
	assert.equal(count(rotated, HEADER), 1);
	assert.equal(count(rotated, "RW lifecycle second"), 2);
});
