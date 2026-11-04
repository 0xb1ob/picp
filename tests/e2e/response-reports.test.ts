/**
 * M2 PR1: long final answers become permanent response reports (src/response-reports.ts, the API PR2 and P1 call),
 * served by a real `bin/cp-view` and the remote listener's paired-device gate; short answers stay inline. M2 PR2 adds
 * the research entry point (a real parent's answer-card drain); cp_parent answer and schedules: decisions-bridge.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { AnswerCardOutbox } from "../../src/answer-delivery.ts";
import { LAYOUT, paths } from "../../src/contracts.ts";
import { initJobsDocument, Ledger } from "../../src/ledger.ts";
import { formatBytes } from "../../src/plan-view.ts";
import { deliverFinalAnswer, type FinalAnswerInput, publishResponseReport, RESPONSE_INLINE_MAX, responseReportSlug, responseReportUrl } from "../../src/response-reports.ts";
import { tunnelConfigFile, tunnelRuntimeFile } from "../../src/service/daemon-tunnel-files.ts";
import { startViewer } from "../harness/dashboard.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, startPiChild, waitFor } from "../harness/index.ts";
import { remoteRig } from "../harness/remote.ts";

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const URL_OPTS = { viewerHost: "127.0.0.2", viewerPort: 9911 };
const T0 = "2026-10-08T12:00:00Z";
/** Astral characters: 4,000 code points is 8,000 UTF-16 units, so a `.length` threshold would misfire. */
const astral = (n: number) => "\u{1F600}".repeat(n);

function home(t: TestContext) {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const boards = join(scratch.path, LAYOUT.state, "boards");
	return { path: scratch.path, boards, entries: () => (existsSync(boards) ? readdirSync(boards).sort() : []) };
}

const input = (patch: Partial<FinalAnswerInput> = {}): FinalAnswerInput => ({
	project: "demo", question: "How does the cache work?", answer: `Short version first.\n\n${"x".repeat(RESPONSE_INLINE_MAX)}`,
	evidence: ["https://example.test/a?b=1&c=2", "/repo/docs/cache.md"], job: "cp-r1", source: "chat:sess-1:call-1", time: T0, ...patch,
});

test("M2-report-threshold: 4,000 code points stay inline, 4,001 publish a served report whose hash is the canonical payload", async (t) => {
	const h = home(t);
	const inline = deliverFinalAnswer(h.path, input({ answer: astral(RESPONSE_INLINE_MAX) }), URL_OPTS);
	assert.deepEqual(inline, { delivery: "inline", state: "inline", text: astral(RESPONSE_INLINE_MAX), url: null, href: null });
	assert.deepEqual(h.entries(), [], "an inline answer publishes nothing");

	const long = input({ answer: `Headline paragraph.\n\n${astral(RESPONSE_INLINE_MAX)}` });
	const slug = responseReportSlug(long.source);
	assert.match(slug, /^report-[0-9a-f]{32}$/);
	const report = deliverFinalAnswer(h.path, long, URL_OPTS);
	assert.equal(report.delivery, "report");
	assert.equal(report.url, `http://127.0.0.2:9911/boards/${slug}/`);
	assert.deepEqual([report.state, report.href, report.text], ["posted", `/boards/${slug}/`, `Headline paragraph.\n\nFull answer: ${report.url}`]);

	const viewer = await startViewer(t, { home: h.path, requireTailnet: false });
	const content = await viewer.get(`/boards/${slug}/content.json`);
	assert.equal(content.status, 200);
	// Independently rebuilt canonical bytes: fixed key order, no whitespace, UTF-8.
	const canonical = JSON.stringify({ project: "demo", question: long.question, answer: long.answer, evidence: long.evidence, job: "cp-r1", source: long.source, time: T0 });
	assert.equal(content.text, canonical);
	const meta = JSON.parse(readFileSync(join(h.boards, slug, "board.json"), "utf8"));
	assert.deepEqual([meta.project, meta.source, meta.content_sha256, meta.created_at, meta.job_ids], ["demo", long.source, sha(Buffer.from(canonical, "utf8")), T0, []]);
	assert.equal(report.content_sha256, meta.content_sha256);
	const page = await viewer.get(`/boards/${slug}/`);
	assert.equal(page.status, 200);
	assert.equal(String(page.headers["content-security-policy"]).match(/script-src [^;]*/)?.[0], "script-src 'none'");
	assert.notEqual(sha(page.text), meta.content_sha256, "the HTML is never the hash input");
	assert.ok(page.text.includes(astral(RESPONSE_INLINE_MAX)));
	const listed = (await viewer.get("/api/reports")).body.reports as Array<Record<string, unknown>>;
	assert.deepEqual(listed.map((r) => [r.slug, r.href, r.project, r.source, r.content_sha256]), [[slug, `/boards/${slug}/`, "demo", long.source, meta.content_sha256]]);
	assert.deepEqual(h.entries(), [slug], "staging is cleaned");
});

test("M2-report-retry: a retry is a duplicate, a changed answer conflicts, tampering is refused, a restart still serves it", async (t) => {
	const h = home(t);
	const long = input();
	const first = publishResponseReport(h.path, long);
	const slug = first.slug;
	const files = () => ["board.json", "site/content.json", "site/index.html"].map((f) => readFileSync(join(h.boards, slug, f), "utf8"));
	const before = files() as [string, string, string];
	const retry = deliverFinalAnswer(h.path, { ...long, time: "2026-10-09T00:00:00Z" }, URL_OPTS);
	assert.deepEqual([retry.state, retry.delivery === "report" && retry.content_sha256], ["duplicate", first.content_sha256], "a retry keeps the original time and hash");
	assert.deepEqual(files(), before);
	assert.deepEqual(h.entries(), [slug], "never a second board");
	assert.throws(() => publishResponseReport(h.path, { ...long, answer: `${long.answer} changed` }), { code: "conflict", message: /already published/ });
	assert.deepEqual(files(), before, "a conflict overwrites nothing");

	const viewer = await startViewer(t, { home: h.path, requireTailnet: false });
	assert.equal((await viewer.get(`/boards/${slug}/`)).status, 200);
	await viewer.stop();
	const again = await startViewer(t, { home: h.path, requireTailnet: false });
	assert.equal((await again.get(`/boards/${slug}/content.json`)).text, before[1], "a restarted viewer serves the same report");

	writeFileSync(join(h.boards, slug, "site/index.html"), `${before[2]}<script>x</script>`);
	assert.throws(() => publishResponseReport(h.path, long), { code: "tampered", message: /index\.html/ });
	writeFileSync(join(h.boards, slug, "site/index.html"), before[2]);
	writeFileSync(join(h.boards, slug, "site/content.json"), before[1].replace("demo", "dem0"));
	assert.throws(() => publishResponseReport(h.path, long), { code: "tampered", message: /content_sha256/ });
});

test("M2-report-safety: hostile text is escaped, only http(s) evidence links, secrets refused, oversize fails with no URL", async (t) => {
	const h = home(t);
	const hostile = input({ question: `<script>alert(1)</script>"q'`, answer: `<img src=x onerror=alert(1)>&${"y".repeat(RESPONSE_INLINE_MAX)}`,
		evidence: ["javascript:alert(1)", "https://ok.example/p?a=1&b=<2>", "/home/me/notes.md"], source: "research:cp-r9#1" });
	const report = publishResponseReport(h.path, hostile);
	const html = readFileSync(join(h.boards, report.slug, "site/index.html"), "utf8");
	assert.doesNotMatch(html, /<script|<img|onerror=alert\(1\)>/);
	assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;q&#39;/);
	assert.match(html, /<a href="https:\/\/ok\.example\/p\?a=1&amp;b=&lt;2&gt;" rel="noopener noreferrer">/);
	assert.deepEqual(html.match(/<a href="[^"]*"/g), ['<a href="https://ok.example/p?a=1&amp;b=&lt;2&gt;"'], "javascript: and paths are text, not links");
	assert.match(html, /<code>javascript:alert\(1\)<\/code>/);

	const bearer = deliverFinalAnswer(h.path, input({ answer: `Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 ${"z".repeat(RESPONSE_INLINE_MAX)}`, source: "chat:s:2" }), URL_OPTS);
	assert.doesNotMatch(readFileSync(join(h.boards, responseReportSlug("chat:s:2"), "site/content.json"), "utf8"), /abcdefghijklmnop/, "redacted before publishing");
	assert.equal(bearer.delivery, "report");
	assert.throws(() => deliverFinalAnswer(h.path, input({ answer: "-----BEGIN RSA PRIVATE KEY-----", source: "chat:s:3" }), URL_OPTS), { code: "secret", message: /private key block/ });

	const before = h.entries();
	assert.throws(() => deliverFinalAnswer(h.path, input({ answer: "a b ".repeat(300_000), source: "chat:s:4" }), URL_OPTS), { code: "too_large", message: /input \d+ bytes > 1048576/ });
	// Under the input cap, but its escaped HTML pushes payload plus page past 1 MiB.
	assert.throws(() => deliverFinalAnswer(h.path, input({ answer: "< ".repeat(200_000), source: "chat:s:5" }), URL_OPTS), { code: "too_large", message: /too large: \d+ bytes > 1048576/ });
	assert.deepEqual(h.entries(), before, "oversize publishes nothing and leaves no staging");
	assert.throws(() => publishResponseReport(h.path, input({ source: "chat with spaces" })), { code: "invalid" });
});

test("M2-report-url: a running tunnel origin wins, else the configured viewer address; no address publishes with a relative link and its remedy", (t) => {
	const h = home(t);
	const slug = responseReportSlug("chat:s:url");
	assert.equal(responseReportUrl(h.path, slug, URL_OPTS).url, `http://127.0.0.2:9911/boards/${slug}/`);
	const dataDir = join(h.path, LAYOUT.data), stateDir = join(h.path, LAYOUT.state);
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(tunnelConfigFile(dataDir), JSON.stringify({ schema_version: 1, enabled: true, mode: "quick", port: 40123, binary: "/opt/cf/cloudflared", revision: 2 }));
	const runtime = (patch: Record<string, unknown>) => writeFileSync(tunnelRuntimeFile(stateDir), JSON.stringify({ schema_version: 1, origin: "https://amber-otter.trycloudflare.com",
		generation: 3, revision: 2, state: "running", mode: "quick", port: 40123, updated_at: T0, ...patch }));
	runtime({});
	assert.equal(responseReportUrl(h.path, slug, URL_OPTS).url, `https://amber-otter.trycloudflare.com/boards/${slug}/`);
	runtime({ revision: 1 });
	assert.equal(responseReportUrl(h.path, slug, URL_OPTS).url, `http://127.0.0.2:9911/boards/${slug}/`, "a runtime for another revision is not served");

	const bin = join(h.path, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "tailscale"), "#!/bin/sh\nexit 1\n");
	chmodSync(join(bin, "tailscale"), 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path ?? ""}`;
	try {
		const sent = deliverFinalAnswer(h.path, input({ source: "chat:s:url" }));
		assert.equal(sent.url, `/boards/${slug}/`);
		assert.match(sent.text, new RegExp(`Full answer: /boards/${slug}/\\n\\(relative link: .*Settings → Dashboard address → Public URL .*cp-install --viewer-host`));
	} finally { process.env.PATH = path; }
	assert.deepEqual(h.entries(), [slug], "no address: the report is still published, never refused");
});

test("M2-report-remote: a paired device reads a report over the remote listener; unpaired and revoked callers get 401", async (t) => {
	const rig = await remoteRig(t);
	const report = publishResponseReport(rig.home.path, input({ source: "schedule:run-1:cp-r1:1" }));
	assert.equal((await rig.r(report.href)).status, 401);
	const phone = rig.pair("phone", "view");
	const read = await rig.r(`${report.href}content.json`, { headers: { cookie: phone.cookie } });
	assert.deepEqual([read.status, read.body.source], [200, "schedule:run-1:cp-r1:1"]);
	assert.ok(rig.store.revoke(phone.id).ok);
	assert.equal((await rig.r(report.href, { headers: { cookie: phone.cookie } })).status, 401);
});

// M2 PR2 research entry point: the parent's answer-card drain publishes a long answer before it accepts the card.
test("M2-report-research: a long research answer reaches the operator as a report link, a short one keeps its card, a failed publication stays pending", { timeout: 120_000 }, async (t) => {
	const h = home(t);
	initJobsDocument(h.path, "cp");
	const ledger = new Ledger({ home: h.path });
	const queue = async (title: string, body: string) => {
		const job = (await ledger.create({ title, project: "demo", kind: "research", delivery: "answer" })).id;
		const path = join(h.path, paths.artifactFile(job));
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, body);
		assert.ok(new AnswerCardOutbox({ home: h.path }).enqueue({ job_id: job, project: "demo", generation: 1, summary: `${title} headline`, path, bytes: Buffer.byteLength(body), reported_at: T0 }));
		return { job, path };
	};
	const longBody = `Long answer.\n\n${astral(RESPONSE_INLINE_MAX)}`;
	const long = await queue("Long", longBody), short = await queue("Short", "Short answer.\n"), stuck = await queue("Stuck", longBody);
	// A report already published for the stuck card's source with other content: its publication must conflict.
	publishResponseReport(h.path, input({ source: `research:${stuck.job}#1`, answer: "Other." }));
	const provider = await MockProvider.start();
	const model = provider.addScript("m2-research", [{ kind: "text", text: "Idle." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	t.after(async () => { agent.cleanup(); await provider.stop(); });
	const pi = startPiChild({ cwd: h.path, model, env: { ...agent.env, CP_HOME: h.path, CP_VIEWER_HOST: "127.0.0.2", CP_VIEWER_PORT: "9911" }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(() => pi.close().then(() => undefined));
	const notes = (prefix: string) => pi.records().filter((r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).startsWith(prefix)).map((r) => String(r.message));
	await waitFor(() => notes("answer for ").length, (count) => count === 2, { timeoutMs: 30_000, what: "the long and short cards" });
	await waitFor(() => notes(`answer report for ${stuck.job}#1`).length, (count) => count > 0, { timeoutMs: 30_000, what: "the stuck card's warning" });

	const slug = responseReportSlug(`research:${long.job}#1`);
	assert.deepEqual(notes("answer for "), [
		`answer for ${long.job}: http://127.0.0.2:9911/boards/${slug}/ (${formatBytes(Buffer.byteLength(longBody))}) — the full answer is a permanent report`,
		`answer for ${short.job}: ${short.path} (${formatBytes(14)}) — open it yourself; the card needs a terminal`,
	]);
	const payload = JSON.parse(readFileSync(join(h.boards, slug, "site", "content.json"), "utf8")) as Record<string, unknown>;
	assert.deepEqual([payload.answer, payload.job, payload.evidence, payload.time], [longBody, long.job, [long.path], T0]);
	assert.match(notes(`answer report for ${stuck.job}#1`)[0]!, /is still pending: response report conflict/);
	const cards = new AnswerCardOutbox({ home: h.path }).read();
	assert.deepEqual([cards.pending.map((card) => card.job_id), cards.delivered.map((entry) => entry.job_id)], [[stuck.job], [long.job, short.job]]);
	assert.equal(h.entries().length, 2, "the long report and the conflicting one; the short answer publishes nothing");
	await new Promise((resolve) => setTimeout(resolve, 6_000));
	assert.equal(notes(`answer report for ${stuck.job}#1`).length, 1, "a repeated failure is not re-announced every tick");
});
