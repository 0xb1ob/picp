/**
 * Remote dashboard PR 1b: `GET /pair`, the one page an unpaired browser may load. Self-contained (no asset, no
 * storage, no external request) under a CSP that admits exactly its own inline script and style by hash. The code
 * travels in the fragment, which the script reads into memory and scrubs from the address bar before anything else
 * runs; it is posted once per press to `POST /api/pair/claim` and never retried on its own.
 */
import { createHash } from "node:crypto";

const STYLE = "body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}"
	+ "@media(prefers-color-scheme:dark){body{color:#eee;background:#111}}"
	+ "label,input,button{display:block;width:100%;box-sizing:border-box;font:inherit}input,button{min-height:44px;margin:.5rem 0;padding:.5rem}"
	+ "p{overflow-wrap:anywhere}";

const SCRIPT = `(() => {
const code = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
const form = document.getElementById("pair"), name = document.getElementById("name"), out = document.getElementById("out"), button = document.getElementById("go");
if (!/^[A-Za-z0-9_-]{43}$/.test(code)) { form.hidden = true; out.textContent = "This pairing link has no valid code. Run cp-tunnel pair in your terminal for a new link."; return; }
form.addEventListener("submit", async (event) => {
event.preventDefault();
button.disabled = true;
out.textContent = "Pairing…";
try {
const res = await fetch("/api/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: name.value }), credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" });
if (res.ok) { location.replace("/"); return; }
const body = await res.json().catch(() => ({}));
out.textContent = "Not paired: " + (typeof body.error === "string" ? body.error : "status " + res.status);
if (res.status === 400 || res.status === 409) button.disabled = false; else form.hidden = true;
} catch { out.textContent = "Network error; the code may still work. Press Pair to try again."; button.disabled = false; }
});
})();`;

const hash = (text: string): string => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

export const PAIR_PAGE_PATH = "/pair";
export const PAIR_CSP = `default-src 'none'; script-src ${hash(SCRIPT)}; style-src ${hash(STYLE)}; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
export const PAIR_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>Pair this device</title><style>${STYLE}</style></head>
<body><h1>Pair this device</h1>
<p>A Full-control device is trusted like your terminal. Use View only for a less-trusted device; the level was chosen when this link was made.</p>
<form id="pair"><label for="name">Device name</label><input id="name" name="name" required maxlength="80" autocomplete="off"><button id="go" type="submit">Pair</button></form>
<p id="out" role="status" aria-live="polite"></p>
<script>${SCRIPT}</script></body></html>
`;
