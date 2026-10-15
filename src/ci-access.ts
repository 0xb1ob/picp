/**
 * CI the token cannot read (ask-81b54d83f0b2): named loudly and specifically, never as "no CI yet".
 * Only the permission outcome is ever shown or stored — never a token value, never raw `gh` output here.
 */

/** The `last_ci` value `state/ci-watch.json` records when the CI read was refused for permission. */
export const CI_UNREADABLE = "unreadable";
export const CI_UNREADABLE_LABEL = "CI unreadable — token lacks Actions/checks read";
export const CI_READ_NEEDED = "fine-grained PAT: Actions read + Checks read + Commit statuses read; classic: repo";

const DENIED = /\bHTTP 40[34]\b|not accessible by (?:integration|personal access token)|must have admin/i;
const CI_ENDPOINT = /\bgh run list\b|\/actions\/|check-runs|\/status(?:es)?\b/;

/** True only for a permission refusal of a CI read (Actions runs/workflows, check-runs, commit statuses). */
export function ciReadDenied(message: string): boolean {
	return DENIED.test(message) && CI_ENDPOINT.test(message);
}
