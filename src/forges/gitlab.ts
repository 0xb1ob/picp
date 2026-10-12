/**
 * GitLab merge-request observation over REST (forge PR 1).
 *
 * One bounded GET of `/projects/:id/merge_requests/:iid` with native fetch:
 * the project path URL-encoded as one parameter (nested groups intact), the
 * token from an environment variable named by the project and sent only in the
 * `PRIVATE-TOKEN` header, `redirect: manual` (a credential is never forwarded
 * to a redirect target), an abort timeout and a response size cap. Failures
 * name the provider, the host, the HTTP status and a static cause — never a
 * response body, a header, a fetch exception's message or a token.
 *
 * A url for another host or project is refused before any request is made.
 * Fork (cross-project) MRs are unsupported in v1, as bound PRs already are.
 */

import { changeRequestBelongsTo, changeRequestUrl, type ForgeRepository, parseChangeRequestUrl } from "../forge-url.ts";
import type { ChangeRequestObservation, ChangeRequestState, ForgeObserver, ObservationFailure, ObservationOutcome } from "./adapter.ts";

export const GITLAB_TIMEOUT_MS = 10_000;
export const GITLAB_MAX_BYTES = 1024 * 1024;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GitlabTransport {
	/** Injected in tests; defaults to the platform fetch. */
	fetch?: FetchLike;
	/** Where `token_env` is looked up; defaults to process.env. */
	env?: Readonly<Record<string, string | undefined>>;
	timeoutMs?: number;
	maxBytes?: number;
}

const STATES: Readonly<Record<string, ChangeRequestState>> = { opened: "open", closed: "closed", merged: "merged" };
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const IID = /^[1-9][0-9]{0,9}$/;
const HTTP_CAUSES: Readonly<Record<number, string>> = {
	401: "authentication required or refused",
	403: "access forbidden for this token",
	404: "merge request not found or not visible to this token",
	429: "rate limited",
};

export function gitlabObserver(repository: ForgeRepository, transport: GitlabTransport = {}): ForgeObserver {
	const api = repository.api_base_url ?? `${repository.web_base_url}/api/v4`;
	// Sanitized host for messages; a regex, because an unparseable root must not throw from a constructor.
	const host = /^https:\/\/([^/]+)/i.exec(api)?.[1]?.toLowerCase() ?? "(unparseable api root)";
	const fail = (reason: ObservationFailure, cause: string): ObservationOutcome => ({ ok: false, reason, detail: `gitlab ${host}: ${cause}` });
	return {
		provider: "gitlab",
		async readChangeRequest(ref) {
			const iid = requestedIid(ref.trim(), repository);
			if (typeof iid === "string") return fail("mismatch", iid);
			const token = repository.token_env ? (transport.env ?? process.env)[repository.token_env] : undefined;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), transport.timeoutMs ?? GITLAB_TIMEOUT_MS);
			try {
				let response: Response;
				try {
					response = await (transport.fetch ?? fetch)(`${api}/projects/${encodeURIComponent(repository.path)}/merge_requests/${iid}`, {
						method: "GET",
						redirect: "manual",
						signal: controller.signal,
						headers: { accept: "application/json", ...(token ? { "PRIVATE-TOKEN": token } : {}) },
					});
				} catch {
					// The exception's own message is never relayed: it may echo request details.
					return fail("unavailable", controller.signal.aborted ? "request timed out" : "request failed (network or TLS)");
				}
				if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
					return fail("unavailable", `HTTP ${response.status} redirect refused; set the project's forge api_base_url to the final API root`);
				}
				if (!response.ok) {
					const unauthenticated = response.status === 401 && !token ? ` (no token: ${repository.token_env ? `${repository.token_env} is unset` : "set forge.token_env"})` : "";
					return fail("unavailable", `HTTP ${response.status} (${HTTP_CAUSES[response.status] ?? "request refused"})${unauthenticated}`);
				}
				const body = await readBounded(response, transport.maxBytes ?? GITLAB_MAX_BYTES);
				if (body === "too_large") return fail("invalid", "response exceeds the size limit");
				if (body === undefined) return fail("unavailable", controller.signal.aborted ? "request timed out" : "response body could not be read");
				let raw: unknown;
				try {
					raw = JSON.parse(body);
				} catch {
					return fail("invalid", "response is not JSON");
				}
				const mapped = toObservation(raw, iid, repository);
				return "reason" in mapped ? fail(mapped.reason, mapped.cause) : { ok: true, observation: mapped };
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

/** The IID a ref asks for, or why it is refused (before any request). */
function requestedIid(ref: string, repository: ForgeRepository): number | string {
	if (IID.test(ref)) return Number(ref);
	const parsed = parseChangeRequestUrl(ref);
	if (!parsed) return "not a merge request url or IID";
	if (!changeRequestBelongsTo(parsed, repository)) return "the url names another host or project, so it was not requested";
	return parsed.number;
}

async function readBounded(response: Response, maxBytes: number): Promise<string | "too_large" | undefined> {
	const declared = Number(response.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel().catch(() => undefined);
		return "too_large";
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel().catch(() => undefined);
				return "too_large";
			}
			chunks.push(value);
		}
	} catch {
		return undefined;
	}
	return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A valid sha, undefined for absent/null, false for anything else. */
function optionalSha(value: unknown): string | undefined | false {
	if (value === undefined || value === null || value === "") return undefined;
	return typeof value === "string" && SHA.test(value) ? value : false;
}

type Refusal = { reason: ObservationFailure; cause: string };
const refuse = (reason: ObservationFailure, cause: string): Refusal => ({ reason, cause });

/** The normalized observation, or a refusal with a static cause. Field values are never echoed. */
function toObservation(raw: unknown, iid: number, repository: ForgeRepository): ChangeRequestObservation | Refusal {
	if (!isRecord(raw)) return refuse("invalid", "response is not an object");
	if (raw.iid !== iid) return refuse("mismatch", "response names another merge request");
	const web = typeof raw.web_url === "string" ? parseChangeRequestUrl(raw.web_url) : undefined;
	if (!web || web.number !== iid || !changeRequestBelongsTo(web, repository)) return refuse("mismatch", "response web_url is not this project's merge request");
	if (typeof raw.source_project_id !== "number" || raw.source_project_id !== raw.target_project_id) {
		return refuse("unsupported", "fork (cross-project) merge requests are not supported in v1");
	}
	const source = raw.source_branch;
	const target = raw.target_branch;
	if (typeof source !== "string" || !source || typeof target !== "string" || !target) return refuse("invalid", "response names no source or target branch");
	const sha = optionalSha(raw.sha);
	const diffHead = optionalSha(isRecord(raw.diff_refs) ? raw.diff_refs.head_sha : undefined);
	const merge = optionalSha(raw.merge_commit_sha);
	const squash = optionalSha(raw.squash_commit_sha);
	if (sha === false || diffHead === false || merge === false || squash === false) return refuse("invalid", "response carries a malformed commit sha");
	if (sha && diffHead && sha !== diffHead) return refuse("invalid", "response head sha and diff_refs head disagree");
	const head = sha ?? diffHead;
	const mergedAt = raw.merged_at;
	if (mergedAt !== undefined && mergedAt !== null && (typeof mergedAt !== "string" || Number.isNaN(Date.parse(mergedAt)))) {
		return refuse("invalid", "response merged_at is not a timestamp");
	}
	const state = typeof raw.state === "string" ? (STATES[raw.state] ?? "unknown") : "unknown";
	if (state === "merged" && !head) return refuse("invalid", "merged merge request names no head sha");
	return {
		provider: "gitlab",
		url: changeRequestUrl(repository, iid),
		number: iid,
		state,
		source_branch: source,
		target_branch: target,
		...(head ? { head_sha: head } : {}),
		...(typeof mergedAt === "string" ? { merged_at: mergedAt } : {}),
		...(merge ? { merge_commit_sha: merge } : {}),
		...(squash ? { squash_commit_sha: squash } : {}),
	};
}
