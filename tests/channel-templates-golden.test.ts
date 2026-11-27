/**
 * Golden exception (docs/testing-migration.md): every template src/channels/render.ts posts, pinned as `{text, blocks}`
 * in `tests/golden/channel-<name>.txt`.
 */
import { test } from "node:test";
import { renderAmbiguous, renderCard, renderClosed, renderNotice, renderReceipt, renderReply, renderTooLong, renderWhich } from "../src/channels/render.ts";
import type { OperatorAsk } from "../src/operator-asks.ts";
import { assertGolden } from "./harness/golden.ts";

const HOME = "/home/fixture";
const HOMES = [HOME, `${HOME}/.pi-command-post`];
const LINK = "https://cp.example.test/#awaiting";
const TRANSCRIPT = "https://cp.example.test/#sessions?view=you&transcript=1";
const ask = (id: string, question: string, recommendation = "Keep"): OperatorAsk => ({
	id, project: "demo", question, created_at: "2026-11-27T09:00:00Z", state: "open", recommendation,
	options: [{ label: "Keep", consequence: "keep it" }, { label: "Drop <now> & go", consequence: "drop it" }, { label: "Later", consequence: "wait" }],
});
const long = `${"First paragraph: the operator explains what happened in detail. ".repeat(8)}\n\nSecond paragraph never posted.`;

const TEMPLATES: Record<string, () => unknown> = {
	card: () => renderCard(ask("ask-0a1b2c", "Ship cp-demo now?"), LINK, HOMES),
	"card-recommended-last": () => renderCard(ask("ask-0a1b2d", "Which branch?", "Later"), LINK, HOMES),
	"card-no-link": () => renderCard(ask("ask-0a1b2e", "Ship cp-demo now?"), null, HOMES),
	notice: () => renderNotice("Approve the plan for cp-demo?", LINK),
	answered: () => renderClosed(ask("ask-0a1b2c", "Ship cp-demo now?"), { answered: "Drop <now> & go" }, HOMES),
	withdrawn: () => renderClosed(ask("ask-0a1b2c", "Ship cp-demo now?"), "withdrawn", HOMES),
	which: () => renderWhich([ask("ask-0a1b2c", "Ship cp-demo now?"), ask("ask-0a1b2d", "Which branch?", "Later")], HOMES),
	"reply-short": () => renderReply("[demo] cp-demo: merged.\nCI green on the head.", TRANSCRIPT, HOMES),
	"reply-long": () => renderReply(long, TRANSCRIPT, HOMES),
	// Built at runtime so no token-shaped literal sits in the repository.
	"reply-redacted": () => renderReply(`Rotated ${["ghp", "abcdefghij".repeat(3)].join("_")} today.`, TRANSCRIPT, HOMES),
	"reply-secret-fallback": () => renderReply("Key:\n-----BEGIN PRIVATE KEY-----\nMIIE", TRANSCRIPT, HOMES),
	"reply-home-path": () => renderReply(`Report at ${HOME}/.pi-command-post/state/artifacts/cp-demo/report.md and ${HOME}/notes.md`, TRANSCRIPT, HOMES),
	ambiguous: () => renderAmbiguous(TRANSCRIPT),
	"too-long": () => renderTooLong(),
	receipts: () => [
		renderReceipt({ state: "queued" }, HOMES),
		renderReceipt({ state: "behind" }, HOMES),
		renderReceipt({ state: "delivered" }, HOMES),
		renderReceipt({ state: "held" }, HOMES),
		renderReceipt({ state: "dropped", reason: "held longer than 24 h" }, HOMES),
		renderReceipt({ state: "refused", reason: `the offline inbox is unwritable at ${HOME}/.pi-command-post/state` }, HOMES),
	],
};

for (const [name, render] of Object.entries(TEMPLATES)) {
	test(`channel template golden: ${name}`, () => assertGolden(`channel-${name}.txt`, JSON.stringify(render(), null, 2)));
}
