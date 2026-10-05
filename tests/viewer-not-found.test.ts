import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import type { Route } from "../viewer-app/routes.ts";
import { REPO_ROOT } from "./harness/index.ts";

const result = await build({stdin:{contents:'import {h} from "preact"; import render from "preact-render-to-string"; import {NotFound, notFoundFor} from "./viewer-app/components/NotFound.tsx"; export {notFoundFor}; export const html=(props)=>render(h(NotFound,props));',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact",loader:{".css":"empty"}});
const {notFoundFor, html} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`) as {
	notFoundFor: (route: Route, code: number | undefined) => {title: string; back: {href: string; label: string}} | null;
	html: (props: {title: string; body: string; back: {href: string; label: string}; searchLabel: string}) => string;
};

const job = (jobId: string): Route => ({screen:"job", jobId, section:null});
const workers = (id: string): Route => ({screen:"sessions", section:null, query:`view=workers&id=${id}`});

test("notFoundFor maps only a 404 job or worker session", () => {
	const missing = notFoundFor(job("cp-x"), 404);
	assert.equal(missing?.title, "No job cp-x");
	assert.equal(missing?.back.href, "#jobs");
	assert.equal(missing?.back.label, "Back to Jobs");
	const worker = notFoundFor(workers("cp-w"), 404);
	assert.equal(worker?.title, "No worker session cp-w");
	assert.equal(worker?.back.href, "#sessions");
	for (const code of [403, 500, undefined]) assert.equal(notFoundFor(job("cp-x"), code), null, String(code));
	assert.equal(notFoundFor({screen:"sessions", section:null, query:"view=you&id=cp-w"}, 404), null);
	assert.equal(notFoundFor({screen:"jobs", section:null}, 404), null);
});

test("NotFound render has the back link and no alert", () => {
	const page = html({title:"No job cp-x", body:"It isn't in this home's ledger.", back:{href:"#jobs", label:"Back to Jobs"}, searchLabel:"Search jobs"});
	assert.match(page, /href="#jobs"/);
	assert.match(page, /Back to Jobs/);
	assert.match(page, /Search jobs/);
	assert.doesNotMatch(page, /role="alert"/);
});
