/**
 * cp-if9x: the worker-side egress guard for pi-web-access's four tools. One
 * case per rule, both sides of each length threshold, and reasons that name
 * the variable or rule, never the value.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JOB_PATH_MIN, SECRET_VALUE_MIN, WEB_TOOLS, webEgressRefusal } from "../src/web-egress.ts";

const CLEAN = { queries: ["node test runner --test-force-exit"] };

test("the guard covers exactly the four web tools and passes everything else through", () => {
	assert.deepEqual([...WEB_TOOLS], ["web_search", "fetch_content", "get_search_content", "source_check"]);
	assert.equal(webEgressRefusal("bash", { command: "cat .pi-command-post/state/x" }, {}), undefined);
	assert.equal(webEgressRefusal("web_enable", { query: ".pi-command-post" }, {}), undefined);
	assert.equal(webEgressRefusal("web_search", CLEAN, {}), undefined);
	assert.equal(webEgressRefusal("fetch_content", { url: "https://nodejs.org/api/test.html" }, {}), undefined);
});

test("proxy and a non-none workflow are refused", () => {
	assert.match(webEgressRefusal("web_search", { ...CLEAN, proxy: "http://p:8080" }, {}) ?? "", /proxy/);
	assert.equal(webEgressRefusal("web_search", { ...CLEAN, proxy: "" }, {}), undefined);
	assert.match(webEgressRefusal("source_check", { claim: "x", workflow: "summary-review" }, {}) ?? "", /workflow/);
	assert.equal(webEgressRefusal("web_search", { ...CLEAN, workflow: "none" }, {}), undefined);
});

test("fetch_content: answer mode, answerModel and non-http(s) URLs are refused", () => {
	assert.match(webEgressRefusal("fetch_content", { url: "https://x.dev", mode: "answer" }, {}) ?? "", /answer mode/);
	assert.match(webEgressRefusal("fetch_content", { url: "https://x.dev", answerModel: "m" }, {}) ?? "", /answer mode/);
	assert.match(webEgressRefusal("fetch_content", { url: "file:///etc/passwd" }, {}) ?? "", /http\(s\)/);
	assert.match(webEgressRefusal("fetch_content", { urls: ["https://ok.dev", "/local/video.mp4"] }, {}) ?? "", /http\(s\)/);
});

test("command-post state and job paths never leave the host, at the one threshold", () => {
	assert.equal(JOB_PATH_MIN, 8);
	assert.match(webEgressRefusal("web_search", { query: "/home/u/.pi-command-post/state/x" }, {}) ?? "", /\.pi-command-post/);
	const long = { CP_WORKTREE: "/w/abcdefgh" };
	const refused = webEgressRefusal("web_search", { query: "error in /w/abcdefgh/src/a.ts" }, long) ?? "";
	assert.match(refused, /CP_WORKTREE/);
	assert.equal(refused.includes("/w/abcdefgh"), false, "the reason never carries the value");
	assert.equal(webEgressRefusal("web_search", { query: "/h is a path" }, { CP_HOME: "/h" }), undefined, "under 8 chars is too generic");
	assert.equal(webEgressRefusal("web_search", { query: "abcdefg" }, { CP_RUN_DIR: "abcdefg" }), undefined, "7 chars is under the threshold");
	assert.match(webEgressRefusal("web_search", { query: "abcdefgh" }, { CP_ARTIFACT_PATH: "abcdefgh" }) ?? "", /CP_ARTIFACT_PATH/);
});

test("a secret env value is refused by name, never echoed; shorter values pass", () => {
	assert.equal(SECRET_VALUE_MIN, 12);
	const value = "zq9Xv2Lm8Rt4";
	const refused = webEgressRefusal("web_search", { query: `why ${value}` }, { FOO_API_KEY: value }) ?? "";
	assert.match(refused, /FOO_API_KEY/);
	assert.equal(refused.includes(value), false);
	assert.equal(webEgressRefusal("web_search", { query: "why zq9Xv2Lm8Rt" }, { FOO_API_KEY: "zq9Xv2Lm8Rt" }), undefined, "11 chars is under the threshold");
	assert.equal(webEgressRefusal("web_search", { query: `why ${value}` }, { FOO_NAME: value }), undefined, "only secret-named variables count");
});

test("a credential shape is refused by pattern name", () => {
	const token = `ghp_${"a".repeat(20)}`;
	const refused = webEgressRefusal("get_search_content", { responseId: token }, {}) ?? "";
	assert.match(refused, /github token/);
	assert.equal(refused.includes(token), false);
	assert.match(refused, /keep repository content, paths and credentials out of them/);
});
