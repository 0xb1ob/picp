import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { isIsoTimestamp } from "./contracts.ts";
import { isBoardSlug } from "./viewer/boards.ts";
import { resolveStateDir } from "./viewer/sessions.ts";

// Directory-relative opens keep the source anchored even when a worker renames it mid-copy.
function stageEntry(parentFd: number, name: string, destination: string, source: string): void {
	let fd: number;
	try {
		fd = openSync(`/proc/self/fd/${parentFd}/${name}`, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`board path ${join(source, name)} resolves outside ${source}`);
		throw error;
	}
	try {
		const stat = fstatSync(fd);
		if (stat.isDirectory()) {
			mkdirSync(destination);
			for (const child of readdirSync(`/proc/self/fd/${fd}`)) stageEntry(fd, child, join(destination, child), join(source, name));
		} else if (stat.isFile()) {
			const output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
			try {
				const buffer = Buffer.alloc(64 * 1024);
				let size: number;
				while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
					let written = 0;
					while (written < size) written += writeSync(output, buffer, written, size - written);
				}
			} finally { closeSync(output); }
		} else {
			throw new Error(`board path ${join(source, name)} is not a regular file or directory`);
		}
	} finally { closeSync(fd); }
}

/** Publish only a privately staged, validated snapshot of worker-authored files. */
export function publishBoard(home: string, jobId: string, artifact: string, beforeStage?: () => void): string {
	if (!isBoardSlug(jobId)) throw new Error(`board slug ${JSON.stringify(jobId)} must be lowercase [a-z0-9-], 1-64 chars, with no leading hyphen`);
	const source = dirname(artifact);
	if (artifact !== join(source, "board.json")) throw new Error(`board artifact must be ${join(source, "board.json")}`);
	if (realpathSync(source) !== source) throw new Error(`board source ${source} must be a real directory`);
	const boards = join(resolveStateDir(home), "boards");
	mkdirSync(boards, { recursive: true });
	if (realpathSync(boards) !== boards) throw new Error(`boards directory ${boards} resolves outside viewer state`);
	const target = join(boards, jobId);
	try { lstatSync(target); throw new Error(`board ${target} already exists; refusing to replace it`); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const temporary = mkdtempSync(join(boards, ".publishing-"));
	let rootFd: number | undefined;
	try {
		rootFd = openSync(source, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		beforeStage?.();
		stageEntry(rootFd, "board.json", join(temporary, "board.json"), source);
		stageEntry(rootFd, "site", join(temporary, "site"), source);
		const index = join(temporary, "site/index.html");
		if (!existsSync(index) || !statSync(index).isFile()) throw new Error(`board site needs site/index.html`);
		let value: unknown;
		try { value = JSON.parse(readFileSync(join(temporary, "board.json"), "utf8")); }
		catch { throw new Error(`board.json ${artifact} is malformed JSON`); }
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`board.json ${artifact} must be an object`);
		const board = value as Record<string, unknown>;
		if (typeof board.title !== "string" || !board.title || typeof board.description !== "string" ||
			!Array.isArray(board.job_ids) || !board.job_ids.every((id) => typeof id === "string") ||
			typeof board.created_at !== "string" || !isIsoTimestamp(board.created_at)) {
			throw new Error(`board.json ${artifact} needs title, description, job_ids and created_at`);
		}
		renameSync(temporary, target);
	} catch (error) {
		rmSync(temporary, { recursive: true, force: true });
		throw error;
	} finally { if (rootFd !== undefined) closeSync(rootFd); }
	return jobId;
}
