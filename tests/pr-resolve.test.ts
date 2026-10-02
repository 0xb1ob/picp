/**
 * pi-command-post-fbn: intake resolves a `delivery:pr` envelope's `pr_url` from the
 * project's origin remote and gh — a worker's typo must never become the url the CI
 * watch, `cp_integrate` and `cp_merged` all key on.
 *
 * The live defect, verbatim: a worker reported `https://github.com/0xb1b0/...` for
 * `0xb1ob`, intake stored it, and PR #338 sat green and unmerged for 27 minutes while the
 * watch asked GitHub about a repo that does not exist. Every case below is one branch of
 * the resolution: corrected, refused (no PR), refused (owner mismatch with gh down), and
 * marked unverified — plus the watch's own read, keyed on whatever intake stored.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CiWatch, parsePrUrl, prReceiptOf } from "../src/ci-watch.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, paths, SCHEMA_VERSION } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import { EnvelopeIntake, formatIntake, type IntakeResult } from "../src/intake.ts";
import type { CommandRunner } from "../src/merge-ask.ts";
import { RunRegistry } from "../src/runs.ts";
import { createScratchHome, readFleet, readRunEvents, type ScratchHome } from "./harness/index.ts";

const ORIGIN_REMOTE = "https://github.com/0xb1ob/pi-command-post.git";
const OWNER_REPO = "0xb1ob/pi-command-post";
const BRANCH = "cp-typo";
const CANONICAL = "https://github.com/0xb1ob/pi-command-post/pull/338";
/** The live defect verbatim: owner `0xb1b0` for `0xb1ob`. */
const TYPO = "https://github.com/0xb1b0/pi-command-post/pull/338";
const HEAD = "9f1c2e3a4b5c6d7e8f90a1b2c3d4e5f60718293a";

interface Bench {
	home: ScratchHome;
	fleet: FleetStore;
	intake: EnvelopeIntake;
	reported: IntakeResult[];
	/** Every command the resolver issued, so the query itself is assertable. */
	calls: string[][];
}

function benchOf(t: { after(fn: () => void | Promise<void>): void }, gh: CommandRunner): Bench {
	const home = createScratchHome();
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	const reported: IntakeResult[] = [];
	const calls: string[][] = [];
	const intake = new EnvelopeIntake({
		home: home.path,
		fleet,
		runs,
		// The production wiring: the project's registered origin remote, and gh.
		originUrl: () => ORIGIN_REMOTE,
		prExec: (command, args, options) => {
			calls.push([command, ...args]);
			return gh(command, args, options);
		},
		fail: (jobId, failure) => fleet.markFailed(jobId, failure),
		onReported: (result) => reported.push(result),
	});
	t.after(() => home.cleanup());
	return { home, fleet, intake, reported, calls };
}

async function addJob(b: Bench, jobId: string): Promise<void> {
	await b.fleet.add({
		job_id: jobId,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worker: {
			pid: process.pid,
			session_id: "s",
			session_file: join(b.home.path, "s.jsonl"),
			profile: "implementer",
			role: "implementer",
			model: "mock/model",
			started_at: isoTimestamp(),
		},
		worktree: join(b.home.path, "wt"),
		branch: jobId,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
	});
}

function writeEnvelopeFile(home: string, jobId: string, envelope: Record<string, unknown>): void {
	mkdirSync(join(home, paths.runDir(jobId)), { recursive: true });
	writeFileSync(
		join(home, paths.envelopeFile(jobId)),
		`${JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: jobId, received_at: isoTimestamp(), attempt: 1, envelope }, null, 2)}\n`,
	);
}

/** A ship/pr envelope that reports `pr_url` and nothing else remarkable. */
function writeShipEnvelope(home: string, jobId: string, prUrl: string): void {
	writeEnvelopeFile(home, jobId, {
		job_id: jobId,
		kind: "ship",
		status: "done",
		summary: "Pushed and reported.",
		branch: jobId,
		pr_url: prUrl,
		head_sha: HEAD,
	});
}

/** `gh pr list --head <branch> --state all --json url,number,headRefOid` answering with one PR. */
function ghAnswering(url: string): CommandRunner {
	return async () => JSON.stringify([{ url, number: 338, headRefOid: HEAD }]);
}

const GH_DOWN: CommandRunner = async () => {
	throw new Error("gh: command not found");
};

test("a typo'd owner is corrected to the PR gh reports, and the correction line is named (pi-command-post-fbn)", async (t) => {
	const b = benchOf(t, ghAnswering(CANONICAL));
	await addJob(b, BRANCH);
	writeShipEnvelope(b.home.path, BRANCH, TYPO);

	const result = await b.intake.intake(BRANCH);
	assert.equal(result.accepted, true);
	assert.equal(result.next, "hold");
	assert.equal(
		result.receipts?.find((receipt) => receipt.kind === "pr")?.url,
		CANONICAL,
		"the stored receipt is what gh says, not the worker's typo",
	);
	assert.equal(result.pr_url_note, `pr_url corrected: ${TYPO} -> ${CANONICAL}`, "the correction is named, never silent");
	assert.match(formatIntake(result), /pr_url corrected: https:\/\/github\.com\/0xb1b0\/[^\s]* -> https:\/\/github\.com\/0xb1ob\/[^\s]*\/338/);

	const call = b.calls[0] ?? [];
	assert.deepEqual(call.slice(0, 6), ["gh", "pr", "list", "--head", BRANCH, "--state"]);
	assert.ok(call.includes("--repo") && call.includes(OWNER_REPO), "the query is aimed at the project's origin repo");

	const journaled = readRunEvents(b.home.path, BRANCH).filter((event) => event.type === "pr_url_corrected");
	assert.equal(journaled.length, 1, "the correction is a fact in the run log, not only in the wake text");
	assert.equal((journaled[0]?.payload as { line?: string }).line, result.pr_url_note);
});

test("no PR on the job branch refuses the envelope, naming the branch and the expected owner/repo (pi-command-post-fbn)", async (t) => {
	const b = benchOf(t, async () => "[]");
	await addJob(b, BRANCH);
	writeShipEnvelope(b.home.path, BRANCH, TYPO);

	const result = await b.intake.intake(BRANCH);
	assert.equal(result.accepted, false);
	assert.equal(result.failure, undefined, "a correctable refusal is not a job failure");
	assert.match(result.correction?.reason ?? "", new RegExp(`no PR is on branch "${BRANCH}"`));
	assert.match(result.correction?.reason ?? "", /0xb1ob\/pi-command-post/);
	assert.equal(readFleet(b.home.path).jobs[0]?.phase, "waiting", "the report slot stays open for a corrected report");
});

test("gh unavailable plus an owner mismatch refuses, with the correct owner/repo named (pi-command-post-fbn)", async (t) => {
	const b = benchOf(t, GH_DOWN);
	await addJob(b, BRANCH);
	writeShipEnvelope(b.home.path, BRANCH, TYPO);

	const result = await b.intake.intake(BRANCH);
	assert.equal(result.accepted, false);
	const reason = result.correction?.reason ?? "";
	assert.match(reason, /0xb1b0\/pi-command-post/, "the refusal quotes the url the worker gave");
	assert.match(reason, /0xb1ob\/pi-command-post/, "and names the correct owner/repo");
	assert.equal(readFleet(b.home.path).jobs[0]?.reported_at, undefined, "nothing was stamped for a refused envelope");
});

test("gh unavailable with a matching owner/repo is marked unverified, never silently passed (pi-command-post-fbn)", async (t) => {
	const b = benchOf(t, GH_DOWN);
	await addJob(b, BRANCH);
	writeShipEnvelope(b.home.path, BRANCH, CANONICAL);

	const result = await b.intake.intake(BRANCH);
	assert.equal(result.accepted, true);
	assert.equal(result.receipts?.find((receipt) => receipt.kind === "pr")?.url, CANONICAL);
	assert.match(result.pr_url_note ?? "", /^pr_url unverified: /);
	assert.match(formatIntake(result), /pr_url unverified/);
	assert.equal(readRunEvents(b.home.path, BRANCH).filter((event) => event.type === "pr_url_unverified").length, 1);
});

test("the CI watch reads the corrected url, not the worker's typo (pi-command-post-fbn)", async (t) => {
	const b = benchOf(t, ghAnswering(CANONICAL));
	await addJob(b, BRANCH);
	writeShipEnvelope(b.home.path, BRANCH, TYPO);
	const result = await b.intake.intake(BRANCH);
	assert.equal(result.accepted, true);

	const record = readFleet(b.home.path).jobs[0] as FleetRecord;
	assert.equal(prReceiptOf(record)?.url, CANONICAL, "the watch's own source is the stored receipt");
	const seen: string[] = [];
	const watch = new CiWatch({
		home: b.home.path,
		jobs: () => [record],
		pr: async (_job, url) => {
			seen.push(url);
			return { merged: false, state: "open", head_sha: HEAD };
		},
		runs: async () => [],
		now: () => new Date(),
	});
	await watch.tick();
	assert.deepEqual(seen, [CANONICAL], "the watch's one REST read is keyed on the corrected url");
	assert.equal(parsePrUrl(seen[0] as string)?.owner, "0xb1ob");
});
