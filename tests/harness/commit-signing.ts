/** Worker commit-signing fixtures: a throwaway ssh signing key, a host gitconfig that signs with it, and checks. */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { waitFor } from "./index.ts";

/** An unencrypted ed25519 key at `<dir>/keys/git-signing` and the allowed-signers file verify-commit reads. */
export function signingKey(dir: string): { file: string; allowed: string } {
	mkdirSync(join(dir, "keys"), { recursive: true, mode: 0o700 });
	const file = join(dir, "keys", "git-signing");
	const args = ["-q", "-t", "ed25519", "-N", "", "-C", "picp-signing-e2e", "-f", file];
	execFileSync("ssh-keygen", args, { stdio: "ignore" });
	const allowed = join(dir, "keys", "allowed_signers");
	writeFileSync(allowed, `signing@test.invalid ${readFileSync(`${file}.pub`, "utf8")}`);
	return { file, allowed };
}

/** A foreground ssh-agent on `<dir>/agent.sock` holding the key at `file`, whose private file is then deleted. */
export async function signingAgent(t: TestContext, dir: string, file: string): Promise<string> {
	const socket = join(dir, "agent.sock");
	const agent = spawn("ssh-agent", ["-D", "-a", socket], { stdio: "ignore" });
	t.after(() => void agent.kill());
	await waitFor(() => existsSync(socket), Boolean, { timeoutMs: 10_000, what: "the ssh-agent socket" });
	execFileSync("ssh-add", ["-q", file], { env: { ...process.env, SSH_AUTH_SOCK: socket }, stdio: "ignore" });
	rmSync(file);
	return socket;
}

/** The gitconfig lines of a host that signs every commit with the ssh key at `path` (a key file or its `.pub`). */
export const signsConfig = (path: string): string =>
	`[gpg]\n\tformat = ssh\n[commit]\n\tgpgsign = true\n[user]\n\tsigningkey = ${path}\n`;

/** `git verify-commit rev` in `cwd` against `allowed`: whether it passed and what git said. */
export function verifyCommit(cwd: string, allowed: string, rev = "HEAD"): { ok: boolean; out: string } {
	const args = ["-c", `gpg.ssh.allowedSignersFile=${allowed}`, "verify-commit", rev];
	const run = spawnSync("git", args, { cwd, encoding: "utf8" });
	return { ok: run.status === 0, out: `${run.stdout}${run.stderr}` };
}

/** Whether commit `rev` in `cwd` carries a signature header at all. */
export const hasSignature = (cwd: string, rev = "HEAD"): boolean =>
	/^gpgsig/m.test(execFileSync("git", ["cat-file", "commit", rev], { cwd, encoding: "utf8" }));
