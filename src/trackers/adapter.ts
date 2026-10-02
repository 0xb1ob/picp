/** The tracker adapter contract (B2). Only beads is implemented; github is refused visibly until B6. */
import type { TrackerAdapterName } from "../contracts.ts";
import { beadsAdapter, type BrRunner } from "./beads.ts";

export class TrackerError extends Error {}

export interface TrackerItem {
	id: string;
	title: string;
	description: string;
	status: string;
	issue_type: string;
	labels: string[];
}

export type TrackerGet = { status: "found"; item: TrackerItem } | { status: "missing" } | { status: "error"; message: string };

export interface TrackerAdapter {
	name: TrackerAdapterName;
	/** Validate an endpoint without writing anything; returns the canonical endpoint to store. */
	probe(endpoint: string): Promise<string>;
	get(endpoint: string, id: string): Promise<TrackerGet>;
	/** Ready items; `parent` narrows to that epic's direct children (B4). */
	listReady(endpoint: string, options?: { parent?: string }): Promise<TrackerItem[]>;
}

/** One write-back outcome (B5): `already` is idempotent success; `ambiguous` and `refused` are held, never retried blind. */
export type TrackerWrite = { status: "applied" } | { status: "already" } | { status: "ambiguous" | "retryable" | "refused"; message: string };

/** Write-back (B5): close only via read-back, comment deduplicated by a marker in its text. */
export interface TrackerWriter {
	close(endpoint: string, id: string, reason: string): Promise<TrackerWrite>;
	comment(endpoint: string, id: string, text: string, marker: string): Promise<TrackerWrite>;
}

export const notImplemented = (adapter: string): string => `${adapter}: adapter not implemented (B6)`;

export function adapterFor(name: TrackerAdapterName, deps: { run?: BrRunner } = {}): TrackerAdapter & TrackerWriter {
	if (name === "beads") return beadsAdapter(deps.run);
	throw new TrackerError(notImplemented(name));
}
