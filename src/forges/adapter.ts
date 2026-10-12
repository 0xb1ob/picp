/**
 * The read-only forge observation boundary (forge PR 1).
 *
 * One question, asked of whichever forge hosts a project: "what does the forge
 * say about this change request?" The answer is a normalized observation or a
 * named failure — never an empty success, and never a merge, CI or write
 * operation (those are out of scope for v1 and have no method here).
 */

import type { ForgeKind, ForgeResolution } from "../forge-url.ts";
import type { CommandRunner } from "../merges.ts";
import { githubObserver } from "./github.ts";
import { type GitlabTransport, gitlabObserver } from "./gitlab.ts";

export type ChangeRequestState = "open" | "closed" | "merged" | "unknown";

/** What the forge reported. SHAs are as observed; a consumer decides what they prove. */
export interface ChangeRequestObservation {
	provider: ForgeKind;
	/** Canonical web url of the PR/MR. */
	url: string;
	/** GitHub PR number, or the GitLab project-local MR IID. */
	number: number;
	state: ChangeRequestState;
	source_branch?: string;
	target_branch?: string;
	head_sha?: string;
	merged_at?: string;
	merge_commit_sha?: string;
	squash_commit_sha?: string;
}

/**
 * unsupported: v1 cannot observe this (unknown host, fork MR).
 * mismatch: the request or the answer names another repository or change request.
 * unavailable: the forge could not be asked (network, timeout, auth, HTTP status, redirect, gh failure).
 * invalid: the forge answered something that is not a usable observation.
 */
export type ObservationFailure = "unsupported" | "mismatch" | "unavailable" | "invalid";

export type ObservationOutcome =
	| { ok: true; observation: ChangeRequestObservation }
	| { ok: false; reason: ObservationFailure; detail: string };

export interface ForgeObserver {
	readonly provider: ForgeKind | "none";
	/** `ref` is a PR/MR url or its number/IID. */
	readChangeRequest(ref: string): Promise<ObservationOutcome>;
}

export interface ObserverPorts {
	/** Runs `gh` for GitHub; the same injected runner MergeStore uses. */
	run: CommandRunner;
	/** Where `gh` runs: the job worktree or the project clone. */
	cwd: string;
	gitlab?: GitlabTransport;
}

/** The observer for a resolved repository; an unresolved one answers every read with its named failure. */
export function observerFor(resolution: ForgeResolution, ports: ObserverPorts): ForgeObserver {
	if (!resolution.ok) {
		const failure: ObservationOutcome = { ok: false, reason: resolution.reason, detail: resolution.detail };
		return { provider: "none", readChangeRequest: async () => failure };
	}
	return resolution.repository.kind === "github"
		? githubObserver(ports.run, ports.cwd)
		: gitlabObserver(resolution.repository, ports.gitlab);
}
