import { execFile } from "node:child_process";
import { EMPTY_USAGE, isoTimestamp, type FleetRecord, type JobHardBounds } from "./contracts.ts";
import { resolveJobHardBounds } from "./bounds.ts";
import { type DispatchRequest, DispatchError, cleanupCreatedJobBranch } from "./dispatch.ts";
import type { FleetStore } from "./fleet.ts";
import type { EnvelopeIntake } from "./intake.ts";
import { type Ledger, requireJobLabels } from "./ledger.ts";
import type { LeaseManager } from "./leases.ts";
import type { MandateStore } from "./mandate.ts";
import { scheduleRecord } from "./mandate-accounting.ts";
import { resolveRoutingInputs } from "./pipeline.ts";
import { riskField } from "./risk-warning.ts";
import { formatPreflight, type Preflight } from "./preflight.ts";
import type { RunRegistry } from "./runs.ts";
import { resolveScriptFile, runScript } from "./script-runner.ts";

export interface ScriptDispatchOptions {
	home: string;
	ledger: Ledger;
	fleet: FleetStore;
	preflight: Preflight;
	leases: LeaseManager;
	runs: RunRegistry;
	intake: EnvelopeIntake;
	/** Allows deterministic spawn-failure tests without changing the production /bin/sh command. */
	run?: typeof runScript;
	mandates?: MandateStore;
}

export interface ScriptPreview {
	preview: true;
	executor: "script";
	job_id: string;
	mandate_id?: string;
	project: string;
	kind: "ship";
	delivery: "local";
	script_path: string;
	wall_clock_seconds: number;
	blockers?: string[];
	mandate_gate?: string;
}

export interface ScriptDispatchResult {
	job_id: string;
	mandate_id?: string;
	executor: "script";
	script_path: string;
	worktree: string;
	branch: string;
	state: "dispatched";
	receipt: "accepted";
	pid: number;
}

export function assertScriptRequest(request: DispatchRequest): void {
	for (const key of ["task", "taskFile", "model", "profile", "thinking", "toolCallCap"] as const) {
		if (request[key] !== undefined) throw new DispatchError(`${request.jobId}: ${key} is not accepted for script jobs`);
	}
	if (request.wallClockSeconds !== undefined && (!Number.isInteger(request.wallClockSeconds) || request.wallClockSeconds < 1)) {
		throw new DispatchError(`${request.jobId}: wall clock cap must be positive`);
	}
}

function git(cwd: string, args: readonly string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile("git", [...args], { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			resolve({ status: typeof error?.code === "number" ? error.code : error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

export class ScriptDispatcher {
	readonly options: ScriptDispatchOptions;
	constructor(options: ScriptDispatchOptions) { this.options = options; }

	async preview(request: DispatchRequest): Promise<ScriptPreview> {
		const issue = await this.options.ledger.show(request.jobId);
		if (!issue.script) throw new DispatchError(`${issue.id}: no declared script`);
		if (issue.status !== "open") throw new DispatchError(`${issue.id} is ${issue.status}; script jobs cannot be replayed`);
		assertScriptRequest(request);
		const labels = requireJobLabels(issue);
		const text = [issue.title, issue.description ?? "", issue.script.path].join("\n");
		const inputs = resolveRoutingInputs({ text, ...(request.scope ? { scope: request.scope } : {}), ...riskField(request.risk, issue, "") });
		const job = { jobId: issue.id, project: labels.project, kind: "ship" as const, pathHints: [issue.script.path], script: true };
		const blockers = await this.options.ledger.blockersOf(issue.id);
		const selected = this.options.mandates?.selection("dispatch", job, this.options.fleet.read().jobs);
		return {
			preview: true,
			executor: "script",
			job_id: issue.id,
			...(selected ? { mandate_id: selected.grant.id } : {}),
			project: labels.project,
			kind: "ship",
			delivery: "local",
			script_path: issue.script.path,
			wall_clock_seconds: this.#bounds(request).wall_clock_seconds,
			...(blockers.length ? { blockers } : {}),
			...(this.options.mandates?.wouldAskRiskHigh(job, inputs.risk) ? { mandate_gate: "would ask: risk:high" } : {}),
		};
	}

	/** Override > data/worker-bounds.json > env > default; invalid home config refuses before any lease. */
	#bounds(request: DispatchRequest): JobHardBounds {
		try {
			return resolveJobHardBounds(request.wallClockSeconds ? { wall_clock_seconds: request.wallClockSeconds } : undefined, process.env, this.options.home);
		} catch (error) {
			throw new DispatchError(`${request.jobId}: ${(error as Error).message}`);
		}
	}

	async dispatch(request: DispatchRequest): Promise<ScriptDispatchResult> {
		const issue = await this.options.ledger.show(request.jobId);
		if (!issue.script) throw new DispatchError(`${issue.id}: no declared script`);
		assertScriptRequest(request);
		const { ledger, fleet, preflight, leases, runs, intake, mandates, home } = this.options;
		if (issue.status !== "open") throw new DispatchError(`${issue.id} is ${issue.status}; script jobs cannot be replayed`);
		const labels = requireJobLabels(issue);
		const blockers = await ledger.blockersOf(issue.id);
		if (blockers.length) throw new DispatchError(`${issue.id} is blocked by ${blockers.join(", ")}`);
		if (fleet.get(issue.id)) throw new DispatchError(`${issue.id} already has a fleet record; scripts cannot be replayed or promoted`);
		const scriptPath = issue.script.path;
		const text = [issue.title, issue.description ?? "", scriptPath].join("\n");
		const inputs = resolveRoutingInputs({ text, ...(request.scope ? { scope: request.scope } : {}), ...riskField(request.risk, issue, "") });
		const bounds = this.#bounds(request);
		const pre = await preflight.check({ jobId: issue.id, project: labels.project, ...(request.base ? { base: request.base } : {}), ...(request.fetch === false ? { fetch: false } : {}) });
		if (pre.status !== "ok" || !pre.clone || !pre.base) throw new DispatchError(`preflight refused ${issue.id}:\n${formatPreflight(pre)}`, pre);
		let mandateId: string | undefined;
		try {
			const permission = await mandates?.assertDispatchAllowed({ jobId: issue.id, project: labels.project, kind: "ship", pathHints: [scriptPath], risk: inputs.risk, evidence: inputs.reasons, script: true }, fleet.read().jobs);
			mandateId = permission?.selected?.id;
		} catch (error) {
			throw new DispatchError(error instanceof Error ? error.message : String(error));
		}
		const lease = await leases.acquire(pre.clone, { holder: issue.id, project: labels.project });
		let branchCreated = false;
		let claimed = false;
		let launched = false;
		let process: ReturnType<typeof runScript> | undefined;
		let releaseReady: (() => void) | undefined;
		try {
			const base = pre.base;
			const verify = await git(lease.path, ["rev-parse", "--verify", `origin/${base}`]);
			if (verify.status !== 0) throw new DispatchError(`origin/${base} missing in leased worktree`);
			const branch = await git(lease.path, ["switch", "--no-track", "-c", issue.id, `origin/${base}`]);
			if (branch.status !== 0) throw new DispatchError(`cannot create branch ${issue.id}: ${branch.stderr}`);
			branchCreated = true;
			const post = await preflight.check({ jobId: issue.id, project: labels.project, worktree: lease.path, base, fetch: false });
			if (post.status !== "ok" || post.findings.some((finding) => finding.level === "fail")) throw new DispatchError(`preflight refused leased worktree:\n${formatPreflight(post)}`, post);
			const file = await resolveScriptFile(lease.path, scriptPath);
			const wallClockSeconds = bounds.wall_clock_seconds;
			const claimedAt = isoTimestamp();
			await fleet.add({
				job_id: issue.id, project: labels.project, kind: "ship", delivery: "local", origin: "terminal", phase: "launching",
				executor: "script", script_path: scriptPath, worktree: lease.path,
				...(lease.lease_id ? { lease_id: lease.lease_id } : {}), ...scheduleRecord(issue.labels), branch: issue.id,
				dispatched_at: claimedAt, usage: EMPTY_USAGE, bounds,
			} as FleetRecord);
			claimed = true;
			await ledger.claim(issue.id, issue.id);
			// A close before the pid write waits for the fleet record to become a launched record.
			const ready = new Promise<void>((resolve) => { releaseReady = resolve; });
			const recorder = runs.open(issue.id);
			process = (this.options.run ?? runScript)({
				home, jobId: issue.id, worktree: lease.path, file, wallClockSeconds,
				onResult: async (result) => {
					await ready;
					const current = fleet.get(issue.id);
					if (!current) return;
					if (current.script_process) await fleet.patch(issue.id, { script_process: { ...current.script_process, exited_at: isoTimestamp(), exit_code: result.exit_code, signal: result.signal } });
					recorder.cp("process_exit", { code: result.exit_code, signal: result.signal });
					await intake.intake(issue.id);
				},
			});
			if (!process.child.pid) throw new DispatchError(`could not spawn /bin/sh for ${issue.id}`);
			launched = true;
			recorder.markSpawned({ pid: process.child.pid });
			await fleet.patch(issue.id, { phase: "waiting", script_process: { pid: process.child.pid, started_at: isoTimestamp() } });
			releaseReady?.();
			void process.closed.catch((error) => {
				try { recorder.cp("failure", { class: "spawn_failed", message: error instanceof Error ? error.message : String(error), at: isoTimestamp() }); }
				catch { /* The durable result remains available for restart intake. */ }
			});
			return { job_id: issue.id, ...(mandateId ? { mandate_id: mandateId } : {}), executor: "script", script_path: scriptPath, worktree: lease.path, branch: issue.id, state: "dispatched", receipt: "accepted", pid: process.child.pid };
		} catch (error) {
			releaseReady?.();
			if (process && !launched) try { await process.closed; } catch { /* Durable result remains for restart intake. */ }
			if (launched && process?.child.pid) {
				try { globalThis.process.kill(-process.child.pid, "SIGKILL"); } catch { /* Child group already exited. */ }
				try { await process.closed; } catch { /* The durable result, if written, remains available for inspection. */ }
				try { runs.open(issue.id).cp("failure", { class: "spawn_failed", message: `${issue.id}: pid registration failed (pid ${process.child.pid}, worktree ${lease.path}); ${String(error)}; lease retained`, at: isoTimestamp() }); } catch { /* Keep the original refusal. */ }
				throw error; // A launching record without a pid is an unknown exit at restart.
			}
			if (claimed || fleet.get(issue.id)) throw error; // The write-ahead claim owns the lease even if spawn failed.
			if (branchCreated) {
				try {
					const outcome = await cleanupCreatedJobBranch({ git, worktree: lease.path, branch: issue.id, base: pre.base });
					if (!outcome.deleted && outcome.note && error instanceof Error) error.message += `\n${outcome.note}`;
				} catch { /* Keep the original dispatch failure. */ }
			}
			runs.close(issue.id);
			await leases.release(lease, { ignoreErrors: true });
			throw error;
		}
	}
}
