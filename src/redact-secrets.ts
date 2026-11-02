/** Secret-shaped value redaction, dependency-free so the viewer can apply the decision pane's own patterns. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = Object.freeze([
	/\b(?:bearer|basic)\s+[\w\-._~+/=]+/gi,
	/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{6,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{8,}/g,
	/\bxox[abposr]-[A-Za-z0-9-]{8,}/g,
	/\bAKIA[0-9A-Z]{12,}/g,
	/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
	/--?(?:password|passwd|token|secret|api[-_]?key|apikey)(?:[= ])\S+/gi,
	/[\w-]*(?:password|passwd|token|secret|api[-_]?key|apikey|access[-_]?key)[\w-]*=[^\s&]+/gi,
]);

/** Secret-shaped values become visible bullets. Never throws. */
export function redactSecrets(value: string): string {
	let out = value;
	for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, "\u2022\u2022\u2022");
	return out;
}
