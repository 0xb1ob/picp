/**
 * N4d/WP1: a native implementer's network (a planner's: gh_read) as in-process picp MCP tools. They run in the
 * claude-worker process, which holds the worker env, so no credential enters the CLI child. Output is redacted, capped.
 */
import { type SdkMcpToolDefinition, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { BODY_MAX, type ForgeReply, forgeWrites, TITLE_MAX } from "./native-forge.ts";
import { commentWrites } from "./native-forge-comments.ts";
import { capped, type ForgeJob, type ForgeState, GH_ARG_MAX, GH_ARGS_MAX, GH_READ_VERBS, ghRead as sharedGhRead, processState } from "./native-gh-read.ts";

export { commitIdentityEnv } from "./native-forge.ts";
export { FORGE_OUTPUT_MAX, FORGE_PR_FILE, type ForgeState } from "./native-gh-read.ts";

const reply = (value: string, isError: boolean) => ({ content: [{ type: "text" as const, text: capped(value) }], isError });
const wrap = (done: ForgeReply) => reply(done.text, done.isError);

/** FORGE_TOOL_NAMES for `job`, in that order; `env` is the worker's own (credentials). */
export function forgeTools(job: ForgeJob, env: NodeJS.ProcessEnv = process.env, state: ForgeState = processState): SdkMcpToolDefinition<any>[] {
	const forge = forgeWrites(job, env);
	const push = tool("git_push", forge.descriptions.push, { branch: z.string().optional(), force: z.boolean().optional() }, async (args) => wrap(await forge.push(args)));
	const fetch = tool("git_fetch", forge.descriptions.fetch, { cwd: z.string().optional() }, async (args) => wrap(await forge.fetch(args)));
	const prCreate = tool(
		"pr_create",
		forge.descriptions.prCreate,
		{ title: z.string().min(1).max(TITLE_MAX), body: z.string().max(BODY_MAX) },
		async (args) => wrap(await forge.prCreate(args)),
	);
	const prEdit = tool(
		"pr_edit",
		forge.descriptions.prEdit,
		{ pr: z.number().int().optional(), title: z.string().min(1).max(TITLE_MAX).optional(), body: z.string().max(BODY_MAX).optional() },
		async (args) => wrap(await forge.prEdit(args)),
	);

	const shared = sharedGhRead(job, env, state);
	const ghRead = tool(
		"gh_read",
		shared.description,
		{
			verb: z.enum(GH_READ_VERBS),
			number: z.number().int().positive().optional(),
			run_id: z.string().regex(/^\d+$/).optional(),
			log_failed: z.boolean().optional(),
			path: z.string().min(1).max(GH_ARG_MAX).optional(),
			args: z.array(z.string().max(GH_ARG_MAX)).max(GH_ARGS_MAX).optional(),
		},
		async (args) => {
			const read = await shared.run(args);
			return reply(read.text, read.isError);
		},
	);

	const comments = commentWrites(job, env);
	const body = z.string().min(1).max(BODY_MAX);
	const issueComment = tool("issue_comment", comments.descriptions.issueComment, { issue: z.number().int().positive(), body }, async (args) => wrap(await comments.issueComment(args)));
	const reviewReply = tool("pr_review_reply", comments.descriptions.reviewReply, { comment_id: z.number().int().positive(), body }, async (args) => wrap(await comments.reviewReply(args)));
	const threadResolve = tool("pr_thread_resolve", comments.descriptions.threadResolve, { thread_id: z.string().min(1).max(100) }, async (args) => wrap(await comments.threadResolve(args)));

	return [push, fetch, prCreate, prEdit, ghRead, issueComment, reviewReply, threadResolve];
}
