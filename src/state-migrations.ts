/**
 * One-shot state migrations (spec 2026-09-04 §Migrations, PR 1).
 *
 * The rename `br_id` -> `job_id` changed the key every persisted document and
 * journal under `state/` is written with. This module moves the files that
 * were written before the rename, once, at session start:
 *
 *  - **Documents** (`*.json`) are parsed, the key is renamed wherever it is an
 *    object key (values are never touched), and the file is rewritten
 *    atomically. A document that does not parse is reported and left alone.
 *  - **Journals** (`*.jsonl`) are rewritten line by line the same way; a line
 *    that does not parse is copied byte for byte, because a journal is an
 *    append-only record and losing a line is worse than keeping an old key.
 *  - **Skipped**: `state/sessions/` (pi's own transcripts), anything with
 *    `.bak` in its name, `state/.migrations/`, and every non-JSON file.
 *  - **The marker** `state/.migrations/2026-09-job-id.done` is written when
 *    the sweep completes, and its presence makes every later call a no-op.
 *
 * Doctor reads the same walk to say whether a home still carries the old key.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { type DoctorFinding, LAYOUT } from "./contracts.ts";
import { atomicWriteText } from "./json-store.ts";

export const JOB_ID_MIGRATION_MARKER = "2026-09-job-id.done";
export const LEGACY_JOB_ID_KEY = "br_id";
export const JOB_ID_KEY = "job_id";

export interface SweepDocument {
	file: string;
	action: "renamed" | "unchanged" | "unparseable";
	renamed: number;
}

export interface SweepJournal {
	file: string;
	lines_renamed: number;
	lines_copied: number;
}

export interface SweepReport {
	home: string;
	marker: string;
	already_done: boolean;
	documents: SweepDocument[];
	journals: SweepJournal[];
}

/** Rename `from` to `to` wherever it appears as an object key. Values are never touched. */
export function renameKeyDeep(value: unknown, from: string, to: string): { value: unknown; renamed: number } {
	let renamed = 0;
	const walk = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(walk);
		if (typeof node !== "object" || node === null) return node;
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
			if (key === from) renamed += 1;
			out[key === from ? to : key] = walk(child);
		}
		return out;
	};
	return { value: walk(value), renamed };
}

export function migrationMarkerPath(home: string): string {
	return join(home, LAYOUT.migrationsDir, JOB_ID_MIGRATION_MARKER);
}

const SKIPPED_DIRS = new Set(["sessions", ".migrations"]);

/** Every `.json` document and `.jsonl` journal under `state/` that the sweep may touch. */
export function listSweepTargets(home: string): { documents: string[]; journals: string[] } {
	const documents: string[] = [];
	const journals: string[] = [];
	const root = join(home, LAYOUT.state);
	if (!existsSync(root)) return { documents, journals };
	const visit = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				const top = relative(root, path).split(sep)[0] ?? "";
				if (SKIPPED_DIRS.has(top)) continue;
				visit(path);
				continue;
			}
			if (!entry.isFile()) continue;
			if (entry.name.includes(".bak")) continue;
			if (entry.name.endsWith(".json")) documents.push(path);
			else if (entry.name.endsWith(".jsonl")) journals.push(path);
		}
	};
	visit(root);
	return { documents: documents.sort(), journals: journals.sort() };
}

function sweepDocument(file: string): SweepDocument {
	const text = readFileSync(file, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { file, action: "unparseable", renamed: 0 };
	}
	const { value, renamed } = renameKeyDeep(parsed, LEGACY_JOB_ID_KEY, JOB_ID_KEY);
	if (renamed === 0) return { file, action: "unchanged", renamed: 0 };
	atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`);
	return { file, action: "renamed", renamed };
}

function sweepJournal(file: string): SweepJournal {
	const text = readFileSync(file, "utf8");
	const lines = text.split("\n");
	let linesRenamed = 0;
	let linesCopied = 0;
	const out = lines.map((line, index) => {
		// The split leaves one empty string after a trailing newline; keep it as is.
		if (line.length === 0 && index === lines.length - 1) return line;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			linesCopied += 1;
			return line;
		}
		const { value, renamed } = renameKeyDeep(parsed, LEGACY_JOB_ID_KEY, JOB_ID_KEY);
		if (renamed === 0) return line;
		linesRenamed += 1;
		return JSON.stringify(value);
	});
	if (linesRenamed > 0) atomicWriteText(file, out.join("\n"));
	return { file, lines_renamed: linesRenamed, lines_copied: linesCopied };
}

/**
 * Run the sweep once. Idempotent by the marker: the second call reports
 * `already_done` and touches nothing. Never throws for a file it cannot
 * parse — that is a report line, and the marker is still written, because a
 * sweep that stops at the first odd file would re-run forever.
 */
export function sweepJobIdRename(options: { home: string }): SweepReport {
	const marker = migrationMarkerPath(options.home);
	if (existsSync(marker)) {
		return { home: options.home, marker, already_done: true, documents: [], journals: [] };
	}
	const targets = listSweepTargets(options.home);
	const documents = targets.documents.map(sweepDocument);
	const journals = targets.journals.map(sweepJournal).filter((j) => j.lines_renamed > 0 || j.lines_copied > 0);
	mkdirSync(join(options.home, LAYOUT.migrationsDir), { recursive: true });
	writeFileSync(marker, `${new Date().toISOString()}\n`);
	return { home: options.home, marker, already_done: false, documents, journals };
}

/** One operator-facing block; silent about the boring case. */
export function formatSweep(report: SweepReport): string {
	if (report.already_done) return "";
	const renamed = report.documents.filter((d) => d.action === "renamed");
	const unparseable = report.documents.filter((d) => d.action === "unparseable");
	if (renamed.length === 0 && report.journals.length === 0 && unparseable.length === 0) return "";
	const lines = [
		`state migration: renamed br_id -> job_id in ${renamed.length} document(s) and ${report.journals.length} journal(s) under ${report.home}`,
	];
	for (const doc of unparseable) lines.push(`  ! ${doc.file}: not JSON, left as is`);
	return lines.join("\n");
}

const LEGACY_KEY_RE = /"br_id"\s*:/;

/** Files under state/ (same walk as the sweep) that still carry the old key. */
function legacyFiles(home: string): string[] {
	const targets = listSweepTargets(home);
	return [...targets.documents, ...targets.journals].filter((file) => {
		try {
			return statSync(file).isFile() && LEGACY_KEY_RE.test(readFileSync(file, "utf8"));
		} catch {
			return false;
		}
	});
}

/**
 * Doctor's view. Error when the marker is missing and old keys exist (the
 * next session start fixes it); warn when the marker exists but a file still
 * carries the key (something was restored from a backup after the sweep).
 */
export function jobIdMigrationFinding(home: string): DoctorFinding {
	const marker = migrationMarkerPath(home);
	const legacy = legacyFiles(home);
	if (legacy.length === 0) {
		return { check: "state.job_id_migration", severity: "ok", what: "no state files carry the pre-rename br_id key" };
	}
	const detail = legacy.slice(0, 5).map((file) => relative(home, file)).join(", ") + (legacy.length > 5 ? ", …" : "");
	if (!existsSync(marker)) {
		return {
			check: "state.job_id_migration",
			severity: "error",
			what: `${legacy.length} file(s) still carry "br_id" and the rename sweep has not run`,
			detail,
			fix: "start a pi session in this home: session_start runs the br_id -> job_id sweep once and writes state/.migrations/2026-09-job-id.done",
		};
	}
	return {
		check: "state.job_id_migration",
		severity: "warn",
		what: `${legacy.length} file(s) carry "br_id" although the sweep already ran (restored from a backup?)`,
		detail,
		fix: `remove the marker ${relative(home, marker)} and start a session to sweep again, or fix the files by hand`,
	};
}
