/**
 * Job reports as web pages: report.md rendered by ReportDocument (headings, tables, code, images from the job's own
 * artifact dir, raw HTML inert), served by `/api/report/<id>` with contained image reads, listed on Reports, linked
 * from the job detail, and opened on a fresh load of `#report/<id>`.
 */
import assert from "node:assert/strict";
import fs, { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mock, test } from "node:test";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import { createViewer, type ViewerOptions } from "../src/viewer/server.ts";
import { jobView } from "../src/viewer/jobs-view.ts";
import { reportsView } from "../src/viewer/reports-view.ts";
import type { JobReportResponse } from "../src/viewer/api-types.ts";
import { reportHref, route } from "../viewer-app/routes.ts";
import { LAYOUT } from "../src/contracts.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const REPORT = [
	"# Delta report",
	"Intro with **bold**, *italic*, `inline code` and [a link](https://example.com/x).",
	"## Findings",
	"### Table",
	"| Gap | Files |",
	"| --- | --- |",
	"| One | `src/a.ts` |",
	"",
	"```ts",
	"const x = 1 < 2;",
	"```",
	"",
	"> quoted line",
	"",
	"---",
	"",
	"![home screen](screenshots/home.png)",
	"",
	"<script>alert(1)</script>",
	"<img src=x onerror=alert(2)>",
	"",
	"![escape](../other-job/secret.png) ![root](/etc/passwd.png) ![svg](screenshots/a.svg)",
].join("\n");

const bundle = async (contents: string) => {
	const built = await build({ stdin: { contents, loader: "tsx", resolveDir: REPO_ROOT }, bundle: true, write: false, platform: "node", format: "esm", jsx: "automatic", jsxImportSource: "preact", loader: { ".css": "empty" } });
	return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`);
};

function fixture(t: { after(fn: () => void): void }): ViewerOptions {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	mkdirSync(join(home.path, LAYOUT.fleetFile, ".."), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.fleetFile), JSON.stringify({ jobs: [{ job_id: "cp-rep", project: "demo", phase: "done", dispatched_at: "2026-10-20T10:00:00Z" }, { job_id: "cp-none", project: "demo", phase: "done", dispatched_at: "2026-10-20T10:00:00Z" }] }));
	const dir = join(stateDir, "artifacts", "cp-rep");
	mkdirSync(join(dir, "screenshots"), { recursive: true });
	writeFileSync(join(dir, "report.md"), REPORT);
	writeFileSync(join(dir, "screenshots", "home.png"), "PNGBYTES");
	writeFileSync(join(dir, "screenshots", "a.svg"), "<svg onload='alert(3)'/>");
	mkdirSync(join(stateDir, "artifacts", "other-job"), { recursive: true });
	writeFileSync(join(stateDir, "artifacts", "other-job", "secret.png"), "SECRET");
	symlinkSync(join(stateDir, "artifacts", "other-job", "secret.png"), join(dir, "linked.png"));
	return { home: home.path, stateDir, host: "127.0.0.1", port: 0 };
}

async function serve(t: { after(fn: () => void): void }, options: ViewerOptions): Promise<string> {
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, options.host, resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	return `http://127.0.0.1:${options.port}`;
}

test("(a)(b)(c) a report renders as formatted HTML; raw HTML stays text; escaping image paths are refused", async () => {
	const { html } = await bundle('import {h} from "preact"; import render from "preact-render-to-string"; import {ReportDocument} from "./viewer-app/components/ReportDocument.tsx"; export const html=(text,jobId)=>render(h(ReportDocument,{text,jobId}));');
	const out: string = html(REPORT, "cp-rep");
	const doc = parseHTML(`<main>${out}</main>`).document;
	assert.deepEqual([...doc.querySelectorAll("h1,h2,h3")].map((e) => `${e.tagName}:${e.textContent}`), ["H1:Delta report", "H2:Findings", "H3:Table"]);
	assert.equal(doc.querySelector(".report-table table thead th")?.textContent, "Gap");
	assert.equal(doc.querySelector(".report-table td code")?.textContent, "src/a.ts");
	assert.equal(doc.querySelector("pre.report-code code")?.textContent, "const x = 1 < 2;");
	assert.equal(doc.querySelector("strong")?.textContent, "bold");
	assert.equal(doc.querySelector("em")?.textContent, "italic");
	assert.equal(doc.querySelector("blockquote p")?.textContent, "quoted line");
	assert.ok(doc.querySelector("hr"));
	const link = doc.querySelector('a[href="https://example.com/x"]');
	assert.equal(link?.getAttribute("target"), "_blank");
	assert.equal(link?.getAttribute("rel"), "noopener noreferrer");
	const images = [...doc.querySelectorAll("img")];
	assert.deepEqual(images.map((e) => e.getAttribute("src")), ["/api/report/cp-rep/files/screenshots/home.png"], "only the contained png is an image");
	assert.equal(images[0]?.getAttribute("alt"), "home screen");
	assert.equal(doc.querySelector("script"), null);
	assert.equal(doc.querySelector("[onerror], [onload]"), null);
	assert.doesNotMatch(out, /<script|<img src="?x/i, "raw HTML never becomes markup");
	assert.match(doc.querySelector(".report-doc")?.textContent ?? "", /<script>alert\(1\)<\/script>/, "raw HTML stays visible text");
	assert.deepEqual([...doc.querySelectorAll(".report-refused")].map((e) => e.textContent), ["image refused: escape", "image refused: root", "image refused: svg"]);
});

test("(c) /api/report serves report.md and contained images only; jobs and Reports link to it", async (t) => {
	const options = fixture(t);
	const url = await serve(t, options);
	const report = await fetch(`${url}/api/report/cp-rep`);
	assert.equal(report.status, 200);
	const data = (await report.json()) as JobReportResponse;
	assert.equal(data.title, "Delta report");
	assert.equal(data.text, REPORT);
	assert.equal(data.truncated, false);
	const image = await fetch(`${url}/api/report/cp-rep/files/screenshots/home.png`);
	assert.equal(image.status, 200);
	assert.equal(image.headers.get("content-type"), "image/png");
	assert.match(image.headers.get("content-security-policy") ?? "", /default-src 'none'/);
	assert.equal(await image.text(), "PNGBYTES");
	for (const path of ["..%2Fother-job%2Fsecret.png", "%2E%2E/other-job/secret.png", "linked.png", "screenshots/a.svg", "report.md", "screenshots/missing.png"]) {
		const refused = await fetch(`${url}/api/report/cp-rep/files/${path}`);
		assert.equal(refused.status, 404, path);
		assert.doesNotMatch(await refused.text(), /SECRET|svg/, path);
	}
	assert.equal((await fetch(`${url}/api/report/cp-none`)).status, 404);
	assert.equal((await fetch(`${url}/api/report/..%2Fother-job`)).status, 404);
	assert.equal(jobView(options, "cp-rep")?.report_href, "#report/cp-rep");
	assert.equal(jobView(options, "cp-none")?.report_href, null);
	assert.deepEqual(reportsView(options).job_reports?.map((r) => [r.job_id, r.title, r.href]), [["cp-rep", "Delta report", "#report/cp-rep"]]);
	assert.deepEqual(route(reportHref("cp-rep")), { screen: "report", jobId: "cp-rep", section: null });
	assert.equal(route("#report/../x").screen, "overview");
});

test("the job detail resolves only its own report, not every artifact dir, and still links it", async (t) => {
	const options = fixture(t);
	for (let i = 0; i < 300; i++) {
		mkdirSync(join(options.stateDir, "artifacts", `cp-bulk-${i}`), { recursive: true });
		writeFileSync(join(options.stateDir, "artifacts", `cp-bulk-${i}`, "report.md"), `# Bulk ${i}`);
	}
	const url = await serve(t, options);
	// Counts realpath/stat by artifact dir; before the fix jobView ran jobReports, touching all 300 dirs per request.
	const touched = new Set<string>();
	const artifacts = join(options.stateDir, "artifacts") + "/";
	const spy = (path: unknown) => { const rel = String(path).split(artifacts)[1]; if (rel) touched.add(rel.split("/")[0]!); };
	for (const name of ["realpathSync", "statSync", "lstatSync", "readdirSync", "openSync"] as const) {
		const original = fs[name] as (...args: unknown[]) => unknown;
		mock.method(fs, name, (...args: unknown[]) => { spy(args[0]); return original(...args); });
	}
	syncBuiltinESMExports();
	t.after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
	const res = await fetch(`${url}/api/job/cp-rep`);
	assert.equal(res.status, 200);
	assert.equal(((await res.json()) as { report_href: string | null }).report_href, "#report/cp-rep");
	assert.deepEqual([...touched], ["cp-rep"]);
});

test("(d)(e) a fresh load of #report/<id> renders the report, and the job detail links to it", async (t) => {
	const options = fixture(t);
	const url = await serve(t, options);
	const { act, mount, unmount } = await bundle('import {h,render} from "preact"; import {act} from "preact/test-utils"; import {App} from "./viewer-app/app.tsx"; export {act}; export const mount=root=>render(h(App,{}),root); export const unmount=root=>render(null,root);');
	const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
	const realFetch = globalThis.fetch;
	const originals = ["window", "document", "location", "fetch", "EventSource"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	const location = { hash: "#report/cp-rep" };
	const globals = { window, document, location, EventSource: class extends EventTarget { close() {} }, fetch: (path: string, init?: RequestInit) => realFetch(`${url}${path}`, init) };
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
	const root = document.getElementById("root")!;
	t.after(() => { unmount(root); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
	const load = async () => {
		await act(() => unmount(root));
		await act(() => mount(root));
		for (let i = 0; i < 50 && !root.querySelector(".report-doc, .job-detail"); i++) await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
	};
	await load();
	assert.equal(root.querySelector(".report-doc h1")?.textContent, "Delta report");
	assert.ok(root.querySelector(".report-doc .report-table table"));
	assert.equal(root.querySelector(".report-doc img")?.getAttribute("src"), "/api/report/cp-rep/files/screenshots/home.png");
	assert.ok(root.querySelector('.report-meta a[href="#job/cp-rep"]'), "the report links back to its job");
	location.hash = "#job/cp-rep";
	await load();
	assert.equal(root.querySelector('.job-report-links a[href="#report/cp-rep"]')?.textContent, "Report · report.md");
});
