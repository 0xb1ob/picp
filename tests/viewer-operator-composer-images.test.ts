/**
 * cp-br81: the composer's image attachments — the paperclip only while the session takes images, pick or paste
 * uploads one at a time, thumbnails from /api/operator/uploads/<id>, remove, client-side refusals, the send rule
 * and the `images` ids in the send body. Fake files are plain {name,type,size} objects; nothing is uploaded.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import type { ControlStatusResponse, OperatorUploadResponse } from "../src/viewer/api-types.ts";
import type { ControlBody, ControlView } from "../viewer-app/control.ts";
import { REPO_ROOT } from "./harness/index.ts";

const result = await build({stdin:{contents:'import {h,render} from "preact"; import {act} from "preact/test-utils"; import {OperatorComposer} from "./viewer-app/components/OperatorComposer.tsx"; export {act}; export const mount=(root,control)=>render(h(OperatorComposer,{control}),root); export const unmount=root=>render(null,root);',resolveDir:REPO_ROOT,loader:"tsx"},bundle:true,platform:"node",format:"esm",write:false,jsx:"automatic",jsxImportSource:"preact"});
const {act,mount,unmount} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.contents).toString("base64")}`) as {
	act: (fn: () => unknown) => Promise<void>; mount: (root: unknown, control: ControlView) => void; unmount: (root: unknown) => void;
};

const ready: ControlStatusResponse = { generated_at: "2026-10-04T18:00:00Z", enabled: true, running: true, reason: null, token: "t".repeat(64), busy: false, pending: false, session_file: "op.jsonl", recent: [], offline: false, held: 0, inbox_token: null, start_unavailable: null, launchers: { tmux: true, herdr: false }, resume: { tmux: false, herdr: false } };
type Fake = {name: string; type: string; size: number};
const png = (name: string, size = 1000): Fake => ({ name, type: "image/png", size });
const idFor = (n: number) => `im-20261004-${String(n).repeat(24)}.png`;

test("composer images: attach, upload in order, thumbnails, remove, refusals, send rule and the images in the body; paste attaches too", async t => {
	const {window,document} = parseHTML("<html><body><div id='root'></div></body></html>");
	const originals = ["window","document"].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
	Object.defineProperty(globalThis,"window",{configurable:true,value:window});
	Object.defineProperty(globalThis,"document",{configurable:true,value:document});
	t.after(() => { for (const [key,descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis,key,descriptor); else Reflect.deleteProperty(globalThis,key); } });
	const root = document.getElementById("root")!;
	const sends: ControlBody[] = [];
	const uploads: string[] = [];
	// Each upload waits until the test releases it, so "one at a time, in order" is observable.
	const waiting: Array<() => void> = [];
	let next = 0;
	const upload = (file: File) => new Promise<OperatorUploadResponse | {error: string}>(done => {
		uploads.push(file.name);
		waiting.push(() => { const id = idFor(++next); done(file.name === "bad.png" ? {error: "not a PNG, JPEG, WebP or GIF image"} : {id, mime: "image/png", bytes: file.size, expires_at: "x", url: `/api/operator/uploads/${id}`}); });
	});
	const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(done => setImmediate(done)); });
	const release = async () => { await act(() => waiting.shift()!()); await flush(); };
	const control = (status: ControlStatusResponse, withUpload = true): ControlView => ({ status, delivery: null, send: body => { sends.push(body); }, ...(withUpload ? {upload} : {}) });
	const $ = (selector: string) => root.querySelector(selector);
	const $$ = (selector: string) => [...root.querySelectorAll(selector)];
	const click = (el: Element | null) => act(() => { el!.dispatchEvent(new window.Event("click",{bubbles:true,cancelable:true})); });
	const pick = async (files: Fake[]) => {
		const input = $("input[type=file]")!;
		Object.defineProperty(input,"files",{configurable:true,value:files});
		await act(() => input.dispatchEvent(new window.Event("change",{bubbles:true})));
		await flush();
	};
	const sendDisabled = () => ($(".operator-composer-send") as HTMLButtonElement).disabled;

	await act(() => mount(root, control(ready, false)));
	assert.equal($(".operator-composer-attach"), null, "no upload port: no paperclip");
	await act(() => unmount(root));
	await act(() => mount(root, control(ready)));
	assert.equal($(".operator-composer-attach"), null, "the session's bridge does not take images: no paperclip");
	await act(() => unmount(root));

	await act(() => mount(root, control({ ...ready, images: true })));
	assert.ok($(".operator-composer-attach"), "the paperclip shows while the session takes images");
	assert.equal($("input[type=file]")!.getAttribute("accept"), "image/*");
	assert.ok($("input[type=file]")!.hasAttribute("multiple"));
	await pick([png("a.png"), png("b.png")]);
	assert.deepEqual(uploads, ["a.png"], "one upload at a time");
	assert.deepEqual($$(".operator-composer-attachment-state").map(el => el.textContent), ["Uploading…", "Uploading…"]);
	assert.equal(sendDisabled(), true, "send waits for the uploads");
	await release();
	assert.deepEqual(uploads, ["a.png", "b.png"], "the second starts after the first");
	await release();
	assert.deepEqual($$(".operator-composer-thumb").map(el => el.getAttribute("src")), [`/api/operator/uploads/${idFor(1)}`, `/api/operator/uploads/${idFor(2)}`]);
	assert.equal(sendDisabled(), false, "images alone can be sent");

	await click($$(".operator-composer-thumb-remove")[0]!);
	assert.equal($$(".operator-composer-thumb").length, 1, "remove drops one");
	await click($(".operator-composer-send"));
	assert.deepEqual(sends, [{kind: "message", text: "", images: [idFor(2)]}]);
	assert.equal($(".operator-composer-attachments"), null, "attachments clear on send");

	// Client refusals: HEIC by type or name, not an image, over 10 MiB, a 9th image; a server refusal shows too.
	sends.length = 0;
	await pick([{name: "photo.heic", type: "", size: 10}, {name: "x.HEIF", type: "image/heif", size: 10}, {name: "doc.pdf", type: "application/pdf", size: 10}, png("huge.png", 11 * 1024 * 1024), png("bad.png")]);
	await release();
	const failed = $$(".operator-composer-attachment-failed").map(el => el.textContent);
	assert.deepEqual(failed, [
		"HEIC/HEIF is not supported; share the photo as JPEG",
		"HEIC/HEIF is not supported; share the photo as JPEG",
		"doc.pdf is not a PNG, JPEG, WebP or GIF image",
		"huge.png is larger than 10 MiB",
		"not a PNG, JPEG, WebP or GIF image",
	]);
	assert.equal(sendDisabled(), true, "a failed image blocks sending until removed");
	for (const button of $$(".operator-composer-thumb-remove")) await click(button);
	assert.equal($(".operator-composer-attachments"), null);
	await pick(Array.from({length: 9}, (_, i) => png(`p${i}.png`)));
	assert.equal($$(".operator-composer-attachment-failed").length, 1);
	assert.equal($(".operator-composer-attachment-failed")!.textContent, "At most 8 images per message");
	for (let i = 0; i < 8; i++) await release();
	for (const button of $$(".operator-composer-thumb-remove")) await click(button);

	// Paste: image files attach; a paste with text keeps its default so the text lands too.
	const paste = async (files: Fake[], types: string[]) => {
		// Preact lowercases an event name only when the element has the `on…` property; linkedom has no `onpaste`.
		const event = new window.Event("onpaste" in $("textarea")! ? "paste" : "Paste",{bubbles:true,cancelable:true});
		Object.defineProperty(event,"clipboardData",{value:{files, types}});
		await act(() => $("textarea")!.dispatchEvent(event));
		await flush();
		return event;
	};
	const before = uploads.length;
	const imageOnly = await paste([png("pasted.png")], ["Files"]);
	assert.equal(uploads.length, before + 1);
	assert.equal(imageOnly.defaultPrevented, true);
	await release();
	const textToo = await paste([png("mixed.png")], ["text/plain", "Files"]);
	assert.equal(textToo.defaultPrevented, false, "the pasted text is not swallowed");
	await release();
	const textOnly = await paste([], ["text/plain"]);
	assert.equal(textOnly.defaultPrevented, false);
	assert.equal($$(".operator-composer-thumb").length, 2);
	($("textarea") as HTMLTextAreaElement).value = "two pasted";
	await act(() => $("textarea")!.dispatchEvent(new window.Event("input",{bubbles:true})));
	await click($(".operator-composer-send"));
	assert.deepEqual(sends, [{kind: "message", text: "two pasted", images: [idFor(next - 1), idFor(next)]}]);
	await act(() => unmount(root));
});
