/**
 * Mandate defaults (autonomy-programme-cur.2.5): "fix example-infra #17" is a
 * complete mandate. Scaffold, ladder (explicit > project > home) and
 * provenance, plus the deterministic proof that `cp_mandate issue` needs
 * only projects and objective.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import {
	formatMandateDefaults,
	loadMandateDefaults,
	MandateDefaultsError,
	resolveMandateGrant,
	sameProjectMandateOverride,
	SCAFFOLD_MANDATE_DEFAULTS,
	setMandateDefault,
} from "../src/mandate-defaults.ts";
import { MandateStore } from "../src/mandate.ts";
import { scaffoldHome } from "../src/scaffold.ts";
import { createScratchHome } from "./harness/index.ts";

test("loadMandateDefaults falls back to the scaffold values when the file does not exist yet", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	assert.deepEqual(loadMandateDefaults(home.path), SCAFFOLD_MANDATE_DEFAULTS);
});

test("scaffoldHome writes data/mandate-defaults.json once, with the scope's conservative values", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const first = scaffoldHome({ home: home.path, ledger: false });
	const step = first.steps.find((s) => s.step === "mandate-defaults");
	assert.equal(step?.action, "created");
	const file = join(home.path, LAYOUT.mandateDefaultsFile);
	assert.ok(existsSync(file));
	const written = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(written.expiry_hours, 8);
	assert.equal(written.spend_usd, 100);
	assert.equal(written.spend_tokens, 10_000_000, "non-cached; ~3x the 2026-09-23 session's 3.06M non-cached tokens");
	assert.equal(written.token_ceiling, 100_000_000);
	assert.equal(written.job_cap, 3);
	assert.equal(written.dispatch_parallelism, 3);
	assert.equal(written.notes.dispatch_parallelism, "jobs under the grant that may run at once; set 1 for serial");
	assert.deepEqual(written.allowed_actions.sort(), ["implement", "merge", "plan", "repair", "review"].sort());
	assert.deepEqual(written.ask_on, ["risk:high"]);
	assert.deepEqual(written.exclude_paths, [".github/workflows/", "secrets/", "**/.env*"]);
	assert.ok(written.notes && typeof written.notes.expiry_hours === "string");

	// Never rewritten: an operator edit survives a second scaffold.
	writeFileSync(file, JSON.stringify({ ...written, spend_usd: 42 }));
	const second = scaffoldHome({ home: home.path, ledger: false });
	assert.equal(second.steps.find((s) => s.step === "mandate-defaults")?.action, "present");
	assert.equal(loadMandateDefaults(home.path).spend_usd, 42);
});

test("an existing home's configured dispatch_parallelism 1 survives scaffold and resolves as is", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const file = join(home.path, LAYOUT.mandateDefaultsFile);
	const before = JSON.stringify({ ...SCAFFOLD_MANDATE_DEFAULTS, dispatch_parallelism: 1 });
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, before);
	assert.equal(scaffoldHome({ home: home.path, ledger: false }).steps.find((s) => s.step === "mandate-defaults")?.action, "present");
	assert.equal(readFileSync(file, "utf8"), before, "no migration: the file is untouched");
	const resolved = resolveMandateGrant({}, loadMandateDefaults(home.path), undefined);
	assert.equal(resolved.dispatch_parallelism, 1);
	assert.equal(resolved.provenance.dispatch_parallelism, "home");
});

test("loadMandateDefaults refuses an invalid file rather than guessing", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	scaffoldHome({ home: home.path, ledger: false });
	writeFileSync(join(home.path, LAYOUT.mandateDefaultsFile), JSON.stringify({ ...SCAFFOLD_MANDATE_DEFAULTS, job_cap: 0 }));
	assert.throws(() => loadMandateDefaults(home.path), MandateDefaultsError);
});

test("setMandateDefault writes atomically and rejects an unknown key", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const next = setMandateDefault(home.path, "job_cap", "9");
	assert.equal(next.job_cap, 9);
	assert.equal(loadMandateDefaults(home.path).job_cap, 9);
	const withList = setMandateDefault(home.path, "ask_on", "merge, risk:high");
	assert.deepEqual(withList.ask_on, ["merge", "risk:high"]);
	assert.throws(() => setMandateDefault(home.path, "bogus", "1"), MandateDefaultsError);
	assert.throws(() => setMandateDefault(home.path, "job_cap", "not-a-number"), MandateDefaultsError);
	assert.equal(setMandateDefault(home.path, "token_ceiling", "50000000").token_ceiling, 50_000_000);
	assert.equal(new MandateStore(home.path).tokenCeiling(), 50_000_000);
	assert.match(formatMandateDefaults(loadMandateDefaults(home.path)), /token_ceiling: 50000000/);
	writeFileSync(join(home.path, LAYOUT.mandateDefaultsFile), "{ not json");
	assert.equal(new MandateStore(home.path).tokenCeiling(), 0, "an unreadable file fails closed: nothing is parent-raisable");
});

test("formatMandateDefaults prints every field and its note", () => {
	const text = formatMandateDefaults(SCAFFOLD_MANDATE_DEFAULTS);
	assert.match(text, /expiry_hours: 8/);
	assert.match(text, /spend_usd: 100/);
	assert.match(text, /conservative so a stale mandate/);
});

test("resolveMandateGrant ladder: explicit wins over project, project wins over home", () => {
	const home = SCAFFOLD_MANDATE_DEFAULTS;
	const project = { spend_usd: 25, job_cap: 5 };
	const resolved = resolveMandateGrant({ spend_usd: 99 }, home, project);
	assert.equal(resolved.spend_cap.usd, 99);
	assert.equal(resolved.provenance.spend_usd, "explicit");
	assert.equal(resolved.job_cap, 5);
	assert.equal(resolved.provenance.job_cap, "project");
	assert.equal(resolved.spend_cap.tokens, home.spend_tokens);
	assert.equal(resolved.provenance.spend_tokens, "home");
	assert.deepEqual(resolved.allowed_actions, home.allowed_actions);
	assert.equal(resolved.provenance.allowed_actions, "home");
});

test("resolveMandateGrant computes expiry from expiry_hours when no explicit expiry is given", () => {
	const now = new Date("2026-01-01T00:00:00Z");
	const resolved = resolveMandateGrant({}, SCAFFOLD_MANDATE_DEFAULTS, undefined, now);
	assert.equal(resolved.expiry, "2026-01-01T08:00:00Z");
	assert.equal(resolved.provenance.expiry_hours, "home");
});

test("resolveMandateGrant: an explicit expiry always wins, regardless of expiry_hours overrides", () => {
	const resolved = resolveMandateGrant(
		{ expiry: "2030-01-01T00:00:00Z" },
		SCAFFOLD_MANDATE_DEFAULTS,
		{ expiry_hours: 1 },
	);
	assert.equal(resolved.expiry, "2030-01-01T00:00:00Z");
	assert.equal(resolved.provenance.expiry_hours, "explicit");
});

// Acceptance: `cp_mandate issue --projects example-infra --objective "fix issue #17"`
// (no other fields) succeeds, and `cp_mandate show` displays every field with
// its source. This is the deterministic proof the ticket asks for: the main
// LLM, given "fix example-infra #17", needs no fields beyond project and
// objective to call the equivalent of `cp_parent send` once and ask nothing.
test("eval: 'fix example-infra #17' resolves into one complete mandate with no operator questions", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new MandateStore(home.path);
	const defaults = loadMandateDefaults(home.path); // no data/mandate-defaults.json yet: scaffold values
	const resolved = resolveMandateGrant({}, defaults, undefined, new Date());
	const mandate = store.issue({
		projects: ["example-infra"],
		objective: "fix issue #17",
		expiry: resolved.expiry,
		spend_cap: resolved.spend_cap,
		job_cap: resolved.job_cap,
		allowed_actions: resolved.allowed_actions,
		dispatch_parallelism: resolved.dispatch_parallelism,
		ask_on: resolved.ask_on,
		provenance: resolved.provenance,
	});
	assert.equal(mandate.projects[0], "example-infra");
	assert.equal(mandate.objective, "fix issue #17");
	// Every defaultable field's source is recorded, and every one is "home":
	// the human named nothing beyond project and objective.
	for (const field of Object.keys(resolved.provenance)) {
		assert.equal(mandate.provenance?.[field as keyof typeof resolved.provenance], "home");
	}
	const shown = store.show(mandate.id);
	assert.match(shown, /field sources:/);
	assert.match(shown, /expiry_hours:home/);
});

// Two projects whose overrides agree but were written (or loaded from JSON) with keys in a
// different order used to fall through to home, because the multi-project tier compared them with
// plain JSON.stringify (pi-command-post-autonomy-programme-cur.2.6, landing-review follow-up).
test("sameProjectMandateOverride: identical overrides agree regardless of key order", () => {
	const a: { spend_usd: number; job_cap: number; allowed_actions: ("implement" | "review")[] } = { spend_usd: 25, job_cap: 5, allowed_actions: ["implement", "review"] };
	const b = { allowed_actions: ["implement", "review"] as ("implement" | "review")[], job_cap: 5, spend_usd: 25 };
	assert.equal(sameProjectMandateOverride(a, b), true);
	assert.equal(sameProjectMandateOverride(a, { ...b, job_cap: 6 }), false);
	assert.equal(sameProjectMandateOverride(undefined, undefined), true);
	assert.equal(sameProjectMandateOverride(a, undefined), false);
});
