import type { FleetRecord } from "./contracts.ts";
import type { IntegrateResult } from "./integrate.ts";
import { ciRunRef, formatRunRef } from "./ci-run-ref.ts";
import { ghRunListArgs, parseCiRuns, readCiForHead } from "./merge-ask.ts";
import type { CommandRunner } from "./merges.ts";

export interface HeldState {
	text: string;
	readable: boolean;
	probe: boolean;
	why: string;
}

export interface HeldFacts {
	facts: string[];
	prUrl?: string;
	headSha?: string;
	lead?: string;
}

type PrView = { ok: true; value: { state?: string; url?: string; headRefName?: string; headRefOid?: string } } | { ok: false; detail: string };
type Repair = { facts: string[]; prUrl: string; headSha: string; reason: string; message: string };

interface HeldPorts {
	view: (pr: string) => Promise<PrView>;
	run: CommandRunner;
	merged: () => { pr_url: string; head_sha: string; merge_commit_sha: string } | undefined;
	hold: () => HeldState | undefined;
	fleet: () => FleetRecord | undefined;
	promoting: () => boolean;
	blocked: (seen: HeldFacts & { prUrl: string; headSha: string }) => IntegrateResult | undefined;
	hazard: () => string | undefined;
	wait: (hold: HeldState, seen: HeldFacts) => IntegrateResult;
	surface: (seen: HeldFacts, reason: string) => IntegrateResult;
	message: (prUrl: string, reason: string) => string;
	resolve: (repair: Repair) => Promise<IntegrateResult>;
}

/** Only the held-entry CI repair exception. All integration actions remain behind the hold. */
export async function advanceHeld(input: { jobId: string; record: FleetRecord; cwd: string; pr: string; hold: HeldState }, ports: HeldPorts): Promise<IntegrateResult> {
	const { jobId, record, cwd, pr, hold } = input;
	let currentHold = hold;
	let seen: HeldFacts = { facts: [] };
	const wait = (why?: string) => ports.wait(currentHold, { ...seen, facts: [...seen.facts, ...(why ? [`no CI repair: ${why}`] : [])] });
	// Local reads only. Invoke after every await before starting any further work.
	const paused = (): IntegrateResult | undefined => {
		const fresh = ports.hold();
		if (!fresh) return wait("integration hold was released during the probe; a fresh advance is required");
		currentHold = fresh;
		if (!fresh.probe) return wait(fresh.why);
		return undefined;
	};
	const eligible = (prUrl: string, headSha: string): IntegrateResult | undefined => {
		let fresh: FleetRecord | undefined;
		try { fresh = ports.fleet(); } catch (error) { return wait(`fleet unreadable: ${(error as Error).message}`); }
		if (ports.promoting() || fresh?.phase === "waiting" || fresh?.phase === "launching") return wait(`worker phase ${fresh?.phase}; implementer already working${ports.promoting() ? "; promotion in flight" : ""}`);
		if (!fresh || fresh.phase !== "held" || !fresh.reported_at || fresh.failure) return wait(`worker is not an eligible reported held job (phase ${fresh?.phase ?? "missing"})`);
		if (fresh.kind !== "ship" || fresh.delivery !== "pr" || fresh.branch !== record.branch || fresh.worktree !== record.worktree || fresh.worker.session_id !== record.worker.session_id || fresh.worker.model !== record.worker.model || fresh.reported_at !== record.reported_at || fresh.supersessions !== record.supersessions) return wait("worker identity or report generation changed during the probe");
		if (!(fresh.receipts ?? []).some((receipt) => receipt.kind === "pr" && receipt.status.trim().toLowerCase() === "open")) return wait("no open PR receipt on the held job");
		return ports.blocked({ ...seen, prUrl, headSha });
	};
	if (!hold.probe) return ports.wait(hold, { facts: [`ci: not read — ${hold.why}`] });
	let failure: string | undefined;
	try {
		const receipt = ports.merged();
		if (receipt) return ports.wait(hold, { facts: [`merge receipt: ${receipt.pr_url} merged as ${receipt.merge_commit_sha.slice(0, 12)} (CI not read: already merged)`], prUrl: receipt.pr_url, headSha: receipt.head_sha });
		const view = await ports.view(pr);
		const stopped = paused();
		if (stopped) return stopped;
		if (!view.ok) return ports.wait(currentHold, { facts: [`gh: ${view.detail} — CI not read`] });
		const state = (view.value.state ?? "").toUpperCase();
		const prUrl = view.value.url ?? pr;
		const raw = (view.value.headRefOid ?? "").trim().toLowerCase();
		const head = /^[0-9a-f]{7,64}$/.test(raw) ? raw : undefined;
		seen = { facts: [`gh: ${prUrl} is ${state || "in an unknown state"}${head ? ` at ${head.slice(0, 12)}` : ""}`], prUrl, ...(head ? { headSha: head } : {}) };
		if (state !== "OPEN" || !head) return wait(`ci: not read — ${state !== "OPEN" ? `PR is ${state || "in an unknown state"}` : "no head"}`);
		const runs = await ports.run(cwd, "gh", ghRunListArgs(record.branch));
		const pausedAfterCi = paused();
		if (pausedAfterCi) return pausedAfterCi;
		if (runs.status !== 0) {
			seen.facts.push(`ci: unreadable — ${((runs.stderr || runs.stdout).trim().split("\n")[0] ?? "no output").slice(0, 300)}`);
			return wait();
		}
		const parsed = parseCiRuns(runs.stdout);
		const ci = readCiForHead({ branch: record.branch, headSha: head, runs: parsed });
		const ref = ci.ci === "failed" ? ciRunRef(parsed, head, prUrl) : {};
		seen.facts.push(`ci: ${ci.ci} — ${ci.reason}${formatRunRef(ref)}`);
		seen.lead = `CI ${ci.ci} on ${head.slice(0, 12)}${ref.run_id === undefined ? "" : ` (run ${ref.run_id})`}`;
		if (ci.ci !== "failed") return wait();
		if (view.value.headRefName !== record.branch) return wait(`PR branch ${view.value.headRefName ?? "unproven"} does not prove this job's branch ${record.branch}`);
		failure = ci.reason + formatRunRef(ref);
		const blocked = eligible(prUrl, head);
		if (blocked) return blocked;
		const hazard = ports.hazard();
		if (hazard) return ports.surface(seen, `${jobId}: integration held: ${currentHold.text.slice(0, 160)}; ${hazard}. Finish or abort the operation before CI repair.`);
		const confirmed = await ports.view(pr);
		const pausedAfterConfirm = paused();
		if (pausedAfterConfirm) return pausedAfterConfirm;
		if (!confirmed.ok) return wait(`confirming PR read failed: ${confirmed.detail}`);
		if (confirmed.value.state?.toUpperCase() !== "OPEN" || confirmed.value.headRefName !== record.branch || confirmed.value.headRefOid?.trim().toLowerCase() !== head) return wait("PR state, branch or head moved during the confirming read");
		const blockedNow = eligible(prUrl, head);
		if (blockedNow) return blockedNow;
		const hazardNow = ports.hazard();
		if (hazardNow) return ports.surface(seen, `${jobId}: integration held: ${currentHold.text.slice(0, 160)}; ${hazardNow}. Finish or abort the operation before CI repair.`);
	} catch (error) {
		seen.facts.push(`ci: not read — ${(error as Error).message}`);
		return wait();
	}
	// No await between the final local guards and the existing bounded resolver.
	const holdText = currentHold.text.slice(0, 160);
	return ports.resolve({ facts: [`integration held: ${holdText}; CI repair only`, ...seen.facts], prUrl: seen.prUrl!, headSha: seen.headSha!, reason: `${jobId}: integration held: ${holdText}; ${failure}. No merge or merge authorization.`, message: `${ports.message(seen.prUrl!, failure!)}\n\nBounded CI repair is allowed; the integration hold remains active: ${holdText}.` });
}
