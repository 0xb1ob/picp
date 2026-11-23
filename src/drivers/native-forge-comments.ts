/**
 * WP8 (G2/G3): a native implementer's comment writes, Claude-only and SDK-free: `issue_comment`, `pr_review_reply` and
 * `pr_thread_resolve`. Each reads ownership (this job's origin repo, PR or named issue) before it writes; gh runs in the
 * worker process with GH_REPO pinned to the GitHub origin, so no credential enters the CLI child.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../contracts.ts";
import type { ForgeReply } from "./native-forge.ts";
import { exec, type ForgeJob, originRepoOf, type RecordedPr, recordedPr } from "./native-gh-read.ts";

const THREAD_ID = /^[A-Za-z0-9_=-]{1,100}$/;
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/gi;
const THREAD_QUERY = "query($id:ID!){node(id:$id){... on PullRequestReviewThread{isResolved pullRequest{number repository{nameWithOwner}}}}}";
const THREAD_JQ = ".data.node | [(.isResolved | tostring), (.pullRequest.number | tostring), .pullRequest.repository.nameWithOwner] | @tsv";
const RESOLVE_MUTATION = "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}";
const UNKNOWN_ORIGIN = "this job's origin is not a github.com remote, so no comment write can be pinned to it.";

const reply = (text: string, isError: boolean): ForgeReply => ({ text, isError });
const refuse = (text: string): ForgeReply => reply(`Refused: ${text}`, true);
const noPr = (tool: string) => refuse(`${tool} reaches only this job's PR, and there is no PR yet: open it with pr_create first.`);

export interface CommentWrites {
	descriptions: { issueComment: string; reviewReply: string; threadResolve: string };
	issueComment(args: { issue: number; body: string }): Promise<ForgeReply>;
	reviewReply(args: { comment_id: number; body: string }): Promise<ForgeReply>;
	threadResolve(args: { thread_id: string }): Promise<ForgeReply>;
}

/** The three comment writes for `job`; `env` is the worker's own (credentials, CP_HOME for the brief). */
export function commentWrites(job: ForgeJob, env: NodeJS.ProcessEnv = process.env): CommentWrites {
	const { GH_REPO: _ghRepo, ...ghEnv } = env;
	let origin: Promise<string | undefined> | undefined;
	const originRepo = () => (origin ??= originRepoOf(job.worktree, ghEnv));
	const gh = (repo: string, args: string[]) => exec("gh", args, job.worktree, { ...ghEnv, GH_REPO: repo });
	let branchPr: RecordedPr | undefined;

	/** The record pr_create wrote, else the job branch's same-repo PR (a resumed job's run dir may lack the record). */
	const jobPr = async (repo: string): Promise<RecordedPr | undefined> => {
		const recorded = recordedPr(job.runDir);
		if (recorded !== undefined || branchPr !== undefined) return recorded ?? branchPr;
		const read = await gh(repo, ["pr", "view", job.job_id, "--json", "number,url,headRefName,isCrossRepository"]);
		if (!read.ok) return undefined;
		try {
			const pr = JSON.parse(read.out) as { number?: unknown; url?: unknown; headRefName?: unknown; isCrossRepository?: unknown };
			const own = pr.headRefName === job.job_id && pr.isCrossRepository === false && typeof pr.number === "number" && typeof pr.url === "string";
			if (own) branchPr = { number: pr.number as number, url: pr.url as string };
		} catch {
			// Output that is not JSON names no PR; the caller refuses with "no PR yet".
		}
		return branchPr;
	};

	/** Issue numbers the brief names: `#n` and this repo's `/issues/n` URLs. */
	const briefIssues = (repo: string): number[] => {
		const file = join(env.CP_HOME ?? "", paths.briefFile(job.job_id));
		if (!env.CP_HOME || !existsSync(file)) return [];
		const text = readFileSync(file, "utf8");
		const urls = new RegExp(`github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/issues/(\\d+)`, "gi");
		return [...text.matchAll(/(?:^|[\s(])#(\d+)\b/g), ...text.matchAll(urls)].map((match) => Number(match[1]));
	};

	/** Issues of `repo` the job PR closes: gh's closingIssuesReferences and `Closes|Fixes|Resolves #n` in its body. */
	const closingIssues = async (repo: string, pr: RecordedPr): Promise<{ numbers: number[]; note?: string }> => {
		const read = await gh(repo, ["pr", "view", pr.url, "--json", "body,closingIssuesReferences"]);
		let parsed: { body?: unknown; closingIssuesReferences?: unknown };
		try {
			if (!read.ok) throw new Error(read.out);
			parsed = JSON.parse(read.out) as typeof parsed;
		} catch (error) {
			return { numbers: [], note: `; ${pr.url}'s closing issues could not be read (${(error as Error).message.slice(0, 200)})` };
		}
		const refs = Array.isArray(parsed.closingIssuesReferences) ? (parsed.closingIssuesReferences as unknown[]) : [];
		const linked = refs.flatMap((value) => {
			const ref = value as { number?: unknown; url?: unknown; repository?: { name?: unknown; owner?: { login?: unknown } } };
			const named = ref.repository ? `${String(ref.repository.owner?.login)}/${String(ref.repository.name)}` : undefined;
			const where = named ?? (typeof ref.url === "string" ? /github\.com\/([^/]+\/[^/]+)\/issues\/\d+/.exec(ref.url)?.[1] : undefined);
			return typeof ref.number === "number" && where?.toLowerCase() === repo.toLowerCase() ? [ref.number] : [];
		});
		const body = typeof parsed.body === "string" ? [...parsed.body.matchAll(CLOSING)].map((match) => Number(match[1])) : [];
		return { numbers: [...linked, ...body] };
	};

	return {
		descriptions: {
			issueComment: "Comment on an issue of this job's repo that its brief names (#n or an /issues/n URL) or its PR closes (Closes #n). " +
				"Any other issue, a PR and another repo are refused.",
			reviewReply: "Reply to a top-level review comment (comment_id, as gh_read `pr threads` lists it) on this job's own PR. " +
				"A reply's id, another PR's comment and another repo are refused.",
			threadResolve: "Resolve a review thread (thread_id, as gh_read `pr threads` lists it) of this job's own PR. Another PR's thread " +
				"is refused; an already resolved thread is a no-op.",
		},
		async issueComment(args) {
			const repo = await originRepo();
			if (repo === undefined) return refuse(`issue_comment: ${UNKNOWN_ORIGIN}`);
			const pr = await jobPr(repo);
			const closing = pr === undefined ? { numbers: [] } : await closingIssues(repo, pr);
			const allowed = [...new Set([...briefIssues(repo), ...closing.numbers])].sort((a, b) => a - b);
			if (!allowed.includes(args.issue)) {
				const listed = allowed.length > 0 ? allowed.map((n) => `#${n}`).join(", ") : "none";
				return refuse(`issue_comment posts only on an issue of ${repo} this job's brief names or its PR closes (${listed}${closing.note ?? ""}); #${args.issue} is refused.`);
			}
			const kind = await gh(repo, ["api", `repos/${repo}/issues/${args.issue}`, "--jq", ".pull_request != null"]);
			if (!kind.ok) return reply(`issue_comment could not read ${repo}#${args.issue}:\n${kind.out}`, true);
			if (kind.out.trim() !== "false") return refuse(`issue_comment: ${repo}#${args.issue} is a pull request, not an issue; it comments on issues only.`);
			const posted = await gh(repo, ["issue", "comment", String(args.issue), "--body", args.body]);
			return reply(posted.ok ? `Commented on ${repo}#${args.issue}: ${posted.out}` : `issue_comment failed:\n${posted.out}`, !posted.ok);
		},
		async reviewReply(args) {
			const repo = await originRepo();
			if (repo === undefined) return refuse(`pr_review_reply: ${UNKNOWN_ORIGIN}`);
			const pr = await jobPr(repo);
			if (pr === undefined) return noPr("pr_review_reply");
			const id = args.comment_id;
			const read = await gh(repo, ["api", `repos/${repo}/pulls/comments/${id}`, "--jq", '[.pull_request_url, (.in_reply_to_id // "")] | @tsv']);
			if (!read.ok) return reply(`pr_review_reply could not read review comment ${id} of ${repo}:\n${read.out}`, true);
			const [url = "", replyTo = ""] = read.out.trim().split("\t");
			if (!url.toLowerCase().endsWith(`/repos/${repo}/pulls/${pr.number}`.toLowerCase())) {
				return refuse(`pr_review_reply replies only on this job's PR #${pr.number} (${pr.url}); review comment ${id} is on ${url || "no PR of this repo"}.`);
			}
			if (replyTo !== "") return refuse(`pr_review_reply: review comment ${id} is a reply; reply to its top-level comment ${replyTo} instead.`);
			const posted = await gh(repo, ["api", "--method", "POST", `repos/${repo}/pulls/${pr.number}/comments/${id}/replies`, "-f", `body=${args.body}`, "--jq", ".html_url"]);
			return reply(posted.ok ? `Replied to review comment ${id} on ${pr.url}: ${posted.out}` : `pr_review_reply failed:\n${posted.out}`, !posted.ok);
		},
		async threadResolve(args) {
			const id = args.thread_id;
			if (!THREAD_ID.test(id)) return refuse(`pr_thread_resolve takes a thread_id as gh_read \`pr threads\` lists it (letters, digits, _ = -); ${JSON.stringify(id).slice(0, 110)} is refused.`);
			const repo = await originRepo();
			if (repo === undefined) return refuse(`pr_thread_resolve: ${UNKNOWN_ORIGIN}`);
			const pr = await jobPr(repo);
			if (pr === undefined) return noPr("pr_thread_resolve");
			const read = await gh(repo, ["api", "graphql", "-f", `query=${THREAD_QUERY}`, "-f", `id=${id}`, "--jq", THREAD_JQ]);
			if (!read.ok) return reply(`pr_thread_resolve could not read review thread ${id}:\n${read.out}`, true);
			const [resolved = "", number = "", owner = ""] = read.out.trim().split("\t");
			if (owner.toLowerCase() !== repo.toLowerCase() || Number(number) !== pr.number) {
				return refuse(`pr_thread_resolve resolves only a review thread of this job's PR #${pr.number} (${pr.url}); ${id} is ${owner ? `on ${owner}#${number}` : "not a review thread"}.`);
			}
			if (resolved === "true") return reply(`Review thread ${id} on ${pr.url} is already resolved.`, false);
			const done = await gh(repo, ["api", "graphql", "-f", `query=${RESOLVE_MUTATION}`, "-f", `id=${id}`, "--jq", ".data.resolveReviewThread.thread.isResolved"]);
			return reply(done.ok ? `Resolved review thread ${id} on ${pr.url}.` : `pr_thread_resolve failed:\n${done.out}`, !done.ok);
		},
	};
}
