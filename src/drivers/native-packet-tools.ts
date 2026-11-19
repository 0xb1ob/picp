/**
 * C6: a Codex reviewer's `read`, `grep` and `find`, served by picp over its review packet; `node:` only. Every path is
 * checked by realpath against the packet, a symlink is never followed, and `grep` matches literal text, never a regex.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export const PACKET_TOOL_NAMES = ["read", "grep", "find"] as const;

export interface PacketTool {
	name: string;
	description: string;
	inputSchema: unknown;
	run(args: unknown): { text: string; isError: boolean };
}

const MAX_BYTES = 50 * 1024;
const MAX_FILES = 5_000;
const LINE_CHARS = 500;
const int = { type: "integer", minimum: 1 };

/** Cuts at 50 KiB and says so. */
function cap(text: string): string {
	const bytes = Buffer.from(text, "utf8");
	return bytes.length <= MAX_BYTES ? text : `${bytes.subarray(0, MAX_BYTES).toString("utf8")}\n[output cut at 50 KiB]`;
}

const fail = (text: string) => ({ text, isError: true });
const lines = (body: string): string[] => {
	const all = body.split("\n");
	if (all.at(-1) === "") all.pop();
	return all;
};
const optionalInt = (value: unknown): boolean => value === undefined || (Number.isInteger(value) && (value as number) >= 1);

/** A glob as a regex: `**` across segments, `*` within one, `?` one character. */
function globRegex(glob: string): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i] as string;
		if (c === "*" && glob[i + 1] === "*") {
			out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
			i += glob[i + 2] === "/" ? 2 : 1;
		} else if (c === "*") out += "[^/]*";
		else if (c === "?") out += "[^/]";
		else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
}

export function packetTools(root: string): PacketTool[] {
	const base = (): string => realpathSync(root);
	/** The realpath of `path` inside the packet, or a refusal text. */
	const inside = (path: string): { real: string } | { refusal: string } => {
		let real: string;
		try {
			real = realpathSync(resolve(root, path));
		} catch {
			return { refusal: `No such file or directory in the review packet: ${path}` };
		}
		const rel = relative(base(), real);
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? { real } : { refusal: `Refused: ${path} is outside the review packet.` };
	};
	/** Regular files under `dir` (lstat: a symlink is never followed), at most MAX_FILES. */
	const files = (dir: string): string[] => {
		const found: string[] = [];
		const walk = (at: string) => {
			for (const name of readdirSync(at).sort()) {
				if (found.length >= MAX_FILES) return;
				const path = join(at, name);
				const stat = lstatSync(path);
				if (stat.isDirectory()) walk(path);
				else if (stat.isFile()) found.push(path);
			}
		};
		if (lstatSync(dir).isDirectory()) walk(dir);
		else if (lstatSync(dir).isFile()) found.push(dir);
		return found;
	};
	const rel = (path: string): string => relative(base(), path);
	const record = (args: unknown): Record<string, unknown> => (args !== null && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {});

	const read: PacketTool = {
		name: "read",
		description: "Read a file of the review packet (your working directory): `path`, then optional 1-based `offset` and `limit` lines.",
		inputSchema: { type: "object", properties: { path: { type: "string" }, offset: int, limit: int }, required: ["path"], additionalProperties: false },
		run(args) {
			const { path, offset, limit } = record(args);
			if (typeof path !== "string" || path === "" || !optionalInt(offset) || !optionalInt(limit)) return fail("Refused: read needs a string path and integer offset and limit of at least 1.");
			const at = inside(path);
			if ("refusal" in at) return fail(at.refusal);
			if (!lstatSync(at.real).isFile()) return fail(`${path} is not a regular file.`);
			const all = lines(readFileSync(at.real, "utf8"));
			const start = ((offset as number | undefined) ?? 1) - 1;
			if (start > 0 && start >= all.length) return fail(`${path} has ${all.length} lines; offset ${start + 1} is past its end.`);
			const end = Math.min(all.length, start + ((limit as number | undefined) ?? 2_000));
			const body = all.slice(start, end).join("\n");
			const cut = start > 0 || end < all.length ? `\n[lines ${start + 1}-${end} of ${all.length}; continue with offset ${end + 1}]` : "";
			return { text: cap(`${body}${cut}`), isError: false };
		},
	};

	const grep: PacketTool = {
		name: "grep",
		description: "Search the review packet for literal text, not a regular expression: `pattern`, optional `path` (a file or dir), `ignoreCase`, `limit` matches.",
		inputSchema: {
			type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, ignoreCase: { type: "boolean" }, limit: int },
			required: ["pattern"], additionalProperties: false,
		},
		run(args) {
			const { pattern, path, ignoreCase, limit } = record(args);
			if (typeof pattern !== "string" || pattern === "" || (path !== undefined && typeof path !== "string") || (ignoreCase !== undefined && typeof ignoreCase !== "boolean") || !optionalInt(limit)) {
				return fail("Refused: grep needs a string pattern, an optional string path, a boolean ignoreCase and an integer limit of at least 1.");
			}
			const at = inside((path as string | undefined) ?? ".");
			if ("refusal" in at) return fail(at.refusal);
			const max = (limit as number | undefined) ?? 100;
			const needle = ignoreCase === true ? pattern.toLowerCase() : pattern;
			const hits: string[] = [];
			for (const file of files(at.real)) {
				const body = readFileSync(file, "utf8");
				if (body.includes("\0")) continue;
				for (const [i, line] of lines(body).entries()) {
					if (!(ignoreCase === true ? line.toLowerCase() : line).includes(needle)) continue;
					if (hits.length >= max) return { text: cap(`${hits.join("\n")}\n[stopped at ${max} matches; narrow the pattern or the path]`), isError: false };
					hits.push(`${rel(file)}:${i + 1}: ${line.slice(0, LINE_CHARS)}`);
				}
			}
			return { text: hits.length === 0 ? "No matches." : cap(hits.join("\n")), isError: false };
		},
	};

	const find: PacketTool = {
		name: "find",
		description: "List the review packet's files as relative paths: optional glob `pattern` (`*`, `**`, `?`), optional `path`, `limit`.",
		inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, limit: int }, additionalProperties: false },
		run(args) {
			const { pattern, path, limit } = record(args);
			if ((pattern !== undefined && typeof pattern !== "string") || (path !== undefined && typeof path !== "string") || !optionalInt(limit)) {
				return fail("Refused: find needs an optional string pattern and path and an integer limit of at least 1.");
			}
			const at = inside((path as string | undefined) ?? ".");
			if ("refusal" in at) return fail(at.refusal);
			const glob = pattern === undefined || pattern === "" ? undefined : globRegex(pattern);
			const max = (limit as number | undefined) ?? 1_000;
			const listed = files(at.real).map(rel).filter((each) => glob === undefined || glob.test(each) || glob.test(basename(each)));
			const shown = listed.slice(0, max);
			const cut = listed.length > max ? `\n[${listed.length - max} more not shown; narrow the pattern or the path]` : "";
			return { text: shown.length === 0 ? "No files." : cap(`${shown.join("\n")}${cut}`), isError: false };
		},
	};

	return [read, grep, find];
}
