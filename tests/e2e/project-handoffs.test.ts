/**
 * P6 project handoffs: operator/handoffs, state/operator/compact-* and an in-home handoffs_dir are indexed by
 * project at read time (exact job ids, project names on token boundaries, repo URLs), joined to answers and reports,
 * and reach the fresh parent, the fresh operator, `cp_parent jobs show`, GET /api/handoffs and Reports as pointers.
 */
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT, paths } from "../../src/contracts.ts";
import { ProjectRegistry } from "../../src/projects.ts";
import { startViewer } from "../harness/dashboard.ts";
import { CP_BRIDGE_EXTENSION, createAgentDir, createScratchHome, MockProvider, startRpc } from "../harness/index.ts";
import { bench, type End, type Ends, job, text } from "./project-tracker-helpers.ts";

const SENTINELS = /PH-BODY-SENTINEL|PH-OUTSIDE-SENTINEL|PH-ANSWER-SENTINEL|PH-REPORT-SENTINEL/;
const put = (file: string, body: string, ageSeconds?: number) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, body);
	if (ageSeconds !== undefined) { const at = Date.now() / 1000 - ageSeconds; utimesSync(file, at, at); }
};
/** The handoff section as it sits in a provider request: from its header to the end of its JSON string, decoded. */
const sectionOf = (body: unknown): string | undefined => {
	const raw = /Project handoffs \((?:[^"\\]|\\.)*/.exec(JSON.stringify(body))?.[0];
	return raw === undefined ? undefined : JSON.parse(`"${raw}"`);
};
/** Every file under `dir` with its size and mtime: a GET must leave this unchanged. */
const tree = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: "utf8" }).sort()
	.map((name) => { const stat = statSync(join(dir, name), { throwIfNoEntry: false }); return `${name} ${stat?.size} ${stat?.mtimeMs}`; });

/** Interleaved notes across all three roots, one symlink escape, one oversize note, an answer and a report. */
function seed(home: string, alphaId: string, betaId: string) {
	const handoffs = join(home, LAYOUT.operatorWorkspace, "handoffs"), configured = join(home, "notes");
	put(join(home, LAYOUT.data, "operator.json"), JSON.stringify({ handoffs_dir: configured }));
	const file = {
		mixed: join(handoffs, "mixed.md"), prose: join(handoffs, "prose.md"), alpha: join(handoffs, "ph-alpha-notes.md"), big: join(handoffs, "big.md"),
		compact: join(home, LAYOUT.state, "operator", "compact-2026-03-01T00:00:00.000Z.md"), configured: join(configured, "configured.md"), escape: join(handoffs, "escape.md"),
	};
	put(file.mixed, "PH-BODY-SENTINEL [ph-demo] waits on https://github.com/acme/ph-other/pull/7.\n", 100);
	// Near misses on every boundary: a longer name, a plural, a longer job id and a sibling repository.
	put(file.prose, `PH-BODY-SENTINEL general notes: ph-demo-extra, ph-demos, ${alphaId}-2, https://github.com/acme/ph-demo-two/pull/1\n`, 200);
	put(file.configured, `PH-BODY-SENTINEL see https://github.com/acme/ph-other.git for ${betaId}\n`, 2000);
	put(file.compact, "PH-BODY-SENTINEL compaction: ph-demo follow-up\n", 3000);
	put(file.big, `PH-BODY-SENTINEL ${"x ".repeat(36 * 1024)} ${betaId}\n`, 4000);
	put(file.alpha, `PH-BODY-SENTINEL picked up ${alphaId} again\n`, 5000);
	put(join(home, "outside.md"), "PH-OUTSIDE-SENTINEL ph-demo\n", 9000);
	symlinkSync(join(home, "outside.md"), file.escape);
	put(join(home, LAYOUT.state, "operator", "answers.jsonl"), `${JSON.stringify({ type: "posted", by: "bridge", id: "ans-0123456789ab", at: "2026-03-01T00:00:00Z",
		project: "ph-demo", question: "q", answer: "PH-ANSWER-SENTINEL", evidence_paths: [file.configured], job_id: alphaId })}\n`);
	put(join(home, paths.artifactFile(alphaId)), "# Alpha report\nPH-REPORT-SENTINEL\n");
	return file;
}

/** One fresh operator session (cp-bridge only), reading `cp_parent jobs show <jobId>` if given; first request, ends. */
async function operator(home: string, jobId?: string): Promise<{ body: unknown; ends: Ends }> {
	const provider = await MockProvider.start();
	const show = jobId ? [{ kind: "tool_calls" as const, calls: [{ id: "show", name: "cp_parent", args: { action: "jobs", jobs: { mode: "show", job_id: jobId } } }] }] : [];
	const model = provider.addScript("ph-operator", [...show, { kind: "text", text: "read" }]);
	const agent = createAgentDir({ provider });
	const rpc = startRpc({ cwd: home, env: { ...agent.env, PI_HOME: home, CP_HOME: home }, args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--no-session", "--model", model] });
	try {
		rpc.send({ type: "prompt", id: "ph", message: "Read the supplied operator context." });
		await rpc.waitFor((r) => r.type === "agent_settled", 120_000);
		return { body: provider.requests("ph-operator")[0]?.body, ends: new Map(rpc.records().filter((r) => r.type === "tool_execution_end").map((r) => [String(r.toolCallId), r as End])) };
	} finally {
		await rpc.close(); agent.cleanup(); await provider.stop();
	}
}

test("P6 project handoffs: fresh parent and operator, cp_parent jobs, HTTP and Reports index notes by project, never bodies", { timeout: 300_000 }, async (t) => {
	const s = await bench(t, "ph");
	for (const name of ["ph-demo", "ph-other"]) await new ProjectRegistry({ home: s.home }).register({ name, clone_url: `https://github.com/acme/${name}.git` });
	await s.session("Record the work.", [
		job("c-alpha", { action: "create", title: "ph-alpha", project: "ph-demo", delivery: "pr", kind: "ship" }),
		job("c-beta", { action: "create", title: "ph-beta", project: "ph-other", delivery: "pr", kind: "ship" }),
	]);
	const alphaId = s.idOf("ph-alpha"), betaId = s.idOf("ph-beta");
	const file = seed(s.home, alphaId, betaId);
	const before = s.requests().length;
	await s.session("Say what recently happened.", []);
	const parent = sectionOf(s.requests()[before]?.body);
	const fresh = await operator(s.home, alphaId);
	const context = sectionOf(fresh.body);
	assert.ok(parent, "the fresh parent gets the handoff pointers");
	assert.equal(context, parent, "parent and operator see the same pointers");
	const lines = parent.split("\n");
	assert.deepEqual(lines.slice(1, 9), [
		"[ph-demo]", `- ${file.mixed} (modified ${new Date(statSync(file.mixed).mtimeMs).toISOString()}; matched ph-demo)`,
		`- ${file.compact} (modified ${new Date(statSync(file.compact).mtimeMs).toISOString()}; matched ph-demo)`, "  … 1 older in ph-demo",
		"[ph-other]", `- ${file.mixed} (modified ${new Date(statSync(file.mixed).mtimeMs).toISOString()}; matched ph-other, https://github.com/acme/ph-other/pull/7)`,
		`- ${file.configured} (modified ${new Date(statSync(file.configured).mtimeMs).toISOString()}; matched ph-other, ${betaId}, https://github.com/acme/ph-other.git)`,
		"2 unassociated handoff(s): no job id, project name or repository URL",
	], parent);
	assert.match(parent, /Source limited: bounds: 1 file\(s\) matched on their first 65536 bytes only\nSource limited: confinement: 1 file\(s\) resolve outside/);
	assert.doesNotMatch(parent, /prose\.md|big\.md|escape\.md/, "unassociated and refused notes are counted, not listed");
	for (const body of [JSON.stringify(s.requests()[before]?.body), JSON.stringify(fresh.body)]) assert.doesNotMatch(body, SENTINELS, "never a note body");
	assert.ok(JSON.stringify(fresh.body).includes(`Newest handoff: ${file.mixed}`), "the legacy newest-handoff pointer stays");
	const show = text(fresh.ends, "show");
	assert.match(show, new RegExp(`^ {2}handoff: ${file.alpha.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), show);
	assert.match(show, /handoff: scan incomplete/);
	assert.doesNotMatch(show, SENTINELS);

	const viewer = await startViewer(t, { home: s.home });
	const runtime = join(s.home, ".pi-command-post");
	const snapshot = tree(runtime);
	const all = await viewer.get("/api/handoffs");
	assert.equal(all.status, 200, all.text);
	assert.doesNotMatch(all.text, SENTINELS);
	type Pointer = { name: string; root: string; href: string; truncated: boolean; evidence: Array<{ kind: string; value: string; project: string | null }>; answers: Array<{ id: string }>; reports: Array<{ job_id: string; href: string }> };
	type View = { project: string | null; projects: string[]; groups: Array<{ project: string; handoffs: Pointer[] }>; unassociated: Pointer[]; sources: Array<{ root: string; state: string }>;
		complete: boolean; scanned: number; skipped: number; truncated: number; escaped: number; warnings: Array<{ section: string }> };
	const body = all.body as unknown as View;
	const names = (pointers: Pointer[]) => pointers.map((pointer) => pointer.name);
	assert.deepEqual(body.groups.map((group) => [group.project, names(group.handoffs)]), [
		["ph-demo", ["mixed.md", "compact-2026-03-01T00:00:00.000Z.md", "ph-alpha-notes.md"]], ["ph-other", ["mixed.md", "configured.md"]]]);
	assert.deepEqual(names(body.unassociated), ["prose.md", "big.md"]);
	assert.deepEqual([body.complete, body.scanned, body.skipped, body.truncated, body.escaped], [false, 6, 0, 1, 1]);
	assert.deepEqual(body.sources.map((source) => [source.root, source.state]), [["handoffs", "ok"], ["compact", "ok"], ["configured", "ok"]]);
	const alpha = body.groups[0]!.handoffs[2]!;
	assert.deepEqual(alpha.evidence, [{ kind: "job", value: alphaId, project: "ph-demo" }]);
	assert.deepEqual([alpha.answers.map((a) => a.id), alpha.reports], [["ans-0123456789ab"], [{ job_id: alphaId, href: `#report/${alphaId}` }]]);
	assert.deepEqual(body.groups[1]!.handoffs[1]!.answers.map((a) => a.id), ["ans-0123456789ab"], "an answer citing the note by path joins it");
	assert.deepEqual(body.groups[0]!.handoffs[0]!.evidence.map((e) => [e.kind, e.value, e.project]), [
		["project", "ph-demo", "ph-demo"], ["project", "ph-other", "ph-other"], ["repo", "https://github.com/acme/ph-other/pull/7", "ph-other"]]);
	assert.deepEqual(body.unassociated.map((p) => [p.name, p.evidence, p.truncated]), [["prose.md", [], false], ["big.md", [], true]], "near misses and a cut-off id match nothing");

	const demo = (await viewer.get("/api/handoffs?project=ph-demo")).body as unknown as View;
	assert.deepEqual([demo.project, demo.groups.map((g) => g.project), demo.unassociated, demo.projects], ["ph-demo", ["ph-demo"], [], ["ph-demo", "ph-other"]]);
	assert.equal((await viewer.get("/api/handoffs?project=..%2Fx")).status, 400);
	const detail = await viewer.get(alpha.href);
	assert.deepEqual([detail.status, detail.text], [200, `PH-BODY-SENTINEL picked up ${alphaId} again\n`]);
	const big = await viewer.get(body.unassociated[1]!.href);
	assert.match(big.text, /\[truncated: first 65536 of \d+ bytes\]\n$/);
	assert.ok(!big.text.includes(betaId), "the id past 64 KiB is never served");
	for (const refused of ["/api/handoffs/file/handoffs/escape.md", "/api/handoffs/file/handoffs/..%2F..%2Fjobs.json", "/api/handoffs/file/compact/prose.md", "/api/handoffs/file/elsewhere/mixed.md"]) {
		const reply = await viewer.get(refused);
		assert.equal(reply.status, 404, refused);
		assert.doesNotMatch(reply.text, SENTINELS, refused);
	}
	assert.deepEqual(tree(runtime), snapshot, "GET writes nothing");

	const local = await startViewer(t, { home: s.home, requireTailnet: false });
	assert.equal((await local.get(alpha.href)).status, 403, "a note body needs the operator-transcript read gate");
	assert.equal((await local.get("/api/handoffs")).status, 200, "the pointer list does not");

	const tab = await viewer.open("#reports");
	assert.equal((await tab.find(".reports-handoffs-link")).getAttribute("href"), "#reports?view=handoffs");
	tab.go("#reports?view=handoffs&project=ph-demo");
	await tab.find(`.handoff-row a[href='${alpha.href}']`);
	assert.equal(tab.$$(".handoff-row").length, 3);
	assert.ok(tab.text().includes(`Report ${alphaId}`) && tab.text().includes("Answer ans-0123456789ab"), tab.text());
	assert.match(tab.text(), /Incomplete: 6 scanned, 0 not scanned, 1 matched on their first 64 KiB only, 1 refused for leaving their directory/);
});

test("P6 project handoffs: missing roots are named, empty and unwritten", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const viewer = await startViewer(t, { home: home.path });
	const reply = await viewer.get("/api/handoffs");
	const body = reply.body as { groups: unknown[]; unassociated: unknown[]; sources: Array<{ root: string; state: string }>; complete: boolean; warnings: unknown[] };
	assert.deepEqual([reply.status, body.groups, body.unassociated, body.complete, body.warnings], [200, [], [], true, []]);
	assert.deepEqual(body.sources.map((source) => [source.root, source.state]), [["handoffs", "missing"], ["compact", "missing"]]);
	assert.equal(statSync(join(home.path, LAYOUT.operatorWorkspace), { throwIfNoEntry: false }), undefined, "a read creates no workspace");
	assert.equal((await viewer.get("/api/handoffs/file/handoffs/a.md")).status, 404);
});

// An escape alone, and a handoffs_dir outside the home, match no project yet must read as incomplete, never as
// "nothing happened": the API says complete:false and the fresh operator context keeps the warning.
for (const [label, setup, section, warning] of [
	["escape-only", (home: string) => {
		put(join(home, "outside.md"), "PH-OUTSIDE-SENTINEL\n");
		mkdirSync(join(home, LAYOUT.operatorWorkspace, "handoffs"), { recursive: true });
		symlinkSync(join(home, "outside.md"), join(home, LAYOUT.operatorWorkspace, "handoffs", "escape.md"));
	}, "confinement", /Source limited: confinement: 1 file\(s\) resolve outside their directory and are refused/],
	["refused-root", (home: string) => put(join(home, LAYOUT.data, "operator.json"), JSON.stringify({ handoffs_dir: dirname(home) })),
		"source configured", /Source limited: source configured: refused: /],
] as const) {
	test(`P6 project handoffs: ${label} is incomplete in the API and in fresh context`, { timeout: 120_000 }, async (t) => {
		const home = createScratchHome();
		t.after(() => home.cleanup());
		setup(home.path);
		const reply = await startViewer(t, { home: home.path }).then((viewer) => viewer.get("/api/handoffs"));
		const body = reply.body as { groups: unknown[]; complete: boolean; warnings: Array<{ section: string }> };
		assert.deepEqual([reply.status, body.groups, body.complete, body.warnings.map((w) => w.section)], [200, [], false, [section]], reply.text);
		const context = sectionOf((await operator(home.path)).body);
		assert.ok(context, "an incomplete scan with no match still reaches fresh context");
		assert.match(context, /No scanned note names a job, project or repository\./);
		assert.match(context, warning);
		assert.doesNotMatch(context, SENTINELS);
	});
}
