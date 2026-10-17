/**
 * Worker host guard: refuses reads of private ssh keys and `*.pem` files, and appends each remote-host call
 * (ssh/scp/sftp/rsync in command position) to `state/runs/<id>/host-audit.jsonl`. A floor, not a sandbox.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { CMD_POS, HEREDOC_BODY_RE, redactGithubTokens } from "./worker-credential-guard.ts";

export const HOST_AUDIT_FILE = "host-audit.jsonl";
const AUDIT_COMMAND_MAX = 500;
const REMOTE_RE = new RegExp(`${CMD_POS}(?:(?:command|env|exec|nohup|sudo)\\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*(?:ssh|scp|sftp|rsync)(?![\\w-])`, "i");
// `ssh -i <key>` hands the key to ssh without printing it; only that value is exempt.
const IDENTITY_RE = new RegExp(`(${CMD_POS}(?:command\\s+)?(?:ssh|scp|sftp)(?![\\w-])[^;&|\\n]*?)\\s-i\\s*\\S+`, "gi");

/** True for a `.ssh` dir, a key-type name anywhere (`id_rsa*`, not `*.pub`), a key in `.ssh/`, or a `*.pem` path. */
export function isKeyPath(path: string): boolean {
	if (/[^/]\.pem$/i.test(path) || /(?:^|\/)\.ssh\/*$/.test(path)) return true;
	const name = path.slice(path.lastIndexOf("/") + 1);
	if (name.endsWith(".pub")) return false;
	// Outside .ssh/ only ssh key-type names count, so `grep id_token src` stays allowed.
	if (/^id_(?:rsa|ed25519|ecdsa|dsa)(?![a-z0-9])/.test(name)) return true;
	if (!/(?:^|\/)\.ssh\/+[^/]*$/.test(path)) return false;
	return name.startsWith("id_") || /\.key$/i.test(name) || /[*?[{]/.test(name);
}

/** The first key path a bash command names, outside heredoc bodies and `ssh -i` values. */
export function keyPathIn(command: string): string | undefined {
	const body = command.replace(HEREDOC_BODY_RE, "$1").replace(IDENTITY_RE, "$1");
	return body.split(/[\s"'`;&|()<>=,]+/).find((word) => word !== "" && isKeyPath(word));
}

/** True when a bash command calls ssh/scp/sftp/rsync in command position (prose and heredoc bodies excluded). */
export const remoteHostCall = (command: string): boolean => REMOTE_RE.test(command.replace(HEREDOC_BODY_RE, "$1"));

export function keyReadRefusal(path: string): string {
	return [
		`Refused: a worker never reads a private ssh key, a .ssh directory or a *.pem file (\`${path}\`).`,
		"ssh and scp already use this host's ~/.ssh/config and agent; never print, copy or encode key material.",
		"If the job cannot be done without it, report_result `blocked` naming the file and why.",
	].join("\n");
}

/** The worker-reporter `tool_call` hook: a refusal string, else undefined after auditing a remote-host call. */
export function workerHostGuard(toolName: string, input: unknown, runDir: string, now: () => Date = () => new Date()): string | undefined {
	const fields = (input ?? {}) as { command?: unknown; path?: unknown };
	if (toolName !== "bash") return typeof fields.path === "string" && isKeyPath(fields.path) ? keyReadRefusal(fields.path) : undefined;
	if (typeof fields.command !== "string") return undefined;
	const key = keyPathIn(fields.command);
	if (key) return keyReadRefusal(key);
	if (!remoteHostCall(fields.command)) return undefined;
	const file = join(runDir, HOST_AUDIT_FILE);
	try {
		appendFileSync(file, `${JSON.stringify({ at: now().toISOString(), command: redactGithubTokens(fields.command).slice(0, AUDIT_COMMAND_MAX) })}\n`);
	} catch (error) {
		return `Refused: the host audit ${file} could not be written (${(error as Error).message}); a remote-host call never runs unaudited. Report blocked naming that path.`;
	}
	return undefined;
}
