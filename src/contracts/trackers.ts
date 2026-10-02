/** Tracker connections — data/trackers.json — and a job's tracker link (B2). Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IsoTimestampSchema, PROJECT_NAME_PATTERN, validate, type ValidationResult } from "./core.ts";
import { MandateIdSchema } from "./mandates.ts";

/** `github` is admitted by the contract now; its adapter is B6 and refused visibly until then. */
export const TRACKER_ADAPTERS = ["beads", "github"] as const;
export type TrackerAdapterName = (typeof TRACKER_ADAPTERS)[number];
export const TrackerAdapterSchema = StringEnum([...TRACKER_ADAPTERS]);

export const TRACKER_CONNECTION_ID_PATTERN = "^[a-z0-9][a-z0-9._-]{0,63}$";
export const TRACKER_ITEM_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$";
const GITHUB_ENDPOINT_RE = /^(?:[A-Za-z0-9.-]+\/)?[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * One operator-configured connection. A disconnect keeps the record as a
 * tombstone (`status: disconnected`), so a reused id stays bound to its
 * endpoint and jobs linked to it keep a resolvable link.
 */
export const TrackerConnectionSchema = Type.Object(
	{
		id: Type.String({ pattern: TRACKER_CONNECTION_ID_PATTERN }),
		project: Type.String({ pattern: PROJECT_NAME_PATTERN }),
		adapter: TrackerAdapterSchema,
		/** beads: the realpath of the `.db` file; github: `[host/]owner/repo`. */
		endpoint: Type.String({ minLength: 1, maxLength: 1000, pattern: "^[^\\r\\n]+$" }),
		intake_enabled: Type.Boolean(),
		write_enabled: Type.Boolean(),
		status: StringEnum(["active", "disconnected"]),
		connected_at: IsoTimestampSchema,
		disconnected_at: Type.Optional(IsoTimestampSchema),
	},
	{ additionalProperties: false },
);
export type TrackerConnection = Omit<Static<typeof TrackerConnectionSchema>, "adapter" | "status"> & {
	adapter: TrackerAdapterName;
	status: "active" | "disconnected";
};

export const TrackersFileSchema = Type.Object(
	{
		schema_version: Type.Integer({ minimum: 1 }),
		connections: Type.Array(TrackerConnectionSchema),
	},
	{ additionalProperties: false },
);
export type TrackersFile = { schema_version: number; connections: TrackerConnection[] };

/** Shape plus the cross-record rules: unique ids, one active connection per project and per endpoint. */
export function validateTrackersFile(value: unknown): ValidationResult<TrackersFile> {
	const shape = validate<TrackersFile>(TrackersFileSchema, value);
	if (!shape.ok) return shape;
	const errors: string[] = [];
	const ids = new Set<string>();
	const projects = new Map<string, string>();
	const endpoints = new Map<string, string>();
	for (const connection of shape.value.connections) {
		if (ids.has(connection.id)) errors.push(`/connections: duplicate id "${connection.id}"`);
		ids.add(connection.id);
		if (connection.adapter === "beads" && !connection.endpoint.startsWith("/")) {
			errors.push(`/connections/${connection.id}: a beads endpoint must be an absolute path to its database`);
		}
		if (connection.adapter === "github" && !GITHUB_ENDPOINT_RE.test(connection.endpoint)) {
			errors.push(`/connections/${connection.id}: a github endpoint must be [host/]owner/repo`);
		}
		if ((connection.disconnected_at !== undefined) !== (connection.status === "disconnected")) {
			errors.push(`/connections/${connection.id}: disconnected_at is present iff status is disconnected`);
		}
		if (connection.status !== "active") continue;
		const project = projects.get(connection.project);
		if (project) errors.push(`/connections/${connection.id}: project ${connection.project} already has active connection ${project}`);
		projects.set(connection.project, connection.id);
		const key = `${connection.adapter}\u0000${connection.endpoint}`;
		const endpoint = endpoints.get(key);
		if (endpoint) errors.push(`/connections/${connection.id}: endpoint ${connection.endpoint} is already held by active connection ${endpoint}`);
		endpoints.set(key, connection.id);
	}
	return errors.length === 0 ? shape : { ok: false, errors };
}

/** A job's stable tracker identity: `(connection_id, item_id)` is unique across the whole ledger history. */
export const TrackerLinkSchema = Type.Object(
	{
		connection_id: Type.String({ pattern: TRACKER_CONNECTION_ID_PATTERN }),
		item_id: Type.String({ pattern: TRACKER_ITEM_ID_PATTERN }),
		linked_at: IsoTimestampSchema,
		/** Written by B4 import. */
		mandate_id: Type.Optional(MandateIdSchema),
		/** Written by B4 import: sha256 of the frozen task text. */
		task_sha256: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
	},
	{ additionalProperties: false },
);
export type TrackerLink = Static<typeof TrackerLinkSchema>;
