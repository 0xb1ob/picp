/** GitHub's refusal of a push that touches `.github/workflows/` without the workflow scope, named. Import-free. */

export const WORKFLOW_SCOPE_ERROR = "workflow_scope_missing";

const REFUSAL = /refusing to allow an? (.+?) to create or update workflow `([^`]+)` without `(workflows?)` (scope|permission)/;

/** The named `workflow_scope_missing` error for a push GitHub refused for a missing workflow scope; else undefined. */
export function workflowScopeRefusal(output: string): string | undefined {
	const hit = REFUSAL.exec(output);
	if (hit === null) return undefined;
	const fix = hit[3] === "workflows"
		? "Grant the GitHub App the Workflows: Read and write permission"
		: "Add the `workflow` scope (classic token; gh's login: gh auth refresh -h github.com -s workflow) or Workflows: Read and write (fine-grained token)";
	return `${WORKFLOW_SCOPE_ERROR}: GitHub refused the push: the token cannot create or update workflow \`${hit[2]}\`. ${fix}, then push again. Nothing was pushed.`;
}
