import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { Doctor, execRunner, formatDoctor } from "../src/doctor.ts";
import { FleetStore } from "../src/fleet.ts";
import { EscalationStore } from "../src/escalation.ts";
import { MandateStore } from "../src/mandate.ts";
import { cpNext, formatNext } from "../src/next.ts";
import { createScratchLedger } from "./harness/ledger.ts";
import { advanceBase, createScratchRepo } from "./harness/scratch-repo.ts";

function fixture(t: { after(fn: () => void): void }) {
	const repo = createScratchRepo({ files: { ".gitignore": "data/\nstate/\n.pi-command-post/\n", "README.md": "home\n" } });
	t.after(() => repo.cleanup());
	const fleet = new FleetStore({ home: repo.path });
	const ports = {
		packageRoot: repo.path,
		fleet,
		ledger: createScratchLedger({ home: repo.path }).ledger,
		mandates: new MandateStore(repo.path),
		escalations: new EscalationStore({ home: repo.path }),
	};
	const doctor = () => new Doctor({ home: repo.path, packageRoot: repo.path, fleet, run: execRunner, which: () => [], env: {} }).run();
	return { repo, ports, doctor };
}

test("doctor and cp_next warn about a clean home behind main without changing it", async (t) => {
	const { repo, ports, doctor } = fixture(t);
	const original = repo.head();
	advanceBase(repo, "one.txt", "one\n");
	advanceBase(repo, "two.txt", "two\n");
	repo.git("fetch", "--quiet", "origin");
	const remote = repo.head("origin/main");
	const report = await doctor();
	const finding = report.findings.find((entry) => entry.check === "home.checkout");
	assert.equal(finding?.severity, "warn");
	assert.match(formatDoctor(report), /home is 2 commits behind origin\/main/);
	assert.match(finding?.fix ?? "", /git merge --ff-only origin\/main.*restart the parent at a quiet point/);
	const next = await cpNext(ports);
	assert.equal(next.action.kind, "no_mandate", "the warning never changes the recommendation");
	assert.match(formatNext(next), /home is 2 commits behind origin\/main: git merge --ff-only origin\/main, then restart the parent at a quiet point/);
	assert.equal(repo.head(), original, "no auto-merge");
	assert.equal(repo.head("origin/main"), remote);
	assert.equal(repo.isClean(), true);

	const job = await ports.ledger.create({ title: "next task", project: "demo", delivery: "pr", kind: "ship" });
	ports.mandates.issue({ projects: ["demo"], objective: "ship next task", expiry: new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z"), spend_cap: { usd: 10, tokens: 1_000_000 }, job_cap: 1 });
	const active = await cpNext(ports);
	assert.equal(active.action.kind, "dispatch");
	assert.equal(active.action.job_id, job.id);
	assert.match(formatNext(active), /home is 2 commits behind/);

	mkdirSync(join(repo.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(repo.path, LAYOUT.data, "update.json"), JSON.stringify({ enabled: true, interval_min: 15 }));
	const auto = (await doctor()).findings.find((entry) => entry.check === "home.checkout");
	assert.match(auto?.fix ?? "", /^auto-update is on \(data\/update\.json\): cp-update\.timer applies it once the fleet is idle.*by hand: git merge --ff-only origin\/main/);
	assert.equal(repo.isClean(), true, "the config lives in the ignored runtime root");

	repo.git("merge", "--ff-only", "origin/main");
	assert.doesNotMatch(formatNext(await cpNext(ports)), /home is \d+ commits behind/);
	assert.doesNotMatch(formatDoctor(await doctor()), /home is \d+ commits behind/);
});

for (const state of ["current", "ahead", "diverged", "dirty", "staged", "untracked", "missing-main", "separate-home", "unfetched"] as const) {
	test(`home lag advice is absent for ${state}`, async (t) => {
		const { repo, ports, doctor } = fixture(t);
		if (["diverged", "dirty", "staged", "untracked", "separate-home", "unfetched"].includes(state)) {
			advanceBase(repo, "remote.txt", "remote\n");
			if (state !== "unfetched") repo.git("fetch", "--quiet", "origin");
		}
		if (state === "ahead" || state === "diverged") {
			repo.write("local.txt", "local\n");
			repo.commitAll("local change");
		}
		if (state === "dirty" || state === "staged") {
			repo.write("README.md", "dirty\n");
			if (state === "staged") repo.git("add", "README.md");
		}
		if (state === "untracked") repo.write("untracked.txt", "untracked\n");
		if (state === "missing-main") repo.git("update-ref", "-d", "refs/remotes/origin/main");
		if (state === "separate-home") ports.packageRoot = repo.remote!;
		const report = state === "separate-home"
			? await new Doctor({ home: repo.path, packageRoot: ports.packageRoot, fleet: ports.fleet, run: execRunner, which: () => [], env: {} }).run()
			: await doctor();
		assert.doesNotMatch(formatDoctor(report), /home is \d+ commits behind/);
		assert.doesNotMatch(formatNext(await cpNext(ports)), /home is \d+ commits behind/);
		if (state === "missing-main") assert.match(formatNext(await cpNext(ports)), /comparison with origin\/main unavailable/);
	});
}
