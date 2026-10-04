/**
 * Dashboard image attachments (cp-br81 plan, PR1 core): the one place that knows the upload directory, its id
 * format, the magic-byte sniff and the limits. The viewer writes uploads (src/viewer/operator-upload-api.ts) and
 * serves them back to the composer; the operator session's bridge (src/dashboard-control.ts) reads them to inline
 * them as image parts. Both processes share `/tmp`, so the root is a fixed literal (docs/storage.md, Outside the
 * home), injectable for tests through an option or `CP_UPLOAD_ROOT`.
 *
 *   <root>/<yyyymmdd>/<24 hex>.<png|jpg|webp|gif>    root and day dirs 0700, files 0600 (O_EXCL|O_NOFOLLOW)
 *
 * A path is only ever rebuilt from an id's regex captures, never from request text. Files older than 7 days are
 * removed by the sweep that runs before every write, and treated as gone by every read.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

/** Production root: a literal, not tmpdir(), because the viewer and the operator session may see different TMPDIRs. */
export const UPLOAD_ROOT = "/tmp/cp-dashboard-uploads";
export const UPLOAD_ROOT_ENV = "CP_UPLOAD_ROOT";
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const UPLOAD_MAX_PER_MESSAGE = 8;
export const UPLOAD_MESSAGE_MAX_BYTES = 32 * 1024 * 1024;
export const UPLOAD_DIR_MAX_BYTES = 256 * 1024 * 1024;
export const UPLOAD_MAX_AGE_MS = 7 * 86_400_000;
export const UPLOAD_RATE_LIMIT = 24;
export const IMAGE_LONG_EDGE = 1568;
export const IMAGE_INLINE_MAX_BYTES = 768 * 1024;
export const IMAGE_MESSAGE_INLINE_BYTES = 2 * 1024 * 1024;
export const IMAGE_PREP_MS = 15_000;
export const UPLOAD_SEND_TIMEOUT_MS = 25_000;

export const UPLOAD_ID_SOURCE = "im-\\d{8}-[0-9a-f]{24}\\.(?:png|jpg|webp|gif)";
export const UPLOAD_ID_RE = new RegExp(`^${UPLOAD_ID_SOURCE}$`);
const ID_PARTS = /^im-(\d{8})-([0-9a-f]{24})\.(png|jpg|webp|gif)$/;
const DAY_DIR = /^\d{8}$/;
const FILE_NAME = /^[0-9a-f]{24}\.(?:png|jpg|webp|gif)$/;
export const isUploadId = (value: unknown): value is string => typeof value === "string" && UPLOAD_ID_RE.test(value);

export type ImageExt = "png" | "jpg" | "webp" | "gif";
export const EXT_MIME: Record<ImageExt, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** The upload root: an explicit option (tests), else `CP_UPLOAD_ROOT`, else the production literal. */
export const uploadRoot = (option?: string): string => option ?? (process.env[UPLOAD_ROOT_ENV] ? resolve(process.env[UPLOAD_ROOT_ENV]) : UPLOAD_ROOT);

/** Base64 bytes one inlined image may take when a message carries `n`: 768 KiB, and 2 MiB across the message. */
export const inlineBudget = (n: number): number => Math.min(IMAGE_INLINE_MAX_BYTES, Math.floor(IMAGE_MESSAGE_INLINE_BYTES / Math.max(1, n)));

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);
const ascii = (bytes: Uint8Array, from: number, to: number) => Buffer.from(bytes.subarray(from, to)).toString("latin1");

/** What the bytes are, by magic bytes only: one of the four formats, or why not. Never trusts a declared type. */
export function sniffImage(bytes: Uint8Array): { mime: string; ext: ImageExt } | { refused: "heic" | "svg" | "unknown" } {
	if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: EXT_MIME.png, ext: "png" };
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: EXT_MIME.jpg, ext: "jpg" };
	if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return { mime: EXT_MIME.gif, ext: "gif" };
	if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return { mime: EXT_MIME.webp, ext: "webp" };
	if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp" && HEIF_BRANDS.has(ascii(bytes, 8, 12))) return { refused: "heic" };
	if (/^(?:\uFEFF|\xEF\xBB\xBF)?\s*</.test(ascii(bytes, 0, 256))) return { refused: "svg" };
	return { refused: "unknown" };
}

export class UploadDirError extends Error {}

/** Why `path` is not a directory only we may use (lstat: no symlink, ours), or null; ENOENT is `"missing"`. */
function dirProblem(path: string): string | null {
	let stat;
	try {
		stat = lstatSync(path);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : (error as Error).message;
	}
	if (stat.isSymbolicLink()) return "it is a symlink";
	if (!stat.isDirectory()) return "it is not a directory";
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return `it is owned by uid ${stat.uid}, not ${process.getuid()}`;
	return null;
}

/** Create `path` 0700 (its parent must exist), or prove it is a real directory of ours; group/other bits are removed. */
export function ensureUploadDir(path: string): void {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new UploadDirError(`upload directory ${path} is not safe: ${(error as Error).message}`);
	}
	const problem = dirProblem(path);
	if (problem) throw new UploadDirError(`upload directory ${path} is not safe: ${problem}`);
	if ((lstatSync(path).mode & 0o077) !== 0) chmodSync(path, 0o700);
}

/** `<root>/<yyyymmdd>/<hex>.<ext>` from the id's captures, or undefined for anything that is not an id. */
export function uploadFile(root: string, id: string): string | undefined {
	const match = ID_PARTS.exec(id);
	return match ? join(root, match[1]!, `${match[2]}.${match[3]}`) : undefined;
}

const day = (now: Date) => now.toISOString().slice(0, 10).replace(/-/g, "");
export const newUploadId = (ext: ImageExt, now: Date): string => `im-${day(now)}-${randomBytes(12).toString("hex")}.${ext}`;
const expiresAt = (mtimeMs: number) => new Date(mtimeMs + UPLOAD_MAX_AGE_MS).toISOString();

/** Remove files older than 7 days (then empty day dirs) and total the rest. Only id-shaped names are touched. */
export function sweepUploads(root: string, now: Date): { total: number; removed: number } {
	let total = 0;
	let removed = 0;
	if (dirProblem(root)) return { total, removed };
	for (const dayName of readdirSync(root)) {
		const dayDir = join(root, dayName);
		if (!DAY_DIR.test(dayName) || dirProblem(dayDir)) continue;
		let left = 0;
		for (const name of readdirSync(dayDir)) {
			const file = join(dayDir, name);
			const stat = lstatSync(file, { throwIfNoEntry: false });
			if (!FILE_NAME.test(name) || !stat?.isFile()) {
				left++;
				continue;
			}
			if (now.getTime() - stat.mtimeMs > UPLOAD_MAX_AGE_MS) {
				unlinkSync(file);
				removed++;
			} else {
				total += stat.size;
				left++;
			}
		}
		if (left === 0) rmdirSync(dayDir);
	}
	return { total, removed };
}

/** Write one upload 0600 through `O_EXCL|O_NOFOLLOW` into its day dir (created 0700). Throws on any failure. */
export function writeUpload(root: string, id: string, bytes: Uint8Array): void {
	const file = uploadFile(root, id);
	if (!file) throw new Error(`not an upload id: ${id}`);
	ensureUploadDir(root);
	ensureUploadDir(join(file, ".."));
	const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		if (writeSync(fd, bytes) !== bytes.length) throw new Error(`short write to ${file}`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export type UploadStat = { state: "ok"; path: string; size: number; mime: string; expires_at: string } | { state: "missing" } | { state: "invalid"; reason: string };

/** Open an upload for reading: a regular file of ours, ≤ 10 MiB, younger than 7 days (older is unlinked: missing). */
function openUpload(root: string, id: string, now: Date): (UploadStat & { state: "ok"; fd: number }) | Exclude<UploadStat, { state: "ok" }> {
	const file = uploadFile(root, id);
	if (!file) return { state: "invalid", reason: "not an upload id" };
	for (const dir of [root, join(file, "..")]) {
		const problem = dirProblem(dir);
		if (problem === "missing") return { state: "missing" };
		if (problem) return { state: "invalid", reason: `${dir}: ${problem}` };
	}
	let fd: number;
	try {
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" ? { state: "missing" } : { state: "invalid", reason: code === "ELOOP" ? "it is a symlink" : (error as Error).message };
	}
	const stat = fstatSync(fd);
	const refuse = (reason: string) => { closeSync(fd); return { state: "invalid" as const, reason }; };
	if (!stat.isFile()) return refuse("not a regular file");
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return refuse(`owned by uid ${stat.uid}`);
	if (stat.size > UPLOAD_MAX_BYTES) return refuse(`larger than ${UPLOAD_MAX_BYTES} bytes`);
	if (now.getTime() - stat.mtimeMs > UPLOAD_MAX_AGE_MS) {
		closeSync(fd);
		unlinkSync(file);
		return { state: "missing" };
	}
	const ext = id.slice(id.lastIndexOf(".") + 1) as ImageExt;
	return { state: "ok", fd, path: file, size: stat.size, mime: EXT_MIME[ext], expires_at: expiresAt(stat.mtimeMs) };
}

/** Whether an upload exists and how big it is, without reading it. */
export function statUpload(root: string, id: string, now: Date): UploadStat {
	const opened = openUpload(root, id, now);
	if (opened.state !== "ok") return opened;
	closeSync(opened.fd);
	const { fd: _fd, ...stat } = opened;
	return stat;
}

/** An upload's bytes, re-sniffed: bytes that are not what the id's extension says are invalid, never served. */
export function readUpload(root: string, id: string, now: Date): (UploadStat & { state: "ok"; bytes: Buffer }) | Exclude<UploadStat, { state: "ok" }> {
	const opened = openUpload(root, id, now);
	if (opened.state !== "ok") return opened;
	const { fd, ...stat } = opened;
	const bytes = Buffer.alloc(stat.size);
	try {
		let at = 0;
		while (at < bytes.length) {
			const got = readSync(fd, bytes, at, bytes.length - at, at);
			if (got === 0) break;
			at += got;
		}
		if (at !== bytes.length) return { state: "invalid", reason: "file changed while it was read" };
	} finally {
		closeSync(fd);
	}
	const sniffed = sniffImage(bytes);
	if (!("mime" in sniffed) || sniffed.mime !== stat.mime) return { state: "invalid", reason: "its bytes do not match its extension" };
	return { ...stat, bytes };
}
