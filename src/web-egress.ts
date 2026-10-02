/**
 * Worker-side egress guard for pi-web-access's four tools (cp-if9x), called
 * from the worker-reporter `tool_call` hook. A web argument leaves the host,
 * so nothing from the command-post state dir, no job path and no secret may
 * ride in it, and the modes that spend a model inside the extension or open a
 * curator nobody watches are refused.
 *
 * A heuristic floor, not a sandbox: base64 or paraphrase is not caught, and
 * `bash` egress is pre-existing. A reason names the rule or variable, never
 * the matched value.
 */
import { SECRET_PATTERNS } from "./secret-patterns.ts";
import { PACKAGE_TOOLS } from "./worker-packages.ts";

export const WEB_TOOLS: readonly string[] = PACKAGE_TOOLS["pi-web-access"] ?? [];
export const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
/** A job path value shorter than this is too generic to match on. */
export const JOB_PATH_MIN = 8;
/** A secret env value shorter than this is too generic to match on. */
export const SECRET_VALUE_MIN = 12;

const JOB_PATH_VARS = ["CP_HOME", "CP_WORKTREE", "CP_RUN_DIR", "CP_ARTIFACT_PATH"] as const;
const TAIL = "Web queries name public libraries, APIs and error messages; keep repository content, paths and credentials out of them.";

export function webEgressRefusal(toolName: string, input: unknown, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (!WEB_TOOLS.includes(toolName)) return undefined;
	const refuse = (why: string) => `${toolName} refused: ${why}. ${TAIL}`;
	const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const blob = JSON.stringify(input ?? {});
	if (typeof args.proxy === "string" && args.proxy.trim() !== "") return refuse("a proxy is not allowed from a worker");
	if (args.workflow !== undefined && args.workflow !== "none") return refuse(`workflow must be "none" for a headless worker (no curator, no in-extension model)`);
	if (toolName === "fetch_content") {
		if (args.mode === "answer" || args.answerModel !== undefined) return refuse("answer mode spends a model inside the extension; fetch the content and read it yourself");
		const urls = [args.url, ...(Array.isArray(args.urls) ? args.urls : [])].filter((u) => u !== undefined);
		if (urls.some((u) => !isHttpUrl(u))) return refuse("only http(s) URLs may be fetched");
	}
	if (blob.includes(".pi-command-post")) return refuse("command-post state never leaves the host (.pi-command-post)");
	for (const name of JOB_PATH_VARS) {
		const value = env[name];
		if (value && value.length >= JOB_PATH_MIN && blob.includes(value)) return refuse(`it contains the value of ${name}; job paths never leave the host`);
	}
	for (const [name, value] of Object.entries(env)) {
		if (SECRET_ENV_NAME.test(name) && value && value.length >= SECRET_VALUE_MIN && blob.includes(value)) {
			return refuse(`it contains the value of ${name}; secrets never leave the host`);
		}
	}
	const shape = SECRET_PATTERNS.find((pattern) => pattern.re.test(blob));
	if (shape) return refuse(`it matches a credential shape (${shape.name})`);
	return undefined;
}

function isHttpUrl(value: unknown): boolean {
	if (typeof value !== "string") return false;
	try {
		const { protocol } = new URL(value);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}
