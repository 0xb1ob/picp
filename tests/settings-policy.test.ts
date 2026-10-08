/**
 * cp-7re9 (Settings PR3): the file-only grant policy in data/mandate-defaults.json —
 * `scope_policy` and `deny_projects` — read per call by a lenient loader, enforced at
 * `MandateStore.issue`, never settable by the parent, and kept by every Settings owner read.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { isoTimestamp, LAYOUT } from "../src/contracts.ts";
import { requireOperatorQuote } from "../src/decide.ts";
import { evaluateAuthority, MandateStore } from "../src/mandate.ts";
import { loadMandatePolicy, MandateDefaultsError, SCAFFOLD_MANDATE_DEFAULTS, setMandateDefault } from "../src/mandate-defaults.ts";
import { preapprovalRecord } from "../src/risk-preapproval.ts";
import { readSettings } from "../src/settings.ts";
import { createScratchHome } from "./harness/index.ts";

const later = (ms = 86_400_000) => isoTimestamp(new Date(Date.now() + ms));
const grantInput = { projects: ["demo"], objective: "ship it", expiry: later(), spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 10 };

function scratch(t: TestContext): { home: string; file: string; write: (body: unknown) => void } {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	const file = join(home.path, LAYOUT.mandateDefaultsFile);
	return { home: home.path, file, write: (body) => writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body)) };
}

test("loadMandatePolicy: absent, valid, invalid key, bad JSON, and an unrelated invalid default ignored", (t) => {
	const { home, file, write } = scratch(t);
	assert.deepEqual(loadMandatePolicy(home), { scope_policy: "project_wide_allowed", deny_projects: [] }, "no file: today's behaviour");
	write({ ...SCAFFOLD_MANDATE_DEFAULTS, scope_policy: "named_jobs_only", deny_projects: ["demo"] });
	assert.deepEqual(loadMandatePolicy(home), { scope_policy: "named_jobs_only", deny_projects: ["demo"] });
	write({ scope_policy: "everyone" });
	assert.throws(() => loadMandatePolicy(home), (error: Error) => error instanceof MandateDefaultsError && error.message.includes(file) && /scope_policy/.test(error.message));
	write("{ nope");
	assert.throws(() => loadMandatePolicy(home), (error: Error) => error.message.includes(file) && /is not valid JSON \(/.test(error.message));
	write({ job_cap: 0, deny_projects: ["demo"] });
	assert.deepEqual(loadMandatePolicy(home).deny_projects, ["demo"], "lenient: only the policy keys are validated");
});

test("issue under named_jobs_only: project-wide refused writing nothing; named, schedule seed and named pre-approval pass; prior grants keep standing", (t) => {
	const { home, write } = scratch(t);
	const store = new MandateStore(home);
	const wide = store.issue(grantInput);
	write({ ...SCAFFOLD_MANDATE_DEFAULTS, scope_policy: "named_jobs_only" });
	const before = store.list().length;
	assert.throws(() => store.issue(grantInput), /scope_policy=named_jobs_only requires explicit job_ids/);
	assert.equal(store.list().length, before, "nothing written");
	assert.ok(store.issue({ ...grantInput, job_ids: ["cp-a"] }).id);
	assert.ok(store.issue({ ...grantInput, schedule_grant: true }).id);
	const quote = "Pre-approve risk high for cp-a.";
	const preapproval = preapprovalRecord(requireOperatorQuote(quote, { operatorTexts: [quote] }), ["cp-a"], isoTimestamp());
	assert.ok(store.issue({ ...grantInput, job_ids: ["cp-a"], risk_preapproval: preapproval }).risk_preapproval);
	// The existing project-wide grant is never revoked or re-checked: it still permits dispatch.
	const verdict = evaluateAuthority({ kind: "ship", jobId: "cp-b", project: "demo", jobKind: "ship" }, [store.require(wide.id)]);
	assert.equal(verdict.permitted, true);
});

test("deny_projects refuses issue; the parent cannot set either key; defaults_set keeps both", (t) => {
	const { home, write } = scratch(t);
	const store = new MandateStore(home);
	write({ ...SCAFFOLD_MANDATE_DEFAULTS, scope_policy: "named_jobs_only", deny_projects: ["demo"] });
	assert.throws(() => store.issue({ ...grantInput, job_ids: ["cp-a"] }), /settings: project demo is denied/);
	assert.throws(() => setMandateDefault(home, "scope_policy", "project_wide_allowed"), /unknown mandate default/);
	assert.throws(() => setMandateDefault(home, "deny_projects", ""), /unknown mandate default/);
	const next = setMandateDefault(home, "job_cap", "7");
	assert.equal(next.job_cap, 7);
	assert.deepEqual(loadMandatePolicy(home), { scope_policy: "named_jobs_only", deny_projects: ["demo"] }, "defaults_set keeps both policy keys");
});

test("readSettings: owners holding all four policy keys are valid", (t) => {
	const { home, write } = scratch(t);
	write({ ...SCAFFOLD_MANDATE_DEFAULTS, scope_policy: "named_jobs_only", deny_projects: ["demo"] });
	writeFileSync(join(home, LAYOUT.workerBoundsFile), JSON.stringify({ wall_clock_seconds: 1800, allow_dispatch_override: false }));
	writeFileSync(join(home, LAYOUT.routingFile), JSON.stringify({ schema_version: 1, allow: ["mock/*"], deny_by_role: { planner: ["mock/denied*"] }, rubric: [] }));
	const states = Object.fromEntries(readSettings(home, {}).owners.map((owner) => [owner.owner, owner.state]));
	assert.deepEqual([states["mandate-defaults"], states["worker-bounds"], states.routing], ["valid", "valid", "valid"]);
	assert.ok(!Object.values(states).includes("invalid"), JSON.stringify(states));
});
