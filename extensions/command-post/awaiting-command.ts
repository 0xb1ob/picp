/**
 * Awaiting-you: the read-only /cp-awaiting listing. Answers go through cp_decide; the
 * questionnaire overlay and its `agent_settled` auto-open are retired.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatAwaitingLine, formatDecideListing } from "./helpers.ts";
import type { ExtensionDeps } from "./shared.ts";

export function registerAwaitingCommand(pi: ExtensionAPI, deps: ExtensionDeps): void {
	const { commandPost, setLive, emit } = deps;

	pi.on("agent_settled", async (_event, ctx) => {
		setLive(ctx);
	});

	pi.registerCommand("cp-awaiting", {
		description:
			"List open Awaiting-you items. Answer with cp_decide, citing a mandate or a verbatim operator quote.",
		handler: async (_args, ctx) => {
			setLive(ctx);
			const post = commandPost(ctx.modelRegistry);
			try {
				const items = await post.awaitingSnapshot();
				emit(
					ctx,
					"cp-awaiting",
					formatDecideListing(items.map((item) => ({ line: formatAwaitingLine(item) }))),
				);
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
			}
		},
	});
}
