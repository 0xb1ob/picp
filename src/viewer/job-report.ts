/**
 * Job reports: `state/artifacts/<id>/report.md` as text for the app's report page, the images it embeds from that
 * same dir, and the newest reports for the Reports page. Every read resolves symlinks and stays inside the job's dir.
 */
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import type { JobReportItem, JobReportResponse } from "./api-types.ts";
import { artifactSegments, REPORT_IMAGE_TYPES } from "./report-paths.ts";
import { isSafeId, type ViewerState } from "./sessions.ts";

export const REPORT_MAX_BYTES = 1024 * 1024;
export const REPORT_IMAGE_MAX_BYTES = 16 * 1024 * 1024;
export const JOB_REPORTS_LISTED = 50;

/** `state/artifacts/<id>` resolved; undefined when absent or when the job dir is a symlink (it would move the root). */
function artifactDir(state: ViewerState, id: string): string | undefined {
	if (!isSafeId(id)) return undefined;
	try {
		const dir = join(realpathSync(join(state.stateDir, "artifacts")), id);
		return realpathSync(dir) === dir ? dir : undefined;
	} catch {
		return undefined;
	}
}

function inside(dir: string, segments: string[]): string | undefined {
	try {
		const real = realpathSync(join(dir, ...segments));
		return real.startsWith(`${dir}${sep}`) && statSync(real).isFile() ? real : undefined;
	} catch {
		return undefined;
	}
}

function readHead(file: string, max: number): { text: string; size: number } {
	const fd = openSync(file, "r");
	try {
		const size = statSync(file).size;
		const buffer = Buffer.alloc(Math.min(size, max));
		const read = readSync(fd, buffer, 0, buffer.length, 0);
		// A cut mid-character decodes to U+FFFD at the end; drop it rather than show it.
		return { text: buffer.subarray(0, read).toString("utf8").replace(/\uFFFD$/, ""), size };
	} finally {
		closeSync(fd);
	}
}

const titleOf = (text: string, id: string): string => /^#{1,2}[ \t]+(.+)$/m.exec(text)?.[1]?.trim() || id;

export const reportFile = (state: ViewerState, id: string): string | undefined => {
	const dir = artifactDir(state, id);
	return dir ? inside(dir, ["report.md"]) : undefined;
};

/** The report page's data, or undefined (404) when the job has no report.md. */
export function jobReport(state: ViewerState, id: string, now = Date.now()): JobReportResponse | undefined {
	const file = reportFile(state, id);
	if (!file) return undefined;
	try {
		const { text, size } = readHead(file, REPORT_MAX_BYTES);
		return { generated_at: new Date(now).toISOString(), job_id: id, title: titleOf(text, id), text, bytes: size, truncated: size > REPORT_MAX_BYTES, modified_at: statSync(file).mtime.toISOString() };
	} catch {
		return undefined;
	}
}

/** One embedded image from the job's artifact dir; undefined (404) for any other type, a refused path or a large file. */
export function reportImage(state: ViewerState, id: string, encoded: string): { body: Buffer; type: string } | undefined {
	let rel: string;
	try {
		rel = encoded.split("/").map(decodeURIComponent).join("/");
	} catch {
		return undefined;
	}
	const dir = artifactDir(state, id), segments = artifactSegments(rel);
	const ext = segments?.at(-1)?.split(".").pop()?.toLowerCase() ?? "";
	const type = Object.hasOwn(REPORT_IMAGE_TYPES, ext) ? REPORT_IMAGE_TYPES[ext] : undefined;
	const file = dir && segments && type ? inside(dir, segments) : undefined;
	if (!file || !type) return undefined;
	try {
		const { size } = statSync(file);
		if (size > REPORT_IMAGE_MAX_BYTES) return undefined;
		const body = Buffer.alloc(size);
		const fd = openSync(file, "r");
		try {
			readSync(fd, body, 0, size, 0);
		} finally {
			closeSync(fd);
		}
		return { body, type };
	} catch {
		return undefined;
	}
}

/** The newest job reports by modification time, each titled by its first `#`/`##` heading (else the job id). */
export function jobReports(state: ViewerState, limit = JOB_REPORTS_LISTED): JobReportItem[] {
	let names: string[];
	try {
		names = readdirSync(join(state.stateDir, "artifacts"), { withFileTypes: true }).filter((d) => d.isDirectory() && isSafeId(d.name)).map((d) => d.name);
	} catch {
		return [];
	}
	const found = names.flatMap((id) => {
		const file = reportFile(state, id);
		try {
			return file ? [{ id, file, mtime: statSync(file).mtimeMs }] : [];
		} catch {
			return [];
		}
	});
	return found.sort((a, b) => b.mtime - a.mtime || a.id.localeCompare(b.id)).slice(0, limit).flatMap(({ id, file, mtime }) => {
		try {
			return [{ job_id: id, title: titleOf(readHead(file, 4096).text, id), modified_at: new Date(mtime).toISOString(), href: `#report/${id}` }];
		} catch {
			return [];
		}
	});
}
