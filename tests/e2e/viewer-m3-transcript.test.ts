/**
 * M3 slice 1 (cp-zm9f): one dark palette and the compact chat transcript, through `bin/cp-view` on a scratch home and
 * the served app in its linkedom tab (DOM, classes and served CSS; no layout — the browser fixture's screenshots are
 * the layout evidence).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import { jsonl, viewer, write } from "../harness/conversations.ts";
import { openTab } from "../harness/dashboard.ts";

/** The minified stylesheet the served page links. */
const servedCss = async (d: { get(path: string): Promise<{ text: string }> }) => (await d.get(String(/<link rel="stylesheet" href="([^"]+)"/.exec((await d.get("/")).text)?.[1]))).text;
/** Every declaration the served CSS gives `selector` in `sheet`, in order. */
const rules = (sheet: string, selector: string) => [...sheet.matchAll(/(?<=^|[{}])([^{}@]+)\{([^{}]*)\}/g)].filter((m) => m[1] === selector).map((m) => m[2]).join(";");
/** The design's dark roles (new-design-picp-2026-11-01.html), as tokens.css serves them to every screen. */
const DESIGN = { page: "#0d0d0d", background: "#0d0d0d", nav: "#121212", surface: "#161616", raised: "#1b1b1b", "nav-selected": "#232323",
	border: "#2a2a2a", divider: "#1e1e1e", text: "#ededed", muted: "#b4b4b4", dim: "#8a8a8a", green: "#5fd39a", "check-background": "#10291d",
	"check-border": "#1f4a35", coral: "#f2917f", amber: "#f0b35a", blue: "#93b4f5", focus: "#7f9fd8" };
/** Each screen: its root class, the nav item it lights (desktop, phone) and its desktop section order on an empty home. */
const SCREENS: Array<[string, string, string, string, string[]]> = [
	["#sessions", "sessions", "Sessions", "Sessions", ["Fleet · 0 live"]],
	["#overview", "overview", "Overview", "Overview", ["In flight · 0", "Lined up · -", "Landed today · 0 merged"]],
	["#decisions", "decisions", "Decisions", "Decisions", ["Awaiting you · Nothing needs you", "Worth a look", "What comes to you"]],
	["#jobs", "jobs-screen", "Jobs", "Jobs", ["In flight · 0", "Done today · 0"]],
	["#stats", "stats", "Stats", "More", ["Jobs finished", "Spend", "Tokens", "Merge rate", "Median wall clock", "Decisions", "Jobs finishedper hour",
		"Median time per phasefinished jobs", "Tokens by modelper hour, millions", "Spend by model", "Parentresponsiveness and waste · all projects",
		"Mandatesspend and tokens against each grant, in this range"]],
	["#settings", "settings-screen", "Settings", "More", ["Devices", "Notifications"]],
	["#reports", "jobs-screen", "Reports", "More", ["Published · 0", "Job reports · 0", "Handoffs"]],
	["#files", "files", "More", "More", ["Projects", "Live worktrees · 0"]],
	["#map", "map-screen", "Jobs", "Jobs", ["Select a job or mandate"]],
];

test("M3-transcript-theme: one dark palette on Sessions and all eight other screens, light or dark device; layouts and section order kept", { timeout: 180_000 }, async (t) => {
	const d = await viewer(t);
	const css = await servedCss(d);
	const root = rules(css, ":root");
	assert.match(root, /color-scheme:dark/, "the canvas and native controls are dark whatever the device prefers");
	for (const [name, hex] of Object.entries(DESIGN)) assert.ok(root.includes(`--${name}: ${hex};`), `design token --${name}: ${hex}`);
	assert.equal(css.match(/prefers-color-scheme/g), null, "no light-scheme block: a light device gets the same dark palette");
	const others = [...css.matchAll(/(?<=^|[{}])([^{}@]+)\{([^{}]*)\}/g)].filter((m) => m[1] !== ":root");
	assert.deepEqual(others.filter((m) => /(?:^|;)--(?:page|background|nav|surface|raised|border|divider|text|muted|dim|green):/.test(m[2]!)).map((m) => m[1]), [],
		"no screen redefines a palette role");
	assert.deepEqual(others.filter((m) => /#[\da-f]{3,8}\b/i.test(m[2]!)).map((m) => m[1]), [], "no colour literal outside the tokens");
	assert.doesNotMatch(css, /font-family:(?!var\(--font-(?:sans|mono)\)|inherit)/, "every family is a system font token");
	for (const wide of [false, true]) for (const [hash, screen, desktop, phone, sections] of SCREENS) {
		const tab = await openTab(t, d.port, hash, new Map(), undefined, {}, wide);
		const main = await tab.find(`.shell-main > .${screen}`);
		await tab.find("h2", (h) => h.textContent === sections[0]);
		assert.equal(tab.$(".shell")!.getAttribute("class"), hash === "#sessions" ? "shell shell-sessions" : "shell", `${hash}: no theme variant on the shell`);
		// Count screen roots only: Shell's transient .page-header-fallback sibling is chrome, not a second screen.
		assert.equal(tab.$$(".shell-main > :not(.page-header-fallback)").length, 1, `${hash}: one screen root`);
		assert.deepEqual(tab.$$(`${wide ? ".shell-sidebar-nav > a" : ".shell-tabs a"}[aria-current=page]`).map((a) => a.textContent), [wide ? desktop : phone], `${hash}: nav owner`);
		if (wide) assert.deepEqual(tab.$$("h2").map((h) => h.textContent), sections, `${hash}: section order`);
		// The composer's auto-height is set through CSSOM (OperatorComposer), not markup; nothing else carries a style.
		assert.deepEqual(tab.$$("[style]").filter((el) => !el.matches(".operator-composer textarea")).map((el) => el.tagName), [], `${hash}: no inline style`);
		tab.close();
	}
});

const at = (hm: string) => `2026-11-01T${hm}:00Z`;
const line = (hm: string, message: unknown) => ({ type: "message", timestamp: at(hm), message });
const call = (id: string, name: string, result: string) => [
	line("14:00", { role: "assistant", content: [{ type: "toolCall", id, name, arguments: { id } }] }),
	line("14:00", { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: result }] }),
];

test("M3-transcript-chat: the operator chat keeps its steps pill and cards in a 720 px column (28 px sides, 14 px on a phone); Reports keeps its boards; nothing to acknowledge", { timeout: 180_000 }, async (t) => {
	const d = await viewer(t, { seed: (stateDir, home) => {
		const file = join(home, "pi-sessions", "chat.jsonl");
		write(file, jsonl([
			line("14:00", { role: "user", content: [{ type: "text", text: "OWN-MESSAGE" }] }),
			...call("t1", "read", "Read 42 lines"), ...call("t2", "bash", "Ran npm test"),
			line("14:01", { role: "assistant", content: [{ type: "text", text: "REPLY-CARD" }] }),
		]));
		write(operatorSessionsFile(join(stateDir, "sessions")), jsonl([{ at: at("13:00"), session_file: file }]));
	} });
	const css = await servedCss(d);
	const wide = css.indexOf(".session-entries{max-width:720px"), split = css.lastIndexOf("@media(min-width:900px)", wide);
	assert.ok(split > 0 && wide > split, "the 720 px column is desktop only");
	assert.match(rules(css.slice(0, split), ".session-entries"), /^padding:0 14px$/, "phone: 14 px sides");
	assert.match(rules(css.slice(split), ".session-entries"), /^max-width:720px;margin:0 auto;padding:0 28px$/, "desktop: 720 px, 28 px sides");
	assert.match(rules(css, ".session-steps-open>.session-steps-card"), /max-width:640px/, "an open steps card stays compact");
	for (const desktop of [false, true]) {
		const tab = await openTab(t, d.port, "#sessions?view=you&transcript=1", new Map(), undefined, {}, desktop);
		await tab.waitText(/REPLY-CARD/);
		assert.deepEqual(tab.$$(".session-steps > .session-tools").map((pill) => pill.textContent), ["≡ 2 steps · Read 42 lines ▸"], "the run is one steps pill");
		assert.deepEqual([tab.$$(".session-own").length > 0, tab.$$(".session-other").length > 0], [true, true], "own pill and the session's card");
		assert.doesNotMatch(tab.text(), /acknowledg/i, "M2: no acknowledgement in chat");
		tab.close();
	}
	const answers = await openTab(t, d.port, "#answers", new Map(), undefined, {}, true);
	await answers.find("h2", (h) => h.textContent === "Published · 0");
	assert.deepEqual(answers.$$(".shell-sidebar-nav > a[aria-current=page]").map((a) => a.textContent), ["Reports"], "#answers opens Reports, where boards live");
	assert.doesNotMatch(answers.text(), /acknowledg/i);
});
