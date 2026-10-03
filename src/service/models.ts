/**
 * cp-install step 3c (cp-er76): a model question for the parent, then the operator session (defaulting to the parent's pick). The
 * choices are what `pi --no-extensions --list-models` reports usable with the environment cp-daemon
 * will give the parent; the answer is pinned as `parent_model` in data/daemon.json and as
 * `CP_PARENT_MODEL`/`CP_OPERATOR_MODEL` in the cp-operator wrapper. `~/.pi/agent/settings.json` is
 * read for pi's saved default, never edited.
 */
import { join } from "node:path";
import { layoutForHome } from "../contracts.ts";
import { resolveParentModel } from "../cp-bridge.ts";
import type { InstallFlags, InstallPorts, StepStatus } from "./install.ts";
import { unitPath } from "./units.ts";

/** A `provider/id` the unit (`Environment=`) and the wrapper (`'…'`) can carry verbatim. */
export const MODEL_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[^\s"'\\`$%]+$/;
const SHORTLIST_MAX = 9;

export interface ModelChoice { model: string; why: string }
export interface Models { parent?: string; operator?: string }
type Target = keyof Models;
const TARGETS: readonly Target[] = ["parent", "operator"];
const LABEL: Record<Target, string> = { parent: "the parent", operator: "the operator session" };

/** `pi --list-models` rows as `provider/id`; `[]` for "No models available"; undefined when the output is not that table. */
export function parseModelList(stdout: string): string[] | undefined {
	const text = stdout.trim();
	if (text.startsWith("No models available")) return [];
	const [header, ...rows] = text.split("\n");
	if (!/^provider\s+model(\s|$)/.test(header ?? "")) return undefined;
	const refs = rows.map((row) => row.trim().split(/\s+/)).filter((cells) => cells.length >= 2).map(([provider, id]) => `${provider}/${id}`);
	return [...new Set(refs.filter((ref) => MODEL_REF.test(ref)))];
}

/** The routing rubric's models in row order (`model`, then `fallbacks`); `[]` when unreadable. */
export function rubricModels(text: string | undefined): string[] {
	try {
		const rows = (JSON.parse(text ?? "") as { rubric?: Array<{ model?: unknown; fallbacks?: unknown }> }).rubric ?? [];
		return [...new Set(rows.flatMap((row) => [row.model, ...(Array.isArray(row.fallbacks) ? row.fallbacks : [])]).filter((model): model is string => typeof model === "string"))];
	} catch {
		return [];
	}
}

/** pi's saved `defaultProvider/defaultModel` (settings.json), when both are set. */
export function piDefaultModel(settingsText: string | undefined): string | undefined {
	try {
		const { defaultProvider, defaultModel } = JSON.parse(settingsText ?? "") as { defaultProvider?: unknown; defaultModel?: unknown };
		return typeof defaultProvider === "string" && typeof defaultModel === "string" && defaultProvider && defaultModel ? `${defaultProvider}/${defaultModel}` : undefined;
	} catch {
		return undefined;
	}
}

/** The listed models among `preferred`, in order, deduped; none of them → the first listed. At most 9; the first is recommended. */
export function modelShortlist(available: readonly string[], preferred: readonly ModelChoice[]): ModelChoice[] {
	const out: ModelChoice[] = [];
	for (const choice of preferred) if (available.includes(choice.model) && !out.some((have) => have.model === choice.model)) out.push(choice);
	return (out.length > 0 ? out : available.map((model) => ({ model, why: "listed by pi" }))).slice(0, SHORTLIST_MAX);
}

/** One target's question; Enter takes `fallback` (the recommendation, or for the operator the parent's pick), shown in brackets. */
export function modelPrompt(shortlist: readonly ModelChoice[], total: number, target: Target, fallback: string | null = shortlist[0]?.model ?? null): string {
	const width = Math.max(...shortlist.map((choice) => choice.model.length));
	const lines = shortlist.map((choice, n) => `  ${n + 1}) ${choice.model.padEnd(width)}  ${n === 0 ? `recommended: ${choice.why}` : choice.why}`);
	const at = shortlist.findIndex((choice) => choice.model === fallback);
	const enter = fallback === null ? "none" : at >= 0 ? String(at + 1) : fallback;
	return `Model for ${LABEL[target]} — models pi can use as the service sees them (${total} available; pi --list-models lists them):\n${lines.join("\n")}\nChoose 1-${shortlist.length}, type a provider/model, or none [${enter}]: `;
}

/** `""` → the recommendation, a number → that entry, a listed ref → it, `none` → null; anything else is an error. */
export function pickModelReply(reply: string, shortlist: readonly ModelChoice[], available: readonly string[]): { model?: string | null; error?: string } {
	if (reply === "") return { model: shortlist[0]?.model ?? null };
	if (reply === "none") return { model: null };
	if (/^\d+$/.test(reply)) {
		const picked = shortlist[Number(reply) - 1];
		return picked ? { model: picked.model } : { error: `${reply} is not one of the choices 1-${shortlist.length}` };
	}
	return available.includes(reply) ? { model: reply } : { error: `${reply} is not a model pi can use as the service sees it (pi --list-models lists them)` };
}

/** What a unit's process sees (units carry `CP_*` and PATH, never provider keys): HOME, USER, LOGNAME and the unit PATH. */
export function serviceListEnv(env: NodeJS.ProcessEnv, node: string): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { PATH: unitPath(node, env.PATH ?? "") };
	for (const key of ["HOME", "USER", "LOGNAME"] as const) if (env[key] !== undefined) out[key] = env[key];
	return out;
}

/** The parent's own default, as it would start today: `resolveParentModel` over the install env, then the supervisor's saved model. */
function parentDefaults(ports: InstallPorts, home: string): ModelChoice[] {
	const out: ModelChoice[] = [];
	try {
		out.push({ model: resolveParentModel(ports.env), why: "the parent's default (CP_PARENT_MODEL / PI_PROVIDER+PI_MODEL)" });
	} catch {
		// no model in the environment: the saved one, the rubric or pi's default recommends instead
	}
	try {
		const saved = (JSON.parse(ports.read(join(home, layoutForHome("multi", home).sessions, "cp-parent-control.json")) ?? "") as { model?: unknown }).model;
		if (typeof saved === "string" && saved.trim()) out.push({ model: saved.trim(), why: "the parent's current model (cp-parent-control.json)" });
	} catch {
		// absent or unreadable: no saved parent model
	}
	return out;
}

export interface ModelContext {
	flags: InstallFlags;
	ports: InstallPorts;
	home: string;
	app: string;
	agentDir: string;
	/** No generated data/daemon.json, cp-parent.service or wrapper: a first install. */
	fresh: boolean;
	force: boolean;
	/** --dry-run: pi is never run (it writes its auth/model state under HOME), so nothing is listed or checked. */
	dry?: boolean;
	prompting: boolean;
	answer: (question: string) => string;
	step: (status: StepStatus, name: string, detail: string) => void;
	/** What the generated unit/wrapper already pin. */
	kept: Models;
}

/**
 * Per target: `--parent-model`/`--operator-model` (on a fresh install a lone `--parent-model` sets both), else
 * the kept pin (an unpinned one stays so unless `--force`), else one prompt per target / the recommendation. "fail" writes nothing.
 */
export function chooseModels(ctx: ModelContext): Models | "fail" {
	const { flags, ports, kept, step } = ctx;
	const explicit: Models = {};
	for (const target of TARGETS) {
		const value = flags[`${target}-model`]?.trim();
		if (value) explicit[target] = value;
	}
	// A lone --parent-model on a fresh install still sets both; --operator-model sets only its own.
	if (ctx.fresh) explicit.operator ??= explicit.parent;
	const open = TARGETS.filter((target) => explicit[target] === undefined && (ctx.fresh || (ctx.force && kept[target] === undefined)));
	let listed: string[] | undefined;
	if (!ctx.dry && (open.length > 0 || explicit.parent !== undefined || explicit.operator !== undefined)) {
		// cp-daemon runs the parent with the unit-style env on either backend: list the models as it sees them.
		const result = ports.run("pi", ["--no-extensions", "--list-models"], ports.exists(ctx.home) ? ctx.home : undefined, serviceListEnv(ports.env, ports.node.path));
		listed = result.status === 0 ? parseModelList(result.stdout) : undefined;
	}
	const models: Models = {};
	for (const target of TARGETS) {
		const value = explicit[target];
		if (value === undefined) continue;
		const flag = flags[`${target}-model`] ? `--${target}-model` : `--${target === "parent" ? "operator" : "parent"}-model`;
		if (!MODEL_REF.test(value)) {
			step("fail", "model", `${value} (${flag}) is not a provider/model pi names`);
			return "fail";
		}
		if (listed !== undefined && listed.length > 0 && !listed.includes(value)) {
			step("fail", "model", `${value} (${flag}) is not a model pi can use as the service sees it (pi --no-extensions --list-models lists them)`);
			return "fail";
		}
		if (listed === undefined || listed.length === 0) step("skip", "model", `${target} ${value} (${flag}) written unchecked: ${ctx.dry ? "a dry-run never runs pi --list-models" : `pi's model list is ${listed === undefined ? "unreadable" : "empty"}`}`);
		models[target] = value;
		step(kept[target] === value ? "ok" : "changed", "model", `${target} ${value} (${flag})`);
	}
	for (const target of TARGETS) {
		if (explicit[target] !== undefined || open.includes(target)) continue;
		const value = kept[target];
		if (value === undefined) step("skip", "model", `${target}: none pinned; --force asks, --${target}-model <provider/model> --force pins one`);
		else {
			models[target] = value;
			step("ok", "model", `${target} ${value} kept`);
		}
	}
	if (open.length === 0) return models;
	if (ctx.dry) {
		step("skip", "model", `${open.join(", ")}: not listed in a dry-run (pi writes its state under HOME); a real run asks or recommends, --${open[0]}-model <provider/model> pins one`);
		return models;
	}
	if (listed === undefined || listed.length === 0) {
		const why = listed === undefined ? "pi --no-extensions --list-models gave no model table" : `no model pi can use as the service sees it (${join(ctx.agentDir, "auth.json")} and ambient credentials; a key exported only in this shell does not reach the units)`;
		step("skip", "model", `${why}: run \`pi\`, then /login, then rerun cp-install; nothing pinned`);
		return models;
	}
	const routing = ports.read(join(ctx.home, layoutForHome("multi", ctx.home).data, "routing.json")) ?? ports.read(join(ctx.app, "defaults/routing.default.json"));
	const piDefault = piDefaultModel(ports.read(join(ctx.agentDir, "settings.json")));
	const shortlist = modelShortlist(listed, [
		...parentDefaults(ports, ctx.home),
		...rubricModels(routing).map((model) => ({ model, why: "in the routing rubric" })),
		...(piDefault ? [{ model: piDefault, why: "your pi default" }] : []),
	]);
	// One question per target, the same list; the operator's Enter takes the parent's pick from this run.
	let parentPick: { model: string | null; how: string } | undefined;
	for (const target of open) {
		const inherited = target === "operator" ? parentPick : undefined;
		const fallback = inherited ? inherited.model : shortlist[0]?.model ?? null;
		const reply = ctx.prompting ? ctx.answer(modelPrompt(shortlist, listed.length, target, fallback)) : "";
		const picked: { model?: string | null; error?: string } = reply === "" ? { model: fallback } : pickModelReply(reply, shortlist, listed);
		if (picked.error !== undefined) {
			step("fail", "model", `${picked.error}; rerun with --${target}-model <provider/model>`);
			return "fail";
		}
		const how = reply !== "" ? "chosen at the prompt" : inherited ? inherited.how : `recommended: ${shortlist[0]?.why}`;
		if (target === "parent") parentPick = { model: picked.model ?? null, how };
		if (!picked.model) {
			step("skip", "model", `${target}: none chosen; --${target}-model <provider/model> --force pins one`);
			continue;
		}
		models[target] = picked.model;
		step("changed", "model", `${target} ${picked.model} (${how}; --${target}-model overrides)`);
	}
	return models;
}
