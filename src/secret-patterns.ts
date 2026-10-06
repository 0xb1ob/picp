/**
 * Credential shapes that must never leave the host: scanned in briefs
 * (`assertBriefIsSafe`) and in worker web-tool arguments (`webEgressRefusal`).
 * Dependency-free, so the worker extension can import it.
 */
/** A GitHub token shape; shared with the worker's bash-output redaction (src/worker-credential-guard.ts). */
export const GITHUB_TOKEN_RE = /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/;
export const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = Object.freeze([
	{ name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ name: "openai-style key", re: /\bsk-[A-Za-z0-9]{16,}\b/ },
	{ name: "anthropic-style key", re: /\bsk-ant-[A-Za-z0-9-]{16,}\b/ },
	{ name: "github token", re: GITHUB_TOKEN_RE },
	{ name: "aws access key id", re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/ },
	{ name: "slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
	{ name: "bearer token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
	{ name: "inline credential assignment", re: /\b[A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S{8,}/ },
]);
