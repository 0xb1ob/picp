/**
 * picp's native worker guard chain, shared by the Claude and Codex drivers. It loads no Agent SDK and no `zod`, so the
 * Codex driver can import it (tests/structure.test.ts pins that closure).
 */
import { homedir, userInfo } from "node:os";
import { ciStatusQuery, ciStatusRepeatRefusal, ciWaitRefusal, detectCiWait, shellPatchCommand, shellPatchRefusal } from "../ci-wait.ts";
import { type Delivery, type JobKind, type Role, WORKER_FORBIDDEN_TOOLS } from "../contracts.ts";
import {
	credentialSearchRefusal,
	detectCredentialSearch,
	detectGhAuthStatus,
	detectHomeBulkCopy,
	detectHostAuthCopy,
	ghAuthStatusRefusal,
	homeBulkCopyRefusal,
	hostAuthCopyRefusal,
} from "../worker-credential-guard.ts";
import { detectWorkerHistoryRewrite, workerHistoryRefusal } from "../worker-history-guard.ts";
import { workerHostGuard } from "../worker-host-guard.ts";
import { detectWorkerMerge, workerMergeRefusal } from "../worker-merge-guard.ts";
import { WEB_TOOLS, webEgressRefusal } from "../web-egress.ts";
import { secretPathIn, secretPaths } from "./claude-bash-policy.ts";
import { bashScope, nativeBashRefusal } from "./claude-bash-scope.ts";
import { nativeRole, reviewerReadGuard, writeScopeGuard } from "./claude-roles.ts";

export interface SpikeJob {
	job_id: string;
	kind: JobKind;
	role: Role;
	delivery: Delivery;
	runDir: string;
	worktree: string;
	/** Research: the predeclared artifact, whose directory is its only Write scope. Implementer: its own
	 * `state/artifacts/<job id>/report.md`, whose directory is the one Write scope beside its worktree. */
	artifactPath?: string;
	/** Implementer only: grant and home `exclude_paths` no Edit/Write may touch, read by the worker process. */
	excludePaths?: readonly string[];
	/** The run's scratch TMPDIR (the child's `TMPDIR`), one of its Bash write roots; set by the run itself. */
	tmp?: string;
}

/** A Claude tool call in picp's worker-guard vocabulary (`bash` {command}, `read`/`write` {path}, …). */
export interface NormalizedCall {
	name: string;
	input: Record<string, unknown>;
}

export type SpikeGuard = (call: NormalizedCall) => string | undefined;

/**
 * picp's worker-reporter `tool_call` refusals, in the same order, plus the role's Bash and write scope and secret
 * paths. `web`: the run offers the CLI's web tools, which pass `webEgressRefusal`; without it they are refused.
 */
export function spikeGuards(
	job: SpikeJob,
	secrets: readonly string[] = secretPaths(null, [homedir(), userInfo().homedir]),
	role: Role = job.role,
	web = false,
): SpikeGuard[] {
	const native = nativeRole(role);
	const writeScope = writeScopeGuard(job, secrets, native);
	const scope = native === "reviewer" ? undefined : bashScope(job, secrets, native, homedir());
	let ciStatusQueries = 0;
	const bash: SpikeGuard = (call) => {
		if (call.name !== "bash") return undefined;
		if (scope === undefined) return "Refused: a reviewer has no Bash; it reads its scratch dir with Read, Grep and Glob.";
		const command = call.input.command;
		if (typeof command !== "string") return "Refused: bash needs a string command.";
		const ci = detectCiWait(command);
		if (ci) return ciWaitRefusal(ci);
		const merge = detectWorkerMerge(command);
		if (merge) return workerMergeRefusal(merge);
		const rewrite = detectWorkerHistoryRewrite(command);
		if (rewrite) return workerHistoryRefusal(rewrite);
		const authCopy = detectHostAuthCopy(command);
		if (authCopy) return hostAuthCopyRefusal(authCopy);
		const homeCopy = detectHomeBulkCopy(command);
		if (homeCopy) return homeBulkCopyRefusal(homeCopy);
		const ghAuth = detectGhAuthStatus(command);
		if (ghAuth) return ghAuthStatusRefusal(ghAuth);
		const keySearch = detectCredentialSearch(command);
		if (keySearch) return credentialSearchRefusal(keySearch);
		if (shellPatchCommand(command)) return shellPatchRefusal();
		if (ciStatusQuery(command) && ciStatusQueries++ >= 1) return ciStatusRepeatRefusal();
		return nativeBashRefusal(command, scope);
	};
	return [
		(call) => (WORKER_FORBIDDEN_TOOLS.includes(call.name) ? `${call.name} is a parent-only tool.` : undefined),
		bash,
		(call) => {
			if (!WEB_TOOLS.includes(call.name)) return undefined;
			return web ? webEgressRefusal(call.name, call.input) : `Refused: a native ${native} has no web tools; only the planner role does.`;
		},
		writeScope,
		...(native === "reviewer" ? [reviewerReadGuard(job)] : []),
		(call) => {
			const paths = call.name === "find" ? [call.input.path, call.input.pattern] : call.name === "read" || call.name === "grep" ? [call.input.path] : [];
			const secret = paths.find((path) => typeof path === "string" && secretPathIn(path, job.worktree, secrets));
			const who = { research: "a research worker", implementer: "an implementer", reviewer: "a reviewer" }[native];
			return secret === undefined ? undefined : `Refused: ${who} never reads the Claude settings, its config, /proc or /dev/fd (${String(secret)}).`;
		},
		(call) => workerHostGuard(call.name, call.input, job.runDir),
	];
}
