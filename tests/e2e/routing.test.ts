/**
 * Behavior 14 (routing), P16c: cp_dispatch previews and launches, /doctor and the session-start nudge in real parents;
 * in-process CommandPosts (pi's registry and the sub2api gateway stubbed at their edges) cover capacity and launches.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { type DoctorReport, EMPTY_USAGE, LAYOUT, THINKING_LEVELS, type ThinkingLevel } from "../../src/contracts.ts";
import type { DispatchPreview } from "../../src/dispatch.ts";
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import { COMMAND_POST_EXTENSION, readFleet, readRunEvents, REPO_ROOT, type RpcRecord, startPiChild, waitFor } from "../harness/index.ts";

type Bench = Awaited<ReturnType<typeof dispatchS29>>;
type Finding = DoctorReport["findings"][number];
/** A preview, or the refusal text when the call itself was refused. */
type Preview = DispatchPreview & { tool_error?: string };
/** A model's effort metadata as pi's registry reports it: reasons with every level, none, or exactly these levels. */
type Meta = "plain" | "inert" | readonly ThinkingLevel[];
type Request = Parameters<CommandPost["previewDispatch"]>[0];

const SHIPPED = readFileSync(join(REPO_ROOT, "defaults/routing.default.json"), "utf8");
const OPUS = "anthropic/claude-opus-5-5", SONNET = "anthropic/claude-sonnet-5-5", SOL = "openai/gpt-6.1-sol";
const NO_KEYS = { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", CP_GATEWAY_ADMIN_KEY: "" };
let parents = 0;

const routing = (home: string, doc: unknown) => {
	const file = join(home, LAYOUT.routingFile);
	if (doc === null) return rmSync(file, { force: true });
	mkdirSync(join(home, LAYOUT.data), { recursive: true });
	writeFileSync(file, typeof doc === "string" ? doc : JSON.stringify({ schema_version: 1, allow: ["mock/*"], ...(doc as object) }));
};
const metadata = (meta: Meta) => ({
	reasoning: meta !== "inert",
	...(Array.isArray(meta) ? { thinkingLevelMap: Object.fromEntries(THINKING_LEVELS.map((level) => [level, meta.includes(level) ? level : null])) } : {}),
});

/** The scratch agent's models.json: every mock script plus `models` as `mock/<id>` entries, mirrored as `mock2`. */
function catalog(b: Bench, models: Record<string, Meta>): void {
	const config = b.provider.modelsJson() as { providers: Record<string, { models: Array<Record<string, unknown>> }> };
	const shape = { input: ["text"], contextWindow: 200_000, maxTokens: 8_192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const entries = config.providers.mock!.models;
	for (const [id, meta] of Object.entries(models)) {
		const known = entries.find((entry) => entry.id === id);
		if (known) Object.assign(known, metadata(meta));
		else entries.push({ id, name: id, ...metadata(meta), ...shape });
	}
	config.providers.mock2 = { ...config.providers.mock! };
	writeFileSync(join(b.agent.path, "models.json"), JSON.stringify(config));
}

interface Phase { before?: () => void; calls: Array<Record<string, unknown>> }
interface Turn { previews: Preview[][]; doctor?: DoctorReport; notes: string[] }
/** One real parent: its session-start notices, `/doctor --json` if asked, then one dry-run step per phase. */
async function parent(b: Bench, options: { phases?: Phase[]; models?: Record<string, Meta>; env?: NodeJS.ProcessEnv; doctor?: boolean }): Promise<Turn> {
	const phases = options.phases ?? [];
	const steps = phases.map((phase, p) => ({ kind: "tool_calls" as const, calls: phase.calls.map((args, i) => ({ id: `p${p}c${i}`, name: "cp_dispatch",
		args: i === 0 && phase.before ? () => (phase.before!(), { dry_run: true, ...args }) : { dry_run: true, ...args } })) }));
	const model = b.provider.addScript(`p16c-${(parents += 1)}`, [...steps, { kind: "text", text: "observed" }]);
	catalog(b, options.models ?? {});
	const child = startPiChild({ cwd: b.home, model, extensions: [COMMAND_POST_EXTENSION], env: { ...b.agent.env, CP_HOME: b.home, ...NO_KEYS, ...options.env } });
	try {
		const notify = (r: RpcRecord) => r.type === "extension_ui_request" && r.method === "notify";
		let doctor: DoctorReport | undefined;
		if (options.doctor) {
			child.send({ id: "doctor", type: "prompt", message: "/doctor --json" });
			doctor = JSON.parse(String((await child.waitFor((r) => notify(r) && String(r.message).trimStart().startsWith("{"), 120_000)).message));
		}
		if (phases.length) {
			await child.prompt("Preview the routes.");
			await child.waitForSettled(120_000);
		}
		const ends = child.eventsOfType("tool_execution_end") as unknown as Array<{ toolCallId: string; isError?: boolean; result: { details?: DispatchPreview; content?: Array<{ text?: string }> } }>;
		const previews = phases.map((phase, p) => phase.calls.map((_, i) => {
			const end = ends.find((each) => each.toolCallId === `p${p}c${i}`);
			assert.ok(end, `no result for phase ${p} call ${i}`);
			return end.isError ? ({ tool_error: (end.result.content ?? []).map((part) => part.text ?? "").join("\n") } as Preview) : (end.result.details as Preview);
		}));
		return { previews, ...(doctor ? { doctor } : {}), notes: child.records().filter(notify).map((r) => String(r.message)) };
	} finally {
		await child.close();
	}
}

/** pi's model registry at its edge, as the extension hands it over: an `absent` ref is unknown, `down` lacks auth. */
function registry(models: Map<string, Meta | "down" | "absent">, fallback: Meta | "absent" = "plain") {
	return {
		find: (provider: string, id: string) => {
			const meta = models.get(`${provider}/${id}`) ?? fallback;
			return meta === "absent" ? undefined : { provider, id, ...metadata(meta === "down" ? "plain" : meta) };
		},
		hasConfiguredAuth: (model: { provider?: string; id?: string }) => models.get(`${model.provider}/${model.id}`) !== "down",
	};
}
/** An in-process CommandPost on the bench's home; with `models` it holds a registry, without it nothing is probed. */
const post = (b: Bench, options: { models?: Map<string, Meta | "down" | "absent">; fallback?: Meta | "absent"; env?: NodeJS.ProcessEnv } = {}) =>
	b.ownPost(new CommandPost({ home: b.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...b.agent.env, ...options.env },
		...(options.models ? { modelRegistry: () => registry(options.models!, options.fallback) } : {}) }));
const preview = async (p: CommandPost, request: Request): Promise<Preview> => {
	try {
		return (await p.previewDispatch(request)) as Preview;
	} catch (error) {
		return { tool_error: (error as Error).message } as Preview;
	}
};
const job = async (b: Bench, kind: "ship" | "research", delivery: "pr" | "answer" = "pr", title = "tidy the widget list") =>
	(await b.ledger.create({ title, project: "demo", delivery, kind })).id;
const findings = (report: DoctorReport | undefined, check: string): Finding[] => (report?.findings ?? []).filter((f) => f.check === check);
const said = (p: Preview) => p.line ?? p.error ?? p.tool_error ?? "";

// P16-route-default: the shipped template as an operator meets it, one authenticated provider at a time.
test("P16-route-default: the scaffolded template routes every role and size as documented under Anthropic or OpenAI alone, keeps an operator's copy, and doctor agrees", { timeout: 600_000 }, async (t) => {
	const b = await dispatchS29(t);
	routing(b.home, null);
	const ship = await job(b, "ship"), plan = await job(b, "research");
	const qa = await job(b, "research", "answer", "where is the retry ladder configured?");
	const combos = (["S", "M", "L"] as const).flatMap((scope) => (["low", "high"] as const).map((risk) => ({ scope, risk })));
	type Call = { job_id: string; task: string; scope: "S" | "M" | "L"; risk: "low" | "high"; profile?: string; model?: string; thinking?: string };
	const grid: Call[] = [
		...combos.flatMap((axes) => [{ job_id: ship, task: "tidy up", ...axes }, { job_id: plan, task: "plan it", ...axes },
			{ job_id: plan, task: "review it", profile: "gate-reviewer", ...axes }, { job_id: qa, task: "where?", ...axes }]),
		{ job_id: plan, task: "plan it", scope: "S", risk: "low", model: "anthropic/claude-opus-5", thinking: "xhigh" },
	];
	// The documented table: [profile, scope, risk] -> [source, rule, model, thinking] on the shipped template.
	const want = (profile: string, scope: string, risk: string): [string, string, string, string] => {
		if (profile === "gate-reviewer") return ["rubric", "reviews", OPUS, "high"];
		if (profile === "implementer") return risk === "high" ? ["rubric", "risky-ship", OPUS, "high"] : scope === "S" ? ["rubric", "small-ship", SONNET, "high"] : ["rubric", "big-ship", OPUS, "medium"];
		if (risk === "high") return ["rubric", "risky-any", OPUS, "xhigh"];
		return scope === "L" ? ["rubric", "research-big", OPUS, "high"] : ["profile", `profile ${profile}`, OPUS, profile === "qa" ? "low" : "medium"];
	};
	const anthropic = await parent(b, { phases: [{ calls: grid }], doctor: true, env: { ANTHROPIC_API_KEY: "sk-ant-test" } });
	assert.equal(readFileSync(join(b.home, LAYOUT.routingFile), "utf8"), SHIPPED, "session start copies the shipped template");
	const routes = anthropic.previews[0]!;
	for (const [i, got] of routes.slice(0, -1).entries()) {
		const [source, rule, model, thinking] = want(got.profile, got.routing.scope!, got.routing.risk!);
		assert.equal(said(got), `source=${source} model=${model} rule=${rule} thinking=${thinking} quota=off:no admin key`, `call ${i} (${got.profile})`);
	}
	assert.deepEqual(routes.slice(0, 4).map((p) => p.profile), ["implementer", "planner", "gate-reviewer", "qa"]);
	assert.equal(said(routes.at(-1)!), "source=override model=anthropic/claude-opus-5 rule=explicit override (model+effort) thinking=xhigh effort=override");
	assert.deepEqual(findings(anthropic.doctor, "config.routing").map((f) => [f.severity, f.what, f.detail]), [["ok", "routing config: 6 rubric row(s)", "allow: */*"]]);
	assert.deepEqual(findings(anthropic.doctor, "config.routing.effort").map((f) => f.severity), ["ok"]);
	assert.deepEqual(findings(anthropic.doctor, "config.routing.shadowed"), [], "the shipped template has no dead row");
	assert.ok(!anthropic.notes.some((note) => note.startsWith("routing:")), "a clean shipped home gets no routing nudge");

	// OpenAI alone: every route steps over its Anthropic candidates to the shipped last resort, at the same effort.
	const openai = await parent(b, { phases: [{ calls: grid.slice(0, -1) }], doctor: true, env: { OPENAI_API_KEY: "sk-test" } });
	for (const [i, got] of openai.previews[0]!.entries()) {
		const [source, rule, model, thinking] = want(got.profile, got.routing.scope!, got.routing.risk!);
		const skipped = model === SONNET ? `${SONNET}(availability),${OPUS}(availability)` : `${OPUS}(availability)`;
		assert.equal(said(got), `source=${source} model=${SOL} rule=${rule} thinking=${thinking} quota=off:no admin key attempted=${skipped}`, `call ${i}`);
	}
	assert.deepEqual(findings(openai.doctor, "config.routing.effort").map((f) => f.severity), ["ok"]);
	assert.ok(findings(openai.doctor, "models.implementer").every((f) => f.severity === "ok" && f.what.includes(`${SOL} (`)));
	assert.equal(readFileSync(join(b.home, LAYOUT.routingFile), "utf8"), SHIPPED, "a second session leaves the copy alone");

	// Nothing authenticated: the dispatch is refused before any lease, naming every rung and its gate.
	const none = await parent(b, { phases: [{ calls: grid.slice(0, 2) }], doctor: true });
	assert.match(said(none.previews[0]![0]!), new RegExp(`no usable model for implementer job ${ship}: every candidate for rubric row small-ship was refused — ${SONNET} \\(availability\\), ${OPUS} \\(availability\\), ${SOL} \\(availability\\)`));
	assert.match(said(none.previews[0]![1]!), new RegExp(`every candidate for profile planner was refused — ${OPUS} \\(availability\\), ${SOL} \\(availability\\)`));
	assert.equal(none.previews[0]![0]!.decision, undefined);
	assert.ok(findings(none.doctor, "models.implementer").every((f) => f.severity === "error" && f.what === "implementer: every candidate refused"));

	// cp-routing-t4: a home that kept the old planner catch-all is not migrated; reading it changes nothing.
	const kept = `${JSON.stringify({ schema_version: 1, allow: ["*/*"], rubric: [
		{ id: "risky-any", role: "researcher", risk: "high", model: "anthropic/claude-opus-5", thinking: "xhigh" },
		{ id: "research", role: "researcher", model: "anthropic/claude-opus-5", thinking: "medium" },
		{ id: "small-ship", role: "implementer", scope: ["S"], model: "anthropic/claude-haiku-4-5", thinking: "low" }] }, null, 2)}\n`;
	routing(b.home, kept);
	const legacy = await parent(b, { phases: [{ calls: [{ job_id: plan, task: "Plan the widget refresh.", scope: "M", risk: "low" }] }], env: { ANTHROPIC_API_KEY: "sk-ant-test" } });
	assert.equal(said(legacy.previews[0]![0]!), "source=rubric model=anthropic/claude-opus-5 rule=research thinking=medium quota=off:no admin key");
	assert.equal(readFileSync(join(b.home, LAYOUT.routingFile), "utf8"), kept, "neither the scaffold nor a read rewrote the operator's file");

	// Whatever pi says a shipped model can do, the configured level is checked, never substituted (cp-reviewer-routing).
	routing(b.home, SHIPPED);
	for (const [what, meta] of [["full support", "plain"], ["reasoning: false", "inert"], ["no level serviceable", []]] as const) {
		const p = post(b, { models: new Map(), fallback: meta });
		for (const [i, call] of grid.slice(0, -1).entries()) {
			const got = await preview(p, { jobId: call.job_id, task: call.task, scope: call.scope, risk: call.risk, ...(call.profile ? { profile: call.profile } : {}) });
			assert.equal(got.decision?.thinking, routes[i]!.decision?.thinking, `${what}: call ${i}`);
		}
	}
	const blind = post(b);
	for (const [i, call] of grid.slice(0, -1).entries()) {
		const got = await preview(blind, { jobId: call.job_id, task: call.task, scope: call.scope, risk: call.risk, ...(call.profile ? { profile: call.profile } : {}) });
		assert.equal(said(got), said(routes[i]!), `no metadata: call ${i}`);
	}
});

// P16-route-rubric: the policy file itself — precedence, gates, globs, the ladder and the load-time refusals.
test("P16-route-rubric: rubric order, override and project rows, the allowlist, role deny and the fallback ladder decide each preview, and a bad file refuses", { timeout: 300_000 }, async (t) => {
	const b = await dispatchS29(t);
	const ship = await job(b, "ship"), plan = await job(b, "research");
	const blind = post(b);
	const route = (p: CommandPost, jobId: string, extra: Partial<Request> = {}) => preview(p, { jobId, task: "tidy up", ...extra });
	const ported = [
		{ id: "gate-reviewer", role: "gate-reviewer", model: "mock/composer-fast" },
		{ id: "research-ambiguous", role: "planner", scope: ["L"], model: "mock/grok-xhigh" },
		{ id: "research-bounded", role: "planner", scope: ["S", "M"], model: "mock/grok-high-fast" },
		{ id: "risky-ship", role: "implementer", risk: "high", model: "mock/grok-high" },
		{ id: "small-ship", role: "implementer", scope: ["S"], risk: "low", model: "mock/composer-fast" },
		{ id: "medium-large-ship", role: "implementer", scope: ["M", "L"], risk: "low", model: "mock/grok-high" },
	];
	routing(b.home, { rubric: ported });
	const table: Array<[string, Partial<Request>, string, string]> = [
		[plan, { profile: "gate-reviewer" }, "mock/composer-fast", "gate-reviewer"],
		[plan, { scope: "L" }, "mock/grok-xhigh", "research-ambiguous"], [plan, { scope: "S" }, "mock/grok-high-fast", "research-bounded"],
		[plan, { scope: "M" }, "mock/grok-high-fast", "research-bounded"], [ship, { scope: "S", risk: "high" }, "mock/grok-high", "risky-ship"],
		[ship, { scope: "L", risk: "high" }, "mock/grok-high", "risky-ship"], [ship, { scope: "S", risk: "low" }, "mock/composer-fast", "small-ship"],
		[ship, { scope: "M", risk: "low" }, "mock/grok-high", "medium-large-ship"], [ship, { scope: "L", risk: "low" }, "mock/grok-high", "medium-large-ship"],
		[ship, {}, "mock/composer-fast", "small-ship"],
	];
	for (const [jobId, axes, model, rule] of table) {
		const got = await route(blind, jobId, axes);
		assert.deepEqual([got.decision?.source, got.decision?.model, got.decision?.rule], ["rubric", model, rule], JSON.stringify(axes));
	}
	assert.deepEqual((await route(blind, ship)).routing.provenance, { scope: "defaulted", risk: "defaulted" }, "no axes and no signal is S/low, defaulted");

	// Override > project row > size rows > profile; a project row placed after the broad rows never fires.
	routing(b.home, { rubric: [{ id: "demo-research", role: "planner", project: "demo", model: "mock/project-row" }, ...ported] });
	assert.deepEqual([(await route(blind, plan, { model: "mock/chosen" })).decision?.source, (await route(blind, plan, { model: "mock/chosen" })).decision?.model], ["override", "mock/chosen"]);
	assert.deepEqual([(await route(blind, plan, { scope: "M" })).decision?.rule, (await route(blind, plan, { scope: "M" })).decision?.model], ["demo-research", "mock/project-row"]);
	routing(b.home, { rubric: [{ id: "web-research", role: "planner", project: "web", model: "mock/project-row" }, ...ported] });
	assert.equal((await route(blind, plan, { scope: "M" })).decision?.rule, "research-bounded", "another repository's row does not fire here");
	routing(b.home, { rubric: [...ported, { id: "demo-research", role: "planner", project: "demo", model: "mock/project-row" }] });
	assert.equal((await route(blind, plan, { scope: "M" })).decision?.rule, "research-bounded", "first match wins");
	routing(b.home, { allow: ["*/*"], rubric: [] });
	assert.deepEqual([(await route(blind, plan)).decision?.source, (await route(blind, plan)).decision?.model], ["profile", OPUS]);

	// The allowlist gates every source; an empty one allows nothing; the globs are the shapes operators write.
	routing(b.home, { allow: ["mock/allowed*"], rubric: [] });
	assert.match(said(await route(blind, plan, { model: "mock/forbidden" })), /allowlist refuses/);
	assert.match(said(await route(blind, plan)), new RegExp(`${OPUS} \\(allowlist\\), ${SOL} \\(allowlist\\)`), "the profile default is not exempt");
	assert.equal((await route(blind, plan, { model: "mock/allowed-1" })).decision?.model, "mock/allowed-1");
	routing(b.home, { allow: ["mock/allowed*"], rubric: [{ id: "r", role: "planner", model: "mock/forbidden" }] });
	assert.match(said(await route(blind, plan)), /rubric r names/);
	routing(b.home, { allow: [], rubric: [] });
	assert.match(said(await route(blind, plan, { model: "mock/anything" })), /nothing is allowed/);
	for (const [allow, model, admitted] of [["anthropic/*", "anthropic/claude-sonnet-5", true], ["anthropic/*", "openai/gpt-5", false],
		["**", "anything/at/all", true], ["mock/exact-model", "mock/exact-model", true], ["mock/exact-model", "mock/exact-model-2", false]] as const) {
		routing(b.home, { allow: [allow], rubric: [] });
		const got = await route(blind, plan, { model });
		assert.equal(got.decision?.model === model, admitted, `${allow} vs ${model}: ${said(got)}`);
	}
	routing(b.home, null);
	assert.deepEqual([(await route(blind, plan, { model: "anthropic/claude-sonnet-5" })).decision?.model, (await route(blind, plan)).decision?.rule],
		["anthropic/claude-sonnet-5", "profile planner"], "no file: the permissive default");

	// cp-7re9: a role's deny list is a gate on every candidate, overrides included; other roles are untouched.
	const denied = /^settings: model mock\/denied-1 is not allowed for role planner \(.*data\/routing\.json deny_by_role\.planner matches mock\/denied\*\)/;
	const deny = (rubric: unknown[], role = "planner") => routing(b.home, { deny_by_role: { [role]: ["mock/denied*"] }, rubric });
	deny([]);
	assert.match(said(await route(blind, plan, { model: "mock/denied-1" })), denied);
	deny([{ id: "r", role: "planner", model: "mock/denied-1" }]);
	assert.match(said(await route(blind, plan)), denied);
	deny([{ id: "w", role: "planner", model: "mock/denied-1", fallbacks: ["mock/denied-2", "mock/ok"] }]);
	const walked = await route(blind, plan);
	assert.deepEqual([walked.decision?.model, walked.decision?.attempted?.map((step) => step.refusal)], ["mock/ok", ["allowlist", "allowlist"]]);
	deny([{ id: "w", role: "planner", model: "mock/denied-1", fallbacks: ["mock/denied-2"] }]);
	assert.match(said(await route(blind, plan)), /every candidate for rubric row w was refused — .*mock\/denied-2 \(allowlist\)/);
	deny([], "implementer");
	assert.equal((await route(blind, plan, { model: "mock/denied-1" })).decision?.model, "mock/denied-1");
	routing(b.home, { deny_by_role: { qa: ["mock/x"] }, rubric: [] });
	const unknownRole = said(await route(blind, plan));
	assert.ok(unknownRole.includes(join(b.home, LAYOUT.routingFile)) && /violates the routing contract/.test(unknownRole) && /deny_by_role/.test(unknownRole), unknownRole);

	// A file that cannot load refuses every dispatch, naming why; duplicate ids name both rows (routing T5).
	for (const [doc, refusal] of [["{ nope", /not valid JSON/], [{ rubric: [{ id: "r" }] }, /violates the routing contract/],
		[{ rubric: [], pins: [{ match: {}, model: "mock/x" }] }, /still has `pins`.*Express each pin as a rubric row|Express each pin as a rubric row/s]] as const) {
		routing(b.home, doc);
		assert.match(said(await route(blind, plan)), refusal);
	}
	routing(b.home, { rubric: [{ id: "ship", role: "implementer", scope: ["S"], model: "mock/small" }, { id: "other", role: "implementer", scope: ["M"], model: "mock/medium" },
		{ id: "ship", role: "implementer", scope: ["L"], model: "mock/large" }] });
	const duplicate = said(await route(blind, ship));
	assert.match(duplicate, /duplicate rubric id.*"ship" at rubric\[0\] -> mock\/small and rubric\[2\] -> mock\/large.*first match wins/s);
	assert.doesNotMatch(duplicate, /"other"/);
	routing(b.home, { rubric: [{ id: "ship", role: "implementer", model: "mock/small" }] });
	assert.equal((await route(blind, ship)).decision?.rule, "ship");

	// cp-routing-provenance: each axis is assessed on its own, and a supplied value wins only its own axis.
	routing(b.home, { rubric: [{ id: "risky-research", role: "planner", risk: "high", model: "mock/grok-xhigh" }, { id: "research", role: "planner", model: "mock/grok-high-fast" }] });
	for (const [task, axes, scope, risk, provenance, reasons, rule] of [
		["Rotate production credentials across services", { scope: "M" }, "M", "high", { scope: "explicit", risk: "inferred" }, ["risk high: the task touches credentials or access"], "risky-research"],
		["Refactor across all modules", { risk: "low" }, "M", "low", { scope: "inferred", risk: "explicit" }, ["scope M: the change is structural"], "research"],
		["Rotate production credentials across services", { scope: "S", risk: "low" }, "S", "low", { scope: "explicit", risk: "explicit" }, [], "research"],
		["Bump x to 2 in src/app.ts.", {}, "S", "low", { scope: "defaulted", risk: "defaulted" }, [], "research"],
	] as const) {
		const got = await preview(blind, { jobId: plan, task, ...axes });
		assert.deepEqual([got.routing.scope, got.routing.risk, got.routing.provenance, got.routing.reasons ?? [], got.decision?.rule], [scope, risk, provenance, reasons, rule], task);
	}
	const both = await preview(blind, { jobId: plan, task: "Migrate the billing tables across every service" });
	assert.deepEqual([both.routing.scope, both.routing.risk, both.routing.provenance, both.routing.reasons?.length, both.decision?.rule],
		["M", "high", { scope: "inferred", risk: "inferred" }, 2, "risky-research"]);

	// pi-command-post-0a9: the ladder takes the first candidate every gate passes, in file order, and names the skips.
	const models = new Map<string, Meta | "down" | "absent">();
	const probed = post(b, { models });
	const ladder = { id: "big-ship", role: "implementer", model: "mock/preferred", fallbacks: ["mock/second", "mock/third"], thinking: "high" };
	routing(b.home, { rubric: [ladder] });
	assert.equal(said(await route(probed, ship)), "source=rubric model=mock/preferred rule=big-ship thinking=high quota=off:no admin key");
	models.set("mock/preferred", "down");
	const second = (await route(probed, ship)).decision;
	assert.deepEqual([second?.model, second?.rule, second?.thinking, second?.attempted], ["mock/second", "big-ship", "high", [{ model: "mock/preferred", refusal: "availability" }]]);
	models.set("mock/second", "down");
	assert.equal(said(await route(probed, ship)), "source=rubric model=mock/third rule=big-ship thinking=high quota=off:no admin key attempted=mock/preferred(availability),mock/second(availability)");
	routing(b.home, { allow: ["mock/third"], rubric: [ladder] });
	assert.deepEqual((await route(blind, ship)).decision?.attempted, [{ model: "mock/preferred", refusal: "allowlist" }, { model: "mock/second", refusal: "allowlist" }]);
	routing(b.home, { allow: ["mock/third"], rubric: [{ ...ladder, fallbacks: undefined }] });
	assert.match(said(await route(blind, ship)), /rubric big-ship names mock\/preferred, which the allowlist refuses/);
	models.set("mock/second", ["low"]).set("mock/third", ["low"]);
	routing(b.home, { rubric: [ladder] });
	const exhausted = said(await route(probed, ship));
	assert.match(exhausted, /every candidate for rubric row big-ship was refused — mock\/preferred \(availability\), mock\/second \(effort\), mock\/third \(effort\)/);
	assert.ok(!exhausted.includes(OPUS), "a row's ladder never falls through to the profile");
	models.set("mock/third", "plain");
	assert.match(said(await route(probed, ship, { model: "mock/preferred" })), /mock\/preferred \(override, explicit override\) is not usable/);
	assert.doesNotMatch(said(await route(probed, ship, { model: "mock/preferred" })), /attempted/, "an override never falls back");
	const named = await route(probed, ship, { model: "mock/third" });
	assert.deepEqual([named.decision?.source, named.decision?.attempted], ["override", undefined]);
	routing(b.home, { rubric: [{ id: "small-ship", role: "implementer", model: "mock/gone" }] });
	models.set("mock/gone", "absent");
	assert.match(said(await route(probed, ship)), /no available model for implementer job .*resolvable auth.*This route has no other candidate/s);
	const long = Array.from({ length: 4 }, (_, i) => `mock/${"candidate".repeat(3)}-${i}`);
	for (const ref of long) models.set(ref, "down");
	routing(b.home, { rubric: [{ id: "long", role: "implementer", model: long[0], fallbacks: [...long.slice(1), "mock/third"] }] });
	const suffix = said(await route(probed, ship)).split("attempted=")[1] ?? "";
	assert.ok(suffix.length <= 160 && /\(\+\d+ more\)/.test(suffix), suffix);
	assert.ok(!/[=][^ ]*key/i.test(suffix), "model refs and enum words only");

	// Each refusal names the row that chose the model, and a profile-chosen one names no row.
	routing(b.home, { allow: ["mock/*"], rubric: [{ id: "web-ship", role: "implementer", model: "forbidden/model" }] });
	assert.match(said(await route(probed, ship)), /rubric web-ship names forbidden\/model/);
	models.set("mock/unreachable", "down").set("mock/shallow", ["low", "medium"]);
	routing(b.home, { rubric: [{ id: "web-ship", role: "implementer", model: "mock/unreachable" }] });
	assert.match(said(await route(probed, ship)), /mock\/unreachable \(rubric, web-ship\) is not usable/);
	routing(b.home, { rubric: [{ id: "big-ship", role: "implementer", model: "mock/shallow", thinking: "xhigh" }] });
	assert.match(said(await route(probed, ship)), /rubric row big-ship asks for thinking=xhigh/);
	routing(b.home, { allow: ["**"], rubric: [] });
	models.set(OPUS, "down").set(SOL, "down");
	assert.match(said(await route(probed, ship)), /every candidate for profile implementer was refused/);
	assert.doesNotMatch(said(await route(probed, ship)), /rubric/);

	// Doctor proves a dead row only when an earlier row covers it entirely; with no registry it claims no effort drift.
	const shadowed = async (rubric: unknown[]) => { routing(b.home, { rubric }); return findings(await blind.doctor(), "config.routing.shadowed").map((f) => f.detail); };
	assert.deepEqual(await shadowed([{ id: "any-ship", role: "implementer", model: "mock/broad" }, { id: "dead", role: "implementer", scope: ["L"], risk: "high", model: "mock/never" },
		{ id: "planning", role: "planner", model: "mock/plan" }]), ["dead (rubric[1]) <- any-ship (rubric[0])"]);
	assert.deepEqual(await shadowed([{ id: "small", role: "implementer", scope: ["S"], model: "mock/small" }, { id: "small-and-medium", role: "implementer", scope: ["S", "M"], model: "mock/medium" },
		{ id: "risky", role: "implementer", risk: "high", model: "mock/risky" }, { id: "web", role: "implementer", project: "web", model: "mock/web" },
		{ id: "api", role: "implementer", project: "api", model: "mock/api" }]), [], "overlap and per-project narrowing are not shadowing");
	assert.deepEqual(await shadowed([{ id: "web", role: "implementer", project: "web", model: "mock/web" }, { id: "any", role: "implementer", model: "mock/broad" }]), []);
	routing(b.home, { rubric: [{ id: "risky-ship", role: "implementer", risk: "high", model: "mock/shallow", thinking: "xhigh" }] });
	assert.deepEqual(findings(await blind.doctor(), "config.routing.effort"), [], "no registry, no effort claim");
});

// P16-route-effort: the effort a worker is spawned at, judged on pi's own models.json metadata in a real parent.
test("P16-route-effort: rows, profiles and overrides set the effort, pi's metadata decides what is serviceable, and nothing is substituted", { timeout: 300_000 }, async (t) => {
	const b = await dispatchS29(t);
	const ship = await job(b, "ship"), plan = await job(b, "research");
	const all: Meta = "plain";
	const models: Record<string, Meta> = { big: all, small: all, fable: all, capped: ["off", "minimal", "low", "high", "xhigh", "max"], "no-reasoning": "inert", nothing: [],
		"no-xhigh": ["off", "minimal", "low", "medium", "high"] };
	const rows = (...rubric: unknown[]) => () => routing(b.home, { allow: ["**"], rubric });
	const { previews: [rowed, direct, effortOnly, profiled, rowCapped, rowInert] } = await parent(b, { models, env: { ANTHROPIC_API_KEY: "sk-ant-test" }, phases: [
		{ before: rows({ id: "risky", role: "implementer", risk: "high", model: "mock/big", thinking: "xhigh" }, { id: "small", role: "implementer", scope: ["S"], model: "mock/small" }),
			calls: [{ job_id: ship, task: "t", risk: "high" }, { job_id: ship, task: "t", scope: "S", risk: "low" }] },
		{ before: rows(), calls: [{ job_id: plan, task: "t" }, { job_id: plan, task: "t", model: "mock/fable", thinking: "xhigh" }, { job_id: plan, task: "t", model: "mock/fable" },
			{ job_id: plan, task: "t", model: "mock/capped" }, { job_id: plan, task: "t", profile: "gate-reviewer", model: "mock/no-reasoning" },
			{ job_id: plan, task: "t", model: "mock/no-reasoning", thinking: "high" }, { job_id: ship, task: "t", model: "mock/nothing" }, { job_id: plan, task: "t", model: "mock/nothing" },
			{ job_id: plan, task: "t", profile: "gate-reviewer", model: "mock/nothing" }, { job_id: plan, task: "t", model: "mock/nothing", thinking: "high" },
			{ job_id: plan, task: "t", model: "mock/no-xhigh", thinking: "xhigh" }, { job_id: plan, task: "t", model: "mock/fable", thinking: "max" }] },
		{ before: rows({ id: "risky-any", role: "planner", risk: "high", model: "mock/fable", thinking: "high" }), calls: [{ job_id: plan, task: "t", risk: "high", thinking: "xhigh" }] },
		{ before: rows({ id: "reviews", role: "planner", model: "mock/capped", thinking: "medium" }), calls: [{ job_id: plan, task: "t" }] },
		{ before: rows({ id: "reviews", role: "planner", model: "mock/capped", thinking: "low" }), calls: [{ job_id: plan, task: "t" }] },
		{ before: rows({ id: "nothing", role: "planner", model: "mock/nothing", thinking: "xhigh" }), calls: [{ job_id: plan, task: "t" }] },
	] });
	// cp-eff: a row's level wins; a row naming none, and the bare profile, keep the profile's.
	assert.deepEqual([rowed![0]!.decision?.model, rowed![0]!.decision?.thinking], ["mock/big", "xhigh"]);
	assert.match(said(rowed![0]!), /thinking=xhigh/);
	assert.deepEqual([rowed![1]!.decision?.model, rowed![1]!.decision?.thinking], ["mock/small", "medium"]);
	const [bare, both, modelOnly, capped, inertKept, inertAsked, ...rest] = direct!;
	assert.deepEqual([bare!.decision?.source, bare!.decision?.thinking], ["profile", "medium"]);
	// cp-ot3b: an override carries model and effort; a model-only override keeps the profile's level and claims nothing.
	assert.deepEqual([both!.decision?.source, both!.decision?.thinking, both!.decision?.requested_thinking], ["override", "xhigh", "xhigh"]);
	assert.match(said(both!), /thinking=xhigh effort=override/);
	assert.deepEqual([modelOnly!.decision?.rule, modelOnly!.decision?.thinking, "requested_thinking" in (modelOnly!.decision ?? {})], ["explicit override", "medium", false]);
	assert.doesNotMatch(said(modelOnly!), /effort=/);
	assert.deepEqual([effortOnly![0]!.decision?.source, effortOnly![0]!.decision?.rule, effortOnly![0]!.decision?.thinking], ["rubric", "risky-any", "xhigh"], "an effort-only ask outranks the row's level");
	// cp-reviewer-routing: the effective level is checked whichever source named it.
	assert.match(said(capped!), /thinking=medium/);
	assert.match(said(capped!), /profile planner asks for/);
	assert.equal(capped!.decision, undefined);
	assert.match(said(profiled![0]!), /rubric row reviews asks for/);
	assert.equal(rowCapped![0]!.decision?.thinking, "low", "a level the model serves is untouched");
	// A model that does not reason (or answers no level at all) keeps inherited levels inert; a human ask is refused.
	assert.equal(inertKept!.decision?.thinking, "high");
	assert.match(said(inertAsked!), /available: off/);
	const [nothingShip, nothingPlan, nothingReview, nothingAsked, noXhigh, max] = rest;
	assert.deepEqual([nothingShip, nothingPlan, nothingReview].map((p) => p!.decision?.thinking), ["medium", "medium", "high"]);
	assert.equal(rowInert![0]!.decision?.thinking, "xhigh");
	assert.match(said(nothingAsked!), /none — this model does not reason/);
	for (const part of [/thinking=xhigh/, /which mock\/no-xhigh cannot serve/, /available: off, minimal, low, medium, high/, /never substitutes an effort level/]) assert.match(said(noXhigh!), part);
	assert.equal(max!.decision?.thinking, "max");
	// Ignorance is not evidence: with no registry metadata the same asks are honoured as named.
	const blind = post(b);
	routing(b.home, { allow: ["**"], rubric: [] });
	assert.equal((await preview(blind, { jobId: plan, task: "t", model: "mock/unknown-support", thinking: "xhigh" })).decision?.thinking, "xhigh");
	assert.equal((await preview(blind, { jobId: plan, task: "t", model: "mock/capped" })).decision?.thinking, "medium");

	// Routing T5: the session-start nudge and /doctor lint one policy: refusal, dead rows, drift deduplicated by pair.
	const lint = async (doc: unknown, extra: Record<string, Meta> = {}) => {
		routing(b.home, doc);
		const turn = await parent(b, { models: { ...models, shallow: ["low"], other: all, broad: all, ...extra }, doctor: true });
		return { nudge: turn.notes.find((note) => note.startsWith("routing:")) ?? "", doctor: turn.doctor };
	};
	const duplicate = await lint({ rubric: [{ id: "ship", role: "implementer", model: "mock/a" }, { id: "ship", role: "implementer", model: "mock/b" }] });
	assert.match(duplicate.nudge, /duplicate rubric id/);
	assert.match(duplicate.nudge, /dispatch refuses to guess a model/);
	assert.deepEqual(findings(duplicate.doctor, "config.routing").map((f) => [f.severity, f.what]), [["error", `${LAYOUT.routingFile} is invalid`]]);
	const broken = await lint({ rubric: [{ id: "risky-ship", role: "implementer", risk: "high", model: "mock/shallow", thinking: "xhigh" },
		{ id: "big-ship", role: "implementer", scope: ["L"], model: "mock/shallow", thinking: "xhigh" }, { id: "planning", role: "planner", model: "mock/shallow" },
		{ id: "inert", role: "gate-reviewer", model: "mock/no-reasoning" }, { id: "any-ship", role: "implementer", model: "mock/broad", fallbacks: ["mock/spare"] },
		{ id: "dead-ship", role: "implementer", scope: ["L"], model: "mock/other" }] }, { spare: ["low"] });
	assert.match(broken.nudge, /rubric\[5\] "dead-ship" can never fire: rubric\[1\] "big-ship"/);
	assert.match(broken.nudge, /rubric row risky-ship, rubric row big-ship asks for thinking=xhigh on mock\/shallow/);
	assert.match(broken.nudge, /rubric row planning asks for thinking=medium on mock\/shallow/, "a row with no level still spawns the profile's");
	assert.match(broken.nudge, /nothing here changes precedence/);
	assert.doesNotMatch(broken.nudge, /no-reasoning/, "an inherited level on a non-reasoning model is not drift");
	assert.match(broken.nudge, /rubric row any-ship fallback asks for thinking=medium on mock\/spare/, "a fallback is linted before it is needed");
	assert.deepEqual(findings(broken.doctor, "config.routing.effort").map((f) => [f.severity, f.what]), [["error", "3 configured model/effort pair(s) the model cannot serve"]]);
	assert.deepEqual(findings(broken.doctor, "config.routing.shadowed").map((f) => f.severity), ["warn"]);
	const many = await lint({ rubric: [{ id: "any-ship", role: "implementer", model: "mock/shallow" }, ...Array.from({ length: 7 }, (_, i) =>
		({ id: `dead-${i + 1}`, role: "implementer", scope: ["L"], risk: "high", model: `mock/never-${i + 1}`, thinking: "xhigh" }))] },
	Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`never-${i + 1}`, ["low"] as Meta])));
	const lines = many.nudge.split("\n");
	assert.equal(lines.filter((line) => line.includes("can never fire")).length, 5);
	assert.ok(lines.includes("(and 2 more shadowed row(s))"), many.nudge);
	const drifted = Number(/^(\d+) configured/.exec(findings(many.doctor, "config.routing.effort")[0]?.what ?? "")?.[1]);
	const counted = Number(/\(and (\d+) more drifted model\/effort pair\(s\)\)/.exec(many.nudge)?.[1] ?? "0");
	assert.ok(drifted > 5, many.nudge);
	assert.equal(lines.filter((line) => line.includes("asks for thinking=")).length + counted, drifted, "the count describes the list");
});

// P16-route-capacity: sub2api's admin answer (stubbed at fetch) ranks providers inside the gates, and a launch agrees.
test("P16-route-capacity: quota and capacity order a row's candidates, overrides and gates stand, a rejected gateway falls back to the fleet, and the launch is the preview", { timeout: 300_000 }, async (t) => {
	const gateway = { capacity: {} as Record<string, [number, number]>, seven: {} as Record<string, number | undefined>, status: 200, calls: 0 };
	const original = globalThis.fetch;
	t.after(() => { globalThis.fetch = original; });
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.host !== "gateway.test") return original(input as string, init);
		gateway.calls += 1;
		if (gateway.status !== 200) return new Response("test-only-key", { status: gateway.status });
		const accounts = Object.keys(gateway.seven);
		if (url.pathname === "/capacity") return Response.json({ code: 0, data: { enabled: true, timestamp: "2026-09-26T00:00:00Z", platform: Object.fromEntries(
			Object.entries(gateway.capacity).map(([name, [max, used]]) => [name, { max_capacity: max, current_in_use: used, waiting_in_queue: 0 }])) } });
		if (url.pathname.endsWith("/accounts")) return Response.json({ code: 0, data: { items: accounts.map((platform, i) =>
			({ id: i + 1, platform, status: "active", schedulable: true, type: "oauth", temp_unschedulable_until: null, overload_until: null })) } });
		const seven = gateway.seven[accounts[Number(/accounts\/(\d+)\//.exec(url.pathname)?.[1]) - 1]!];
		return Response.json(seven === undefined ? { code: 500 } : { code: 0, data: { five_hour: { utilization: 2 }, seven_day: { utilization: seven } } });
	}) as typeof fetch;
	const b = await dispatchS29(t);
	const ship = await job(b, "ship");
	const KEY = { CP_GATEWAY_ADMIN_KEY: "test-only-key" };
	const capacityFile = (quota?: unknown) => writeFileSync(join(b.home, LAYOUT.data, "capacity.json"), JSON.stringify({ url: "https://gateway.test", path: "/capacity", quota }));
	const ladder = (row: Record<string, unknown>) => routing(b.home, { allow: ["*/*"], rubric: [{ id: "quota", role: "implementer", model: "anthropic/opus", fallbacks: ["openai/sol"], ...row }] });
	const A = "anthropic/opus", B = "openai/sol";

	// Quota: a tight preferred provider yields to a free fallback; the margin decides near-ties; overrides never move.
	ladder({});
	for (const [anthropic, openai, expected, margin, openaiUsed = 0] of [[20, 20, A], [50, 20, B], [28, 20, A], [30, 20, A], [31, 20, B], [86, 20, B], [86, 90, A],
		[undefined, 20, A], [50, undefined, A], [50, 20, A, null], [50, 20, A, -1], [50, 20, A, 40], [28, 20, B, 5], [50, 20, A, undefined, 20], [86, 20, B, undefined, 20]] as const) {
		capacityFile({ balance_margin: margin });
		Object.assign(gateway, { capacity: { anthropic: [5, 0], openai: [20, openaiUsed] }, seven: { anthropic, openai } });
		const p = post(b, { env: KEY }), label = `7d=${anthropic}/${openai}, margin=${margin}, used=${openaiUsed}`;
		const got = await preview(p, { jobId: ship, task: "tidy up" });
		assert.equal(got.decision?.model, expected, label);
		if (expected === B && anthropic !== undefined && anthropic < 85) assert.match(said(got), /quota balance: anthropic 7d=.* vs openai 7d=.* -> openai/, label);
		assert.equal((await preview(p, { jobId: ship, task: "tidy up", model: A })).decision?.model, A, label);
	}
	routing(b.home, { allow: ["*/*"], rubric: [{ id: "quota", role: "implementer", model: A, fallbacks: [B, "third/model"] }, { id: "solo", role: "planner", model: A }] });
	capacityFile({});
	Object.assign(gateway, { capacity: { anthropic: [5, 0], openai: [20, 0], third: [5, 0] }, seven: { anthropic: 50, openai: 20, third: 15 } });
	const balancing = post(b, { env: KEY });
	const lowest = await preview(balancing, { jobId: ship, task: "tidy up" });
	assert.equal(lowest.decision?.model, "third/model", "the lowest free provider of three");
	const unbalanced = await preview(balancing, { jobId: await job(b, "research"), task: "look around" });
	assert.match(said(unbalanced), /quota=/);
	assert.doesNotMatch(said(unbalanced), /quota balance/, "the cached snapshot carries no other decision's balance");
	ladder({});
	const calls = gateway.calls;
	const keyless = await preview(post(b, { env: { CP_GATEWAY_ADMIN_KEY: "" } }), { jobId: ship, task: "tidy up" });
	assert.deepEqual([keyless.decision?.model, gateway.calls], [A, calls], "no key, no gateway call");
	assert.match(said(keyless), /quota=off:no admin key/);

	// Capacity: free slots rank eligible candidates; ties, a free preferred provider and overrides keep file order.
	capacityFile();
	ladder({ thinking: "high" });
	gateway.seven = {};
	const ranked = async (anthropic: [number, number], openai: [number, number], extra: Partial<Request> = {}) => {
		gateway.capacity = { anthropic, openai };
		return preview(post(b, { env: KEY }), { jobId: ship, task: "tidy up", ...extra });
	};
	const scored = await ranked([2, 2], [8, 0]);
	assert.deepEqual([scored.decision?.model, scored.decision?.capacity], [B, { source: "admin", scores: [{ provider: "anthropic", score: 0 }, { provider: "openai", score: 8 }] }]);
	assert.match(said(scored), /capacity=admin:anthropic=0,openai=8/);
	assert.equal((await ranked([2, 2], [8, 0], { model: A })).decision?.model, A);
	assert.equal((await ranked([3, 0], [3, 0])).decision?.model, A, "a tie keeps file order");
	assert.equal((await ranked([1, 0], [20, 0])).decision?.model, A, "any free slot keeps the preferred provider");
	assert.equal((await ranked([1, 4], [1, 2])).decision?.model, B, "nobody free: the least oversubscribed");
	gateway.capacity = { anthropic: [2, 2] };
	assert.deepEqual((await preview(post(b, { env: KEY }), { jobId: ship, task: "tidy up" })).decision?.capacity?.reason, "capacity response unreadable");
	// Capacity never crosses the allowlist, effort or availability gates.
	ladder({ risk: "high", thinking: "high" });
	gateway.capacity = { anthropic: [1, 7], openai: [1, 3] };
	assert.equal((await preview(post(b, { env: KEY }), { jobId: ship, task: "t", risk: "high" })).decision?.model, B);
	routing(b.home, { allow: ["anthropic/*"], rubric: [{ id: "quota", role: "implementer", risk: "high", model: A, fallbacks: [B], thinking: "high" }] });
	assert.equal((await preview(post(b, { env: KEY }), { jobId: ship, task: "t", risk: "high" })).decision?.model, A);
	ladder({ risk: "high", thinking: "high" });
	assert.equal((await preview(post(b, { env: KEY, models: new Map([[B, ["low"]]]) }), { jobId: ship, task: "t", risk: "high" })).decision?.model, A);
	ladder({ fallbacks: [B, "absent/model"], thinking: "high" });
	gateway.capacity = { anthropic: [2, 2], openai: [8, 0] };
	const third = await preview(post(b, { env: KEY, models: new Map([["absent/model", "absent"]]) }), { jobId: ship, task: "t" });
	assert.deepEqual([third.decision?.model, third.decision?.capacity?.source], [B, "admin"], "an ineligible provider is never asked about");

	// cp-routing T7: pre-epic fleet records load (the retired role word as today's), feed the fleet fallback, unwritten.
	const worker = { pid: 4321, session_id: "s1", session_file: "/tmp/s1.json", profile: "researcher", role: "researcher", model: "anthropic/claude-opus-5", started_at: "2026-08-27T12:00:00Z" };
	const base = { project: "demo", kind: "research", delivery: "pr", origin: "terminal", phase: "waiting", worktree: "/tmp/wt", branch: "cp-old", dispatched_at: "2026-08-27T12:00:00Z", usage: EMPTY_USAGE };
	const fleet = `${JSON.stringify({ schema_version: 1, updated_at: "2026-08-27T12:00:00Z", jobs: [{ ...base, job_id: "cp-no-routing", worker },
		{ ...base, job_id: "cp-one-bit", worker, routing: { scope: "L", risk: "high", inferred: true } },
		{ ...base, job_id: "cp-current", worker: { ...worker, role: "planner", profile: "planner" }, routing: { scope: "M", risk: "low", inferred: false, provenance: { scope: "explicit", risk: "defaulted" } } }] }, null, 2)}\n`;
	mkdirSync(join(b.home, LAYOUT.state), { recursive: true });
	writeFileSync(join(b.home, LAYOUT.fleetFile), fleet);
	ladder({ thinking: "high" });
	gateway.status = 401;
	const rejected = post(b, { env: KEY });
	const fallback = await preview(rejected, { jobId: ship, task: "t" });
	assert.deepEqual([fallback.decision?.model, fallback.decision?.capacity],
		[B, { source: "fleet", scores: [{ provider: "anthropic", score: -3 }, { provider: "openai", score: 0 }], reason: "capacity auth rejected" }], said(fallback));
	assert.match(said(fallback), /capacity auth rejected/);
	assert.doesNotMatch(JSON.stringify(fallback), /test-only-key/);
	assert.deepEqual(rejected.statusNow().jobs.map((row) => [row.job_id, "role" in row ? row.role : undefined]).sort(),
		[["cp-current", "planner"], ["cp-no-routing", "planner"], ["cp-one-bit", "planner"]]);
	assert.equal(readFileSync(join(b.home, LAYOUT.fleetFile), "utf8"), fleet, "reading the fleet rewrote it");
	rmSync(join(b.home, LAYOUT.fleetFile));

	// The preview, the dispatch record, its routing_resolved event and the worker's own effort agree on the scored pick.
	Object.assign(gateway, { status: 200, capacity: { mock: [8, 0], mock2: [8, 0] }, seven: { mock: 86, mock2: 11 } });
	const careful = b.provider.addScript("route-careful", [{ kind: "text", text: "on it" }]);
	const quick = b.provider.addScript("route-quick", [{ kind: "text", text: "on it" }]).replace(/^.*\//, "mock2/");
	catalog(b, Object.fromEntries([careful, quick].map((ref) => [ref.split("/")[1]!, "plain" as Meta])));
	routing(b.home, { allow: ["*/*"], rubric: [{ id: "scored", role: "implementer", model: careful, fallbacks: [quick], thinking: "low" }] });
	const launch = post(b, { env: KEY });
	const scoredJob = await job(b, "ship", "pr", "score model");
	const request = { jobId: scoredJob, task: "Score model.", scope: "S", risk: "low" } as const;
	const seen = await preview(launch, request);
	assert.equal(seen.decision?.model, quick, said(seen));
	assert.match(said(seen), /quota=.*7d=86\(tight\)/);
	assert.match(said(seen), /capacity=admin:/);
	const result = await launch.dispatch(request);
	assert.equal(result.model, quick);
	assert.equal(readFleet(b.home).jobs.find((each) => each.job_id === scoredJob)?.worker.model, quick);
	const event = readRunEvents(b.home, scoredJob).find((each) => each.type === "routing_resolved")?.payload as { quota?: unknown; capacity?: unknown; thinking?: string };
	assert.deepEqual([event?.quota, event?.capacity, event?.thinking], [seen.decision?.quota, seen.decision?.capacity, "low"]);
	const ran = await waitFor(() => JSON.stringify(readRunEvents(b.home, scoredJob).filter((each) => each.type !== "routing_resolved")),
		(log) => /"thinkingLevel":"/.test(log), { timeoutMs: 60_000, what: "the worker's own thinking level" });
	assert.equal(/"thinkingLevel":"([a-z]+)"/.exec(ran)?.[1], "low", "a fallback never substitutes the effort");

	// pi-command-post-0a9: with the preferred candidate's auth down the launch takes the fallback and records the skip;
	// an override naming the down model is refused before any fleet record exists.
	const down = b.provider.addScript("route-down", [{ kind: "text", text: "never" }]);
	const up = b.provider.addScript("route-up", [{ kind: "text", text: "on it" }]);
	catalog(b, Object.fromEntries([down, up].map((ref) => [ref.split("/")[1]!, "plain" as Meta])));
	routing(b.home, { allow: ["*/*"], rubric: [{ id: "laddered", role: "implementer", model: down, fallbacks: [up], thinking: "low" }] });
	const oneDown = post(b, { env: KEY, models: new Map([[down, "down"]]) });
	const ladderJob = await job(b, "ship", "pr", "ladder launch");
	assert.equal((await oneDown.dispatch({ jobId: ladderJob, task: "Ladder.", scope: "S", risk: "low" })).model, up);
	const resolved = readRunEvents(b.home, ladderJob).find((each) => each.type === "routing_resolved")?.payload as { attempted?: unknown };
	assert.deepEqual(resolved?.attempted, [{ model: down, refusal: "availability" }]);
	const namedJob = await job(b, "ship", "pr", "override the down model");
	await assert.rejects(() => oneDown.dispatch({ jobId: namedJob, task: "Tidy up.", model: down }), /no available model/);
	assert.equal(readFleet(b.home).jobs.some((each) => each.job_id === namedJob), false, "a refused override took a fleet record");
});
