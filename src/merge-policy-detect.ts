/**
 * Onboarding detection of who merges a new project's PRs: a solo repo may let the command post merge (`repo`);
 * a team repo, or one this home cannot read, hands the reviewed PR to a human (`human_handoff`, fail safe).
 */
import type { MergePolicy } from "./contracts.ts";
import { ghBranchRulesArgs, parseBranchRules } from "./merge-permission.ts";
import { type CommandRunner, MERGE_ASK_QUERY_TIMEOUT_MS, runCommand } from "./merge-ask.ts";

/** What the probe read from GitHub and the clone. */
export interface MergeFlowFacts {
	owner: string;
	login: string;
	inOrganization: boolean;
	/** The base branch's rules require approving reviews (count > 0) or code-owner review. */
	requiredReviews: boolean;
	codeOwners: boolean;
}

/** Throws when any fact is unreadable; `repo` is GitHub's owner/repo, `cwd` the clone. */
export type MergeFlowProbe = (input: { cwd: string; repo: string; base?: string }) => Promise<MergeFlowFacts>;

export interface MergePolicyDecision {
	policy: MergePolicy;
	/** The signals behind the decision, for the add output. */
	note: string;
}

const CODEOWNERS_PATHS = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];

/** Solo only when every signal says so; anything else is a team repo. */
export function classifyMergeFlow(facts: MergeFlowFacts): MergePolicyDecision {
	const team = [
		...(facts.inOrganization ? ["org-owned"] : facts.owner.toLowerCase() !== facts.login.toLowerCase() ? [`owned by ${facts.owner}, not ${facts.login}`] : []),
		...(facts.requiredReviews ? ["required reviews"] : []),
		...(facts.codeOwners ? ["CODEOWNERS"] : []),
	];
	return team.length > 0
		? { policy: "human_handoff", note: `detected team repo: ${team.join(", ")}` }
		: { policy: "repo", note: `detected solo repo: owned by ${facts.login}, no required reviews, no CODEOWNERS` };
}

/** Never throws: a failed probe is `human_handoff` with the reason. */
export async function detectMergePolicy(probe: MergeFlowProbe, input: Parameters<MergeFlowProbe>[0]): Promise<MergePolicyDecision> {
	try {
		return classifyMergeFlow(await probe(input));
	} catch (error) {
		return { policy: "human_handoff", note: `detection failed, fail safe: ${(error as Error).message.slice(0, 160)}` };
	}
}

/** Read-only: `gh api user`, `gh repo view`, the base branch's rules, and CODEOWNERS on the clone's base. */
export function ghMergeFlowProbe(exec: CommandRunner = runCommand): MergeFlowProbe {
	return async ({ cwd, repo, base }) => {
		const run = (command: string, args: string[]) => exec(command, args, { cwd, timeoutMs: MERGE_ASK_QUERY_TIMEOUT_MS });
		const login = (await run("gh", ["api", "user", "--jq", ".login"])).trim();
		const raw = await run("gh", ["repo", "view", repo, "--json", "owner,isInOrganization,defaultBranchRef"]);
		let view: { owner?: { login?: unknown }; isInOrganization?: unknown; defaultBranchRef?: { name?: unknown } };
		try {
			view = JSON.parse(raw) ?? {};
		} catch {
			throw new Error(`gh repo view ${repo} answered output that is not JSON`);
		}
		const owner = view.owner?.login;
		const branch = base ?? view.defaultBranchRef?.name;
		if (!login || typeof owner !== "string" || typeof view.isInOrganization !== "boolean" || typeof branch !== "string") {
			throw new Error(`gh repo view ${repo} answered without owner, isInOrganization or a default branch`);
		}
		const rule = parseBranchRules(await run("gh", ghBranchRulesArgs(branch))).find((entry) => entry.type === "pull_request");
		const count = rule?.parameters?.required_approving_review_count;
		const requiredReviews = (typeof count === "number" && count > 0) || rule?.parameters?.require_code_owner_review === true;
		const tree = await run("git", ["ls-tree", "--name-only", `origin/${branch}`, "--", ...CODEOWNERS_PATHS]);
		return { owner, login, inOrganization: view.isInOrganization, requiredReviews, codeOwners: tree.trim().length > 0 };
	};
}
