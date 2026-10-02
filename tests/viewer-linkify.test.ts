import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import { linkify, localPaths } from "../src/viewer/linkify.ts";
import { composerHref, DECISIONS_HREF, decisionsFallback, route, screenDataUrl } from "../viewer-app/routes.ts";
import { createResource, type Stream } from "../viewer-app/resource.ts";
import { REPO_ROOT } from "./harness/index.ts";

const ext = (text: string, href = text) => ({ text, href, external: true });

test("linkify: http URLs, trailing punctuation, parens, markdown links, unsafe schemes, local paths", () => {
 assert.deepEqual(linkify("see https://example.com/a?b=1 now"), [{ text: "see " }, ext("https://example.com/a?b=1"), { text: " now" }]);
 assert.deepEqual(linkify("Done: http://x.io/pr/7."), [{ text: "Done: " }, ext("http://x.io/pr/7"), { text: "." }], "a trailing period is not the link's");
 assert.deepEqual(linkify("a https://x.io/b, c; https://x.io/d:"), [{ text: "a " }, ext("https://x.io/b"), { text: ", c; " }, ext("https://x.io/d"), { text: ":" }]);
 assert.deepEqual(linkify("(see https://x.io/p)"), [{ text: "(see " }, ext("https://x.io/p"), { text: ")" }], "a wrapping paren stays outside");
 assert.deepEqual(linkify("https://en.wikipedia.org/wiki/Foo_(bar)."), [ext("https://en.wikipedia.org/wiki/Foo_(bar)"), { text: "." }], "a balanced paren is kept");
 assert.deepEqual(linkify("[the PR](https://github.com/o/r/pull/9) landed"), [ext("the PR", "https://github.com/o/r/pull/9"), { text: " landed" }]);
 for (const unsafe of ["javascript:alert(1)", "[x](javascript:alert(1))", "data:text/html,hi", "[x](data:text/html,hi)", "ftp://x.io/a", "https://"]) {
  assert.deepEqual(linkify(unsafe), [{ text: unsafe }], `${unsafe} stays plain text`);
 }
 const path = "/home/u/.pi-command-post/state/runs/cp-a/artifact.md";
 const text = `wrote ${path}. and /home/u/.pi-command-post/gone.md`;
 assert.deepEqual(localPaths(text), [path, "/home/u/.pi-command-post/gone.md"], "the server resolves exactly the trimmed paths");
 const files = "#files?root=home&path=state%2Fruns%2Fcp-a%2Fartifact.md";
 assert.deepEqual(linkify(text, { [path]: files }), [{ text: "wrote " }, { text: path, href: files }, { text: ". and /home/u/.pi-command-post/gone.md" }], "a resolved path goes to Files; an unresolved one stays text");
 assert.deepEqual(localPaths("src/viewer/a.ts and /etc/passwd"), [], "only .pi-command-post paths");
});

test("route: Operator ↔ you opens on the Full transcript; transcript=0 is Decisions; a refused default falls back", async () => {
 for (const hash of ["#sessions", "#sessions?view=you"]) {
  const r = route(hash);
  assert.equal(new URLSearchParams(r.query).get("transcript"), "1", `${hash} asks for the Full transcript`);
  assert.equal(r.defaulted, true);
 }
 const decisions = route(DECISIONS_HREF);
 assert.equal(screenDataUrl(decisions), "/api/sessions?view=you&transcript=0", "an explicit transcript=0 asks for Decisions");
 assert.equal(decisions.defaulted, undefined);
 assert.equal(route("#sessions?view=you&transcript=1").defaulted, undefined, "a deep link is an explicit choice");
 assert.equal(new URLSearchParams(route("#sessions?view=parent").query).get("transcript"), null, "other tiers are untouched");
 const back = decisionsFallback(route("#sessions"));
 assert.equal(screenDataUrl(back), "/api/sessions?view=you&transcript=0"); assert.equal(back.defaulted, false);
 // cp-hhuf P6: Add schedule… opens the Full transcript with a draft that stays in the hash, never in the API URL.
 const add = route(composerHref("a b?c"));
 assert.equal(new URLSearchParams(add.query).get("draft"), "a b?c");
 assert.equal(add.defaulted, undefined);
 assert.equal(screenDataUrl(add), "/api/sessions?view=you&transcript=1");

 // The 403 the server answers off --require-tailnet reaches the app as the snapshot's code.
 class Events extends EventTarget implements Stream { close() {} }
 const resource = createResource("/api/sessions?view=you&transcript=1", "/api/stream?view=sessions", {
  fetch: async () => new Response("{}", { status: 403 }), stream: () => new Events(),
 });
 resource.setVisible(true);
 await new Promise<void>((resolve) => setImmediate(resolve));
 assert.equal(resource.snapshot().code, 403); resource.dispose();
});

test("a rendered transcript entry carries its links as elements, never raw HTML", async () => {
 const built = await build({ stdin: { contents: 'import {h} from "preact"; import render from "preact-render-to-string"; import {Sessions} from "./viewer-app/screens/Sessions.tsx"; export const screen=data=>render(h(Sessions,{data}));', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact" });
 const { screen } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.contents).toString("base64")}`);
 const path = "/home/u/.pi-command-post/state/runs/cp-a/artifact.md";
 const row = { id: "a1", at: "", kind: "say", who: "Assistant", name: null, send_id: null, tag: null, failed: false, trace: [],
  text: `PR https://github.com/o/r/pull/9. read \`${path}\` <b>x</b> javascript:alert(1)`, links: { [path]: "#job/cp-a" } };
 const html: string = screen({ generated_at: "", selected: "you", session_id: null, parent: { id: "cp-parent", live: false }, workers: [], entries: [row], title: "Operator ↔ you", subtitle: "Full transcript", warnings: [], truncated: false, transcript: true });
 assert.match(html, /<a href="https:\/\/github.com\/o\/r\/pull\/9" target="_blank" rel="noopener noreferrer">https:\/\/github.com\/o\/r\/pull\/9<\/a>\./);
 assert.match(html, /<code><a href="#job\/cp-a">\/home\/u\/\.pi-command-post\/state\/runs\/cp-a\/artifact\.md<\/a><\/code>/);
 assert.match(html, /&lt;b>x&lt;\/b> javascript:alert\(1\)/, "markup and unsafe schemes stay text");
 // Audit P4 #27: no Decisions | Full transcript toggle; the decision log lives on the Decisions page.
 assert.doesNotMatch(html, /transcript=0|>Decisions<\/a>|session-views/);
});

/** Mount under linkedom with fetch and EventSource stubbed; restores every global it touched. */
async function dom(t: { after(fn: () => void): void }, fetch: (url: string) => Promise<Response>) {
 const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
 class Source extends EventTarget { close() {} }
 const stubs: Record<string, unknown> = { window, document, fetch: (url: string) => fetch(url), EventSource: Source };
 const originals = Object.keys(stubs).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
 for (const [key, value] of Object.entries(stubs)) Object.defineProperty(globalThis, key, { configurable: true, value });
 t.after(() => { for (const [key, d] of originals) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); } });
 const built = await build({ stdin: { contents: 'import {h,render} from "preact"; import {act} from "preact/test-utils"; import {DetailScreen} from "./viewer-app/app.tsx"; import {Sessions} from "./viewer-app/screens/Sessions.tsx"; import {route} from "./viewer-app/routes.ts"; export {act}; export const detail=(root,hash)=>render(h(DetailScreen,{current:route(hash)}),root); export const sessions=(root,data)=>render(h(Sessions,{data}),root); export const unmount=root=>render(null,root);', resolveDir: REPO_ROOT, loader: "tsx" }, loader: { ".css": "empty" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact" });
 const mod = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.contents).toString("base64")}`);
 return { ...mod, window, root: document.getElementById("root")! };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("DetailScreen: a defaulted Full transcript refused with 403 ends on the transcript=0 request", async (t) => {
 const asked: string[] = [];
 const { act, detail, unmount, root } = await dom(t, async (url) => {
  asked.push(url);
  return url.includes("transcript=1") ? new Response("{}", { status: 403 }) : new Promise<Response>(() => {});
 });
 await act(() => detail(root, "#sessions"));
 for (let i = 0; i < 5; i++) await act(settle);
 const sessions = asked.filter((url) => url.startsWith("/api/sessions"));
 assert.deepEqual(sessions, ["/api/sessions?view=you&transcript=1", "/api/sessions?view=you&transcript=0"], "one refused default, then Decisions");
 assert.doesNotMatch(root.textContent!, /Refresh failed/, "the fallback is silent");
 await act(() => unmount(root));
});

test("an opened bridge notice renders its first line as text, so its URL is a link; the toggle stays a button", async (t) => {
 const { act, sessions, unmount, root, window } = await dom(t, () => new Promise<Response>(() => {}));
 const bridge = { id: "b1", at: "", kind: "system", who: "cp-bridge", name: null, send_id: null, tag: "bridge", failed: false, trace: [], text: "PR https://github.com/o/r/pull/9 landed\nsecond line" };
 await act(() => sessions(root, { generated_at: "", selected: "you", session_id: null, parent: { id: "cp-parent", live: false }, workers: [], entries: [bridge], title: "Operator ↔ you", subtitle: "Full transcript", warnings: [], truncated: false, transcript: true }));
 const toggle = root.querySelector(".session-notice-line")!;
 assert.equal(root.querySelector(".session-bridge a[target=_blank]"), null, "collapsed, the first line is the button's label");
 await act(() => { toggle.dispatchEvent(new window.Event("click", { bubbles: true })); });
 const link = root.querySelector(".session-bridge p a")!;
 assert.equal(link.getAttribute("href"), "https://github.com/o/r/pull/9"); assert.equal(link.getAttribute("rel"), "noopener noreferrer");
 const button = root.querySelector(".session-notice-line")!;
 assert.equal(button.tagName, "BUTTON"); assert.equal(button.getAttribute("aria-expanded"), "true");
 assert.equal(button.textContent, "1 more line", "open, the button shows only its count");
 await act(() => unmount(root));
});
