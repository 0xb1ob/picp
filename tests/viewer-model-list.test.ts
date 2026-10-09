/** The Settings model list: a fake `pi --list-models` (table rows, "No models available", a failure), cached with a TTL and never awaited. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ListRun, modelLister } from "../src/viewer/model-list.ts";

const TABLE = "provider   model         context  max-out  thinking  images\nanthropic  claude-opus-5-5  200K  32K  yes  yes\nopenai     gpt-5         400K     128K     yes       yes\n";
const LOADING = { models: null, error: null, loading: true };
const tick = () => new Promise((done) => setImmediate(done));

function fake(...answers: Array<{ status: number; stdout: string } | Error>) {
	const calls = { n: 0 };
	const run: ListRun = async () => {
		const answer = answers[Math.min(calls.n++, answers.length - 1)]!;
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return { run, calls };
}

/** A run that stays pending until `finish`. */
function slow() {
	const calls = { n: 0 };
	let finish: (out: { status: number; stdout: string }) => void = () => {};
	const run: ListRun = () => { calls.n++; return new Promise((resolve) => { finish = resolve; }); };
	return { run, calls, finish: (out: { status: number; stdout: string }) => finish(out) };
}

test("a slow listing never blocks: the call answers `loading` at once, one background run is shared, the list arrives when it lands", async () => {
	const pi = slow();
	const list = modelLister(pi.run);
	assert.deepEqual(list(), LOADING);
	assert.deepEqual(list(), LOADING);
	assert.equal(pi.calls.n, 1, "concurrent callers share one run");
	pi.finish({ status: 0, stdout: TABLE });
	await tick();
	assert.deepEqual(list(), { models: ["anthropic/claude-opus-5-5", "openai/gpt-5"], error: null, loading: false });
	assert.equal(pi.calls.n, 1);
});

test("a good list is fresh for 5 minutes; after that the stale list is served while one background run refreshes it", async () => {
	let now = 0;
	const pi = slow();
	const list = modelLister(pi.run, () => now);
	list();
	pi.finish({ status: 0, stdout: TABLE });
	await tick();
	now = 299_000;
	list();
	assert.equal(pi.calls.n, 1);
	now = 301_000;
	const stale = list();
	assert.deepEqual(stale.models, ["anthropic/claude-opus-5-5", "openai/gpt-5"], "the stale list answers at once");
	list();
	assert.equal(pi.calls.n, 2, "one refresh, not two");
	pi.finish({ status: 0, stdout: "provider model\nopenai gpt-6.1-sol\n" });
	await tick();
	assert.deepEqual(list().models, ["openai/gpt-6.1-sol"]);
});

test("'No models available', an unreadable table, a non-zero exit and a throw are each a note, never an error; a failure is asked again after 30 s", async () => {
	for (const [answer, error] of [
		[{ status: 0, stdout: "No models available. Set up authentication first.\n" }, "pi lists no usable models"],
		[{ status: 0, stdout: "something else entirely" }, "model list unavailable"],
		[{ status: 1, stdout: TABLE }, "model list unavailable"],
		[new Error("spawn pi ENOENT"), "model list unavailable"],
	] as const) {
		let now = 0;
		const { run, calls } = fake(answer, { status: 0, stdout: TABLE });
		const list = modelLister(run, () => now);
		assert.deepEqual(list(), LOADING);
		await tick();
		assert.deepEqual(list(), { models: null, error, loading: false });
		now = 29_000;
		assert.equal(list().error, error, "a failure is cached briefly");
		assert.equal(calls.n, 1);
		now = 31_000;
		assert.equal(list().error, error, "the failure is served while pi is asked again");
		await tick();
		assert.equal(calls.n, 2);
		assert.equal(list().error, null);
	}
});
