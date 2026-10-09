/** The Settings model list: a fake `pi --list-models` (table rows, "No models available", a failure), cached with a TTL. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ListRun, modelLister } from "../src/viewer/model-list.ts";

const TABLE = "provider   model         context  max-out  thinking  images\nanthropic  claude-opus-5-5  200K  32K  yes  yes\nopenai     gpt-5         400K     128K     yes       yes\n";

function fake(...answers: Array<{ status: number; stdout: string } | Error>) {
	const calls = { n: 0 };
	const run: ListRun = async () => {
		const answer = answers[Math.min(calls.n++, answers.length - 1)]!;
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return { run, calls };
}

test("table rows become provider/id; the result is cached for 5 minutes and one run serves concurrent callers", async () => {
	let now = 0;
	const { run, calls } = fake({ status: 0, stdout: TABLE });
	const list = modelLister(run, () => now);
	const [a, b] = await Promise.all([list(), list()]);
	assert.deepEqual(a, { models: ["anthropic/claude-opus-5-5", "openai/gpt-5"], error: null });
	assert.equal(b, a);
	now = 299_000;
	await list();
	assert.equal(calls.n, 1);
	now = 301_000;
	await list();
	assert.equal(calls.n, 2, "stale after the TTL");
});

test("'No models available', an unreadable table, a non-zero exit and a throw are each a note, never an error; a failure retries after 30 s", async () => {
	for (const [answer, error] of [
		[{ status: 0, stdout: "No models available. Set up authentication first.\n" }, "pi lists no usable models"],
		[{ status: 0, stdout: "something else entirely" }, "model list unavailable"],
		[{ status: 1, stdout: TABLE }, "model list unavailable"],
		[new Error("spawn pi ENOENT"), "model list unavailable"],
	] as const) {
		let now = 0;
		const { run, calls } = fake(answer, { status: 0, stdout: TABLE });
		const list = modelLister(run, () => now);
		assert.deepEqual(await list(), { models: null, error });
		now = 29_000;
		assert.equal((await list()).error, error, "a failure is cached briefly");
		assert.equal(calls.n, 1);
		now = 31_000;
		assert.equal((await list()).error, null, "then pi is asked again");
	}
});
