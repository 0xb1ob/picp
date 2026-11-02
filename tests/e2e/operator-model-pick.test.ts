/**
 * R1 D2: the operator's one-job model pick, issued by the real cp-bridge (`cp_parent model_pick`) in an RPC operator
 * with a persisted session, then honoured once by a real CommandPost dispatch over the mock provider.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { saveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { CommandPost } from "../../src/command-post.ts";
import { LAYOUT, type OperatorModelPickReference, THINKING_LEVELS } from "../../src/contracts.ts";
import { modelPicksDir } from "../../src/operator-model-pick.ts";
import { acquireParentLock } from "../../src/parent-lock.ts";
import { renderEvents } from "../../src/watch.ts";
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import { CP_BRIDGE_EXTENSION, readRunEvents, REPO_ROOT, startPiChild, waitFor } from "../harness/index.ts";

type End = { toolCallId: string; isError?: boolean; result: { details?: { operator_quote?: OperatorModelPickReference }; content?: Array<{ text?: string }> } };
const textOf = (end: End | undefined): string => (end?.result.content ?? []).map((part) => part.text ?? "").join("\n");

test("D2-pick: the bridge issues a pick only from the human's own words; the parent honours it once, previews read-only, refuses reuse, edits and old bridges, and keeps every other gate", { timeout: 300_000 }, async (t) => {
	const b = await dispatchS29(t);
	const picked = b.provider.addScript("d2-picked", [{ kind: "text", text: "working" }], { onExhausted: "repeat" });
	const routed = b.provider.addScript("d2-routed", [{ kind: "text", text: "working" }], { onExhausted: "repeat" });
	const prefix = picked.slice(0, -1);
	const quote = `use ${picked} for this one`;
	const pickCall = (id: string, args: Record<string, unknown>) => ({ id, name: "cp_parent", args: { action: "model_pick", model: picked, quote, ...args } });
	const titles = ["pick a model", "reuse a pick", "queue a pick"];
	const [ship, other, queued] = (await Promise.all(titles.map(async (title) => (await b.ledger.create({ title, project: "demo", delivery: "pr", kind: "ship" })).id))) as [string, string, string];
	const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	const operatorModel = b.provider.addScript("d2-operator", [
		{ kind: "text", text: `I suggest ${picked} for this one.` },
		{ kind: "tool_calls", calls: [{ id: "assistant", name: "cp_parent", args: { action: "model_pick", model: picked, quote: `${picked} for this one` } }] },
		{ kind: "text", text: "refused" },
		{ kind: "tool_calls", calls: [pickCall("bound", { job_id: ship }), pickCall("free", {}), pickCall("queue", {}), pickCall("prefix", { model: prefix })] },
		{ kind: "text", text: "issued" },
	]);
	b.agent.writeModels(b.provider);
	writeFileSync(join(b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: ["mock/*"], rubric: [{ id: "small-ship", role: "implementer", model: routed }] }));

	// The operator: a real cp-bridge whose session persists, so the parent can re-read the human's entry.
	saveOperatorTarget({ home: b.home, mode: "multi", hostPid: 0, parentPid: 0 }, { PI_HOME: b.home });
	const op = startPiChild({ cwd: b.home, model: operatorModel, extensions: [CP_BRIDGE_EXTENSION], sessionDir: join(b.home, "operator-sessions"), env: { ...b.agent.env, PI_HOME: b.home, CP_HOME: b.home } });
	t.after(() => op.close());
	for (const [n, message] of ["hello", "pick it", `Please ${quote}.`].entries()) {
		await op.prompt(message);
		await waitFor(() => op.eventsOfType("agent_settled").length, (count) => count > n, { timeoutMs: 60_000, what: `operator turn ${n}` });
	}
	const ends = op.eventsOfType("tool_execution_end") as unknown as End[];
	const end = (id: string) => ends.find((each) => each.toolCallId === id);
	assert.match(textOf(end("assistant")), /operator_pick_main_session_authored/, "the operator's model saying it is no pick");
	assert.match(textOf(end("prefix")), new RegExp(`operator_pick_fabricated: the quote does not name ${esc(prefix)} as a whole provider/model token`));
	const [bound, free, queuedRef] = ["bound", "free", "queue"].map((id) => {
		assert.notEqual(end(id)?.isError, true, textOf(end(id)));
		return end(id)!.result.details!.operator_quote!;
	}) as [OperatorModelPickReference, OperatorModelPickReference, OperatorModelPickReference];
	await op.close();

	const lock = acquireParentLock({ home: b.home });
	assert.equal(lock.ok, true);
	if (lock.ok) t.after(() => lock.lock.release());
	const post = b.ownPost(new CommandPost({ home: b.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...b.agent.env } }));
	const claims = () => (existsSync(join(modelPicksDir(b.home), "claims")) ? readdirSync(join(modelPicksDir(b.home), "claims")).sort() : []);
	const refusal = (request: Parameters<CommandPost["dispatch"]>[0]) => post.dispatch(request).then(() => "accepted", (error: Error) => error.message);
	const unrouted = new RegExp(`override names ${esc(picked)}, which data/routing\\.json does not route`);

	// Preserved gate: without a quote the unrouted model is refused exactly as before; a preview never spends the pick.
	const plain = await post.previewDispatch({ jobId: ship, task: "tidy", model: picked });
	assert.match(`${plain.error ?? ""}`, unrouted);
	assert.match(await refusal({ jobId: ship, task: "tidy", model: picked }), unrouted);
	const preview = await post.previewDispatch({ jobId: ship, task: "tidy", model: picked, operatorQuote: bound });
	assert.deepEqual([preview.decision?.model, preview.decision?.source, claims()], [picked, "override", []]);
	// Old bridges: no proof behind a reference, or a reference version this parent does not read, is a named refusal.
	assert.match(await refusal({ jobId: ship, task: "tidy", model: picked, operatorQuote: { ...bound, proof_id: `omp-${"f".repeat(32)}` } }), /operator_pick_missing: .*an older bridge cannot/);
	assert.match(await refusal({ jobId: ship, task: "tidy", model: picked, operatorQuote: { ...bound, version: 2 as 1 } }), /operator_pick_bridge_unsupported/);
	assert.match(await refusal({ jobId: ship, task: "tidy", model: prefix, operatorQuote: bound }), new RegExp(`operator_pick_fabricated: proof \\S+ picks ${esc(picked)}, not ${esc(prefix)};`));
	assert.match(await refusal({ jobId: other, task: "tidy", model: picked, operatorQuote: bound }), /operator_pick_fabricated: proof \S+ is bound to /);
	// The allowlist still gates a pick.
	writeFileSync(join(b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: [routed], rubric: [{ id: "small-ship", role: "implementer", model: routed }] }));
	assert.match(await refusal({ jobId: ship, task: "tidy", model: picked, operatorQuote: bound }), /allowlist refuses/);
	writeFileSync(join(b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: ["mock/*"], rubric: [{ id: "small-ship", role: "implementer", model: routed }] }));
	// Availability and effort still gate a pick: pi's registry, stubbed at its edge, lacks auth, then serves only low effort.
	const thinkingLevelMap = Object.fromEntries(THINKING_LEVELS.map((level) => [level, level === "low" ? "low" : null]));
	const gated = (auth: boolean) => b.ownPost(new CommandPost({ home: b.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...b.agent.env },
		modelRegistry: () => ({ find: (provider: string, id: string) => ({ provider, id, reasoning: true, thinkingLevelMap }), hasConfiguredAuth: () => auth }) }));
	const via = (p: CommandPost, request: Parameters<CommandPost["dispatch"]>[0]) => p.dispatch(request).then(() => "accepted", (error: Error) => error.message);
	assert.match(await via(gated(false), { jobId: ship, task: "tidy", model: picked, operatorQuote: bound }), new RegExp(`${esc(picked)} \\(override, .*is not usable`));
	assert.match(await via(gated(true), { jobId: ship, task: "tidy", model: picked, thinking: "high", operatorQuote: bound }), /asks for thinking=high, which .* cannot serve/);
	assert.deepEqual(claims(), [], "no refusal spent a pick");

	// Honoured once, recorded truthfully: the fleet record, the run event and /watch carry the verbatim quote.
	assert.equal(await refusal({ jobId: ship, task: "tidy", model: picked, operatorQuote: bound, fetch: false }), "accepted");
	const record = post.fleet.require(ship);
	assert.deepEqual([record.worker?.model, record.routing?.operator_pick?.proof_id, record.routing?.operator_pick?.quote], [picked, bound.proof_id, quote]);
	const events = readRunEvents(b.home, ship);
	assert.equal((events.find((event) => event.type === "routing_resolved")?.payload as { operator_pick?: { quote?: string } })?.operator_pick?.quote, quote);
	assert.match(renderEvents(events).join("\n"), new RegExp(`source=override, .* operator pick \\(terminal entry \\S+\\) "${esc(quote.slice(0, 10))}`));
	assert.equal((await post.tearDown(ship, { force: true })).torn_down, true);

	// One use: a spent proof refuses another job; a picked job refuses a second pick.
	assert.equal(await refusal({ jobId: other, task: "tidy", model: picked, operatorQuote: free, fetch: false }), "accepted");
	assert.equal((await post.tearDown(other, { force: true })).torn_down, true);
	assert.match(await refusal({ jobId: queued, task: "tidy", model: picked, operatorQuote: free }), /operator_pick_consumed: proof \S+ was already used/);
	assert.match(await refusal({ jobId: ship, task: "tidy", model: picked, operatorQuote: queuedRef }), /operator_pick_consumed: \S+ already had its one operator pick/);

	// Queued admission re-verifies: the human's entry edited after enqueue drops the entry, spends nothing, spawns nothing.
	await post.previewDispatch({ jobId: queued, task: "tidy", model: picked, operatorQuote: queuedRef });
	post.dispatchQueue.enqueue(queued, { task: "tidy", model: picked, operator_quote: queuedRef });
	const proof = JSON.parse(readFileSync(join(modelPicksDir(b.home), `${queuedRef.proof_id}.json`), "utf8")) as { source: { session_file: string } };
	writeFileSync(proof.source.session_file, readFileSync(proof.source.session_file, "utf8").replace(`Please ${quote}.`, `Please ${quote}, edited.`));
	const before = claims();
	await post.dispatchQueue.drain();
	assert.deepEqual([post.dispatchQueue.ids(), post.fleet.get(queued), claims()], [[], undefined, before]);
	assert.match(post.durableWakeups.pending().map((entry) => entry.content).join("\n"), new RegExp(`QUEUED DISPATCH DROPPED: operator_pick_edited: .* — ${queued}`));
});
