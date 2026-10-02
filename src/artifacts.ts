/**
 * Artifact store — `state/artifacts/<job-id>/report.md`.
 *
 * A research worker's deliverable is a *file*, not a message. The store owns
 * that file's identity (one canonical report per job, at a path the worker was
 * told before it started) and moves it around by copy, never by read.
 *
 * The rule this module exists to make mechanical is the ported HARD RULE:
 * **the parent never reads artifact bodies.** So this module never reads one
 * either — every operation here is `stat`, `mkdir`, `copyFile` or `rm`. The
 * body's only sanctioned reader is a *worker*, which is why `get()` writes to
 * a file the caller names and returns nothing but metadata.
 *
 * T19 amendment to the ported design: command-post mirrored the body into a
 * `br` comment (`artifact:v1`) because `cmdp teardown` deleted
 * `state/artifacts/<id>`. Here teardown keeps the directory unless the operator
 * asks for cleanup, so the file system *is* the durable store — and mirroring a
 * body into a ledger whose `br show --json` inlines comment bodies would
 * manufacture the exact hazard the T19 guard exists to contain. `add()`
 * therefore registers a file into the store; it never copies a body into br.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ContractError, isInside, isoTimestamp, LAYOUT, paths } from "./contracts.ts";

export class ArtifactError extends Error {}

/** The one canonical file name inside an artifact directory. */
export const ARTIFACT_FILE = "report.md";

export interface ArtifactStoreOptions {
	/** Command post home; the store is `<home>/state/artifacts/`. */
	home: string;
	/**
	 * Optional fact check before an artifact is filed: does this home know the
	 * job at all? Ported from `cmdp artifact add`'s `requireBRIssue` — an
	 * artifact filed against a typo'd id is an artifact nobody will ever find.
	 */
	knowsJob?: (jobId: string) => boolean;
}

export interface ArtifactInfo {
	job_id: string;
	/** Absolute path of the canonical report, whether or not it exists yet. */
	path: string;
	present: boolean;
	bytes: number;
	modified_at?: string;
}

export interface ArtifactAddResult extends ArtifactInfo {
	present: true;
	/** Where it came from. */
	source: string;
	/** False when the file was already the canonical path (the predeclared case). */
	copied: boolean;
}

export interface ArtifactGetResult {
	job_id: string;
	/** Absolute path the body was written to. The body itself never travels. */
	out: string;
	bytes: number;
	source: string;
}

export class ArtifactStore {
	readonly home: string;
	readonly #knowsJob: ((jobId: string) => boolean) | undefined;

	constructor(options: ArtifactStoreOptions) {
		this.home = options.home;
		this.#knowsJob = options.knowsJob;
	}

	/** `<home>/state/artifacts` — the root the context guards protect. */
	root(): string {
		return resolve(this.home, LAYOUT.artifacts);
	}

	dir(jobId: string): string {
		return resolve(this.home, paths.artifactDir(jobId));
	}

	/** Absolute path of the canonical report. Does not touch the disk. */
	file(jobId: string): string {
		return resolve(this.home, paths.artifactFile(jobId));
	}

	/**
	 * `cmdp artifact path`: create the directory and return the path the worker
	 * is told to write. Predeclaring it is what lets the envelope be validated
	 * against a path nobody improvised.
	 */
	path(jobId: string): string {
		const file = this.file(jobId);
		mkdirSync(dirname(file), { recursive: true });
		return file;
	}

	/**
	 * Is this job artifact-bearing? Total: an id that is not even path-safe
	 * carries nothing, and a guard must never throw on hostile input.
	 */
	has(jobId: string): boolean {
		let file: string;
		try {
			file = this.file(jobId);
		} catch (error) {
			if (error instanceof ContractError) return false;
			throw error;
		}
		return existsSync(file) && statSync(file).isFile() && statSync(file).size > 0;
	}

	/** Stat only. Never opens the file. */
	info(jobId: string): ArtifactInfo {
		const file = this.file(jobId);
		if (!existsSync(file)) return { job_id: jobId, path: file, present: false, bytes: 0 };
		const stats = statSync(file);
		if (!stats.isFile()) {
			throw new ArtifactError(`${file} is not a file — the artifact store holds one ${ARTIFACT_FILE} per job`);
		}
		return {
			job_id: jobId,
			path: file,
			present: true,
			bytes: stats.size,
			modified_at: isoTimestamp(stats.mtime),
		};
	}

	/** Every job that currently has a stored artifact. Names only. */
	list(): string[] {
		const root = this.root();
		if (!existsSync(root)) return [];
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && this.has(entry.name))
			.map((entry) => entry.name)
			.sort();
	}

	/**
	 * File a worker's report into the store. Fail-closed on everything that
	 * would make a later `get()` a lie: unknown job, missing file, directory,
	 * empty file.
	 */
	add(jobId: string, source: string, options: { cwd?: string } = {}): ArtifactAddResult {
		const target = this.file(jobId);
		if (this.#knowsJob && !this.#knowsJob(jobId)) {
			throw new ArtifactError(
				`unknown job ${jobId} — dispatch it (or check the id) before filing an artifact; the store is keyed by job id`,
			);
		}
		const from = resolve(options.cwd ?? this.home, stripAt(source));
		if (!existsSync(from)) {
			throw new ArtifactError(`artifact source ${from} does not exist`);
		}
		const stats = statSync(from);
		if (!stats.isFile()) {
			throw new ArtifactError(`artifact source ${from} is not a file`);
		}
		if (stats.size === 0) {
			throw new ArtifactError(`artifact source ${from} is empty — the artifact is the deliverable`);
		}
		if (from === target) {
			// Already the canonical path: the worker wrote where it was told.
			return {
				job_id: jobId,
				path: target,
				present: true,
				bytes: stats.size,
				modified_at: isoTimestamp(stats.mtime),
				source: from,
				copied: false,
			};
		}
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(from, target);
		const stored = statSync(target);
		return {
			job_id: jobId,
			path: target,
			present: true,
			bytes: stored.size,
			modified_at: isoTimestamp(stored.mtime),
			source: from,
			copied: true,
		};
	}

	/**
	 * `cmdp artifact get <id> > tmpfile`, minus the shell redirect that made it
	 * one keystroke away from stdout. The destination is mandatory: there is no
	 * code path in this build that returns an artifact body to a caller.
	 */
	get(jobId: string, out: string, options: { cwd?: string } = {}): ArtifactGetResult {
		const source = this.file(jobId);
		if (!existsSync(source)) {
			throw new ArtifactError(`no artifact for ${jobId} — expected ${source}`);
		}
		const trimmed = stripAt(out).trim();
		if (trimmed.length === 0) {
			throw new ArtifactError(`get ${jobId}: an output file is required — an artifact body is never returned inline`);
		}
		const target = resolve(options.cwd ?? this.home, trimmed);
		if (isInside(target, this.root())) {
			throw new ArtifactError(
				`get ${jobId}: refusing to write into the artifact store (${target}) — name a destination outside ${this.root()}`,
			);
		}
		if (existsSync(target) && statSync(target).isDirectory()) {
			throw new ArtifactError(`get ${jobId}: ${target} is a directory — name the destination file`);
		}
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(source, target);
		return { job_id: jobId, out: target, bytes: statSync(target).size, source };
	}

	/** Drop a job's artifacts (teardown cleanup). Returns whether anything went. */
	remove(jobId: string): boolean {
		const dir = this.dir(jobId);
		if (!existsSync(dir)) return false;
		rmSync(dir, { recursive: true, force: true });
		return true;
	}
}

/** Some models prefix tool path arguments with `@`; built-in tools strip it too. */
function stripAt(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}
