/** cp-er76: cp-install's model step — pi's listing parsed, the shortlist ordered, the reply picked. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { modelPrompt, modelShortlist, parseModelList, pickModelReply, piDefaultModel, rubricModels, serviceListEnv } from "../src/service/models.ts";
import { REPO_ROOT } from "./harness/index.ts";

const TABLE = [
	"provider      model              context  max-out  thinking  images",
	"anthropic     claude-opus-5-5    1M       128K     yes       yes   ",
	"openai        gpt-6.1-sol        400K     128K     yes       yes   ",
	"openai        bad$id             400K     128K     yes       yes   ",
	"openai        bad'quote          400K     128K     yes       yes   ",
	"openai-codex  gpt-6.1-sol        400K     128K     yes       no    ",
].join("\n");

test("parseModelList: rows in order; none available is []; not the table is undefined; unsafe ids dropped", () => {
	assert.deepEqual(parseModelList(`${TABLE}\n`), ["anthropic/claude-opus-5-5", "openai/gpt-6.1-sol", "openai-codex/gpt-6.1-sol"]);
	assert.deepEqual(parseModelList("No models available. Use /login or set an API key environment variable. See docs.\n"), []);
	assert.equal(parseModelList(""), undefined);
	assert.equal(parseModelList("error: unknown flag --list-models"), undefined);
});

test("rubricModels: the shipped rubric's models in row order; invalid JSON is []", () => {
	assert.deepEqual(rubricModels(readFileSync(join(REPO_ROOT, "defaults/routing.default.json"), "utf8")), ["anthropic/claude-opus-5-5", "openai/gpt-6.1-sol", "anthropic/claude-sonnet-5-5"]);
	assert.deepEqual(rubricModels("{"), []);
	assert.deepEqual(rubricModels(undefined), []);
});

test("piDefaultModel: both settings keys, else undefined", () => {
	assert.equal(piDefaultModel(JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-6.1-sol" })), "openai-codex/gpt-6.1-sol");
	assert.equal(piDefaultModel(JSON.stringify({ defaultModel: "x" })), undefined);
	assert.equal(piDefaultModel("not json"), undefined);
});

test("modelShortlist: listed only, deduped, in preference order, at most 9; nothing preferred listed falls back to the listing", () => {
	const listed = ["a/1", "b/2", "c/3"];
	assert.deepEqual(modelShortlist(listed, [{ model: "b/2", why: "the parent's default" }, { model: "z/9", why: "in the routing rubric" }, { model: "a/1", why: "in the routing rubric" }, { model: "b/2", why: "your pi default" }]), [{ model: "b/2", why: "the parent's default" }, { model: "a/1", why: "in the routing rubric" }]);
	assert.deepEqual(modelShortlist(listed, [{ model: "z/9", why: "x" }]).map((c) => c.why), ["listed by pi", "listed by pi", "listed by pi"]);
	const many = Array.from({ length: 12 }, (_, n) => `p/m${n}`);
	assert.equal(modelShortlist(many, []).length, 9);
});

test("modelPrompt: numbered, the first marked recommended, default [1]", () => {
	const text = modelPrompt([{ model: "openai/gpt-6.1-sol", why: "the parent's default" }, { model: "anthropic/claude-opus-5-5", why: "in the routing rubric" }], 5);
	assert.match(text, /^Model for the parent and the operator session — .*\(5 available/);
	assert.match(text, /\n {2}1\) openai\/gpt-6\.1-sol {9}recommended: the parent's default\n/);
	assert.match(text, /\n {2}2\) anthropic\/claude-opus-5-5 {2}in the routing rubric\n/);
	assert.match(text, /Choose 1-2, type a provider\/model, or none \[1\]: $/);
});

test("pickModelReply: empty, a number, a listed ref and none pick; out of range and unlisted refs are errors", () => {
	const shortlist = [{ model: "a/1", why: "x" }, { model: "b/2", why: "y" }];
	const listed = ["a/1", "b/2", "c/3"];
	assert.deepEqual(pickModelReply("", shortlist, listed), { model: "a/1" });
	assert.deepEqual(pickModelReply("2", shortlist, listed), { model: "b/2" });
	assert.match(pickModelReply("9", shortlist, listed).error ?? "", /not one of the choices 1-2/);
	assert.deepEqual(pickModelReply("c/3", shortlist, listed), { model: "c/3" });
	assert.match(pickModelReply("x/y", shortlist, listed).error ?? "", /not a model pi can use/);
	assert.deepEqual(pickModelReply("none", shortlist, listed), { model: null });
});

test("serviceListEnv: HOME, USER, LOGNAME and the unit PATH only — a shell-only provider key never reaches the listing", () => {
	const env = serviceListEnv({ HOME: "/h", USER: "u", PATH: "/usr/bin:/run/user/1/fnm_multishells/9/bin", ANTHROPIC_API_KEY: "sk", PI_CODING_AGENT_DIR: "/x" }, "/opt/node/bin/node");
	assert.deepEqual(env, { HOME: "/h", USER: "u", PATH: "/opt/node/bin:/usr/bin" });
});
