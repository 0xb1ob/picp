/**
 * Tracker connections (B2): at most one active, operator-configured connection
 * per project in `<home>/data/trackers.json`, managed only through
 * `cp_tracker`. A disconnect keeps a tombstone, so an id stays bound to its
 * endpoint and linked jobs keep their link. `projectTracker` is the only way to
 * find a project's beads database; the home's `.beads` is never a candidate.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isInside, isoTimestamp, LAYOUT, SCHEMA_VERSION, TRACKER_CONNECTION_ID_PATTERN, type TrackerAdapterName, type TrackerConnection, validateTrackersFile } from "../contracts.ts";
import { atomicWriteJson, queued } from "../json-store.ts";
import { adapterFor, notImplemented, type TrackerAdapter, TrackerError } from "./adapter.ts";

export function trackersFile(home: string): string {
	return join(home, LAYOUT.data, "trackers.json");
}

function readConnections(file: string): TrackerConnection[] {
	if (!existsSync(file)) return [];
	let raw: unknown;
	try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (error) { throw new TrackerError(`${file} is not valid JSON (${(error as Error).message}); refusing to guess`); }
	const parsed = validateTrackersFile(raw);
	if (!parsed.ok) throw new TrackerError(`${file} violates the trackers contract:\n  ${parsed.errors.join("\n  ")}`);
	return parsed.value.connections;
}

/** The active connection whose endpoint lives under `dir` (an existing directory), if any. Throws on an unreadable trackers file. */
export function activeTrackerUnder(home: string, dir: string): TrackerConnection | undefined {
	const real = realpathSync(dir);
	return readConnections(trackersFile(home)).find((connection) => connection.status === "active" && isInside(connection.endpoint, real));
}

export interface ConnectInput {
	project: string;
	adapter: TrackerAdapterName;
	endpoint: string;
	connection_id?: string;
	intake?: boolean;
	write?: boolean;
}

export interface TrackerStoreOptions {
	home: string;
	/** Throws on an unregistered project (ProjectRegistry.require). */
	registry: { require(name: string): object };
	adapters?: (name: TrackerAdapterName) => TrackerAdapter;
	now?: () => Date;
}

const ID_RE = new RegExp(TRACKER_CONNECTION_ID_PATTERN);

export class TrackerStore {
	readonly file: string;
	readonly #options: TrackerStoreOptions;

	constructor(options: TrackerStoreOptions) {
		this.#options = options;
		this.file = trackersFile(options.home);
	}

	list(): TrackerConnection[] {
		return readConnections(this.file);
	}

	active(project: string): TrackerConnection | undefined {
		return this.list().find((connection) => connection.project === project && connection.status === "active");
	}

	get(id: string): TrackerConnection | undefined {
		return this.list().find((connection) => connection.id === id);
	}

	async connect(input: ConnectInput): Promise<{ connection: TrackerConnection; created: boolean }> {
		this.#options.registry.require(input.project);
		// github is refused before the endpoint is read or anything is written.
		if (input.adapter !== "beads") throw new TrackerError(notImplemented(input.adapter));
		const adapter = (this.#options.adapters ?? ((name) => adapterFor(name)))(input.adapter);
		const id = input.connection_id ?? `${input.project.toLowerCase()}-${input.adapter}`;
		if (!ID_RE.test(id)) throw new TrackerError(`connection id ${JSON.stringify(id)} must match ${TRACKER_CONNECTION_ID_PATTERN}; pass connection_id=<id>`);
		const endpoint = await adapter.probe(input.endpoint);
		const intake = input.intake === true, write = input.write === true;
		return this.#mutate((connections) => {
			const active = connections.find((connection) => connection.project === input.project && connection.status === "active");
			if (active) {
				const same = active.id === id && active.adapter === input.adapter && active.endpoint === endpoint;
				if (same && active.intake_enabled === intake && active.write_enabled === write) return { connection: active, created: false };
				if (same) throw new TrackerError(`${id} is already active with other capabilities; disconnect then connect to change capabilities`);
				throw new TrackerError(`project ${input.project} already has active connection ${active.id} (${active.adapter} ${active.endpoint}); switching trackers is cp_tracker disconnect ${input.project}, then connect`);
			}
			const existing = connections.find((connection) => connection.id === id);
			if (existing && (existing.project !== input.project || existing.adapter !== input.adapter || existing.endpoint !== endpoint)) {
				throw new TrackerError(`connection id ${id} is already bound to ${existing.adapter} ${existing.endpoint} for project ${existing.project}; pass connection_id=<new id>`);
			}
			const holder = connections.find((connection) => connection.status === "active" && connection.adapter === input.adapter && connection.endpoint === endpoint);
			if (holder) throw new TrackerError(`${endpoint} is already held by active connection ${holder.id} (project ${holder.project})`);
			const connected_at = isoTimestamp(this.#now());
			if (existing) {
				Object.assign(existing, { status: "active", intake_enabled: intake, write_enabled: write, connected_at });
				delete existing.disconnected_at;
				return { connection: existing, created: true };
			}
			const connection: TrackerConnection = { id, project: input.project, adapter: input.adapter, endpoint, intake_enabled: intake, write_enabled: write, status: "active", connected_at };
			connections.push(connection);
			return { connection, created: true };
		});
	}

	async disconnect(project: string): Promise<TrackerConnection> {
		return this.#mutate((connections) => {
			const active = connections.find((connection) => connection.project === project && connection.status === "active");
			if (!active) throw new TrackerError(`project ${project} has no active tracker connection`);
			active.status = "disconnected";
			active.disconnected_at = isoTimestamp(this.#now());
			return active;
		});
	}

	#now(): Date {
		return (this.#options.now ?? (() => new Date()))();
	}

	#mutate<T>(fn: (connections: TrackerConnection[]) => T): Promise<T> {
		return queued(this.file, async () => {
			const connections = this.list();
			const out = fn(connections);
			const doc = { schema_version: SCHEMA_VERSION, connections };
			const parsed = validateTrackersFile(doc);
			if (!parsed.ok) throw new TrackerError(`refusing to write an invalid trackers file:\n  ${parsed.errors.join("\n  ")}`);
			atomicWriteJson(this.file, doc);
			return out;
		});
	}
}

const onOff = (value: boolean): string => (value ? "on" : "off");

export function formatTrackers(connections: readonly TrackerConnection[], linked: (id: string) => number): string {
	if (connections.length === 0) return "no tracker connections \u2014 cp_tracker connect project=<name> adapter=beads endpoint=<absolute path to beads.db or its .beads dir>";
	const ordered = [...connections].sort((a, b) => Number(b.status === "active") - Number(a.status === "active") || a.id.localeCompare(b.id));
	return ordered.map((c) => [
		`${c.id} [${c.status}] project=${c.project} adapter=${c.adapter} endpoint=${c.endpoint}`,
		`intake=${onOff(c.intake_enabled)} write=${onOff(c.write_enabled)} linked_jobs=${linked(c.id)}`,
		...(c.adapter === "beads" ? [] : [`\u2014 ${notImplemented(c.adapter)}`]),
	].join(" ")).join("\n");
}

export type ProjectTracker = { adapter: "beads"; db: string; source: "connection" | "clone" } | { adapter: "github"; connection_id: string };

/** Active connection, else `<clone>/.beads/beads.db` when it exists, else none. Never the home's `.beads`. */
export function projectTracker(home: string, project: string, clonePath: () => string): ProjectTracker | undefined {
	const active = readConnections(trackersFile(home)).find((connection) => connection.project === project && connection.status === "active");
	if (active) return active.adapter === "beads" ? { adapter: "beads", db: active.endpoint, source: "connection" } : { adapter: "github", connection_id: active.id };
	let db: string;
	try { db = join(clonePath(), ".beads", "beads.db"); } catch { return undefined; }
	return existsSync(db) ? { adapter: "beads", db, source: "clone" } : undefined;
}

export function projectBeadsDb(home: string, project: string, clonePath: () => string): string | undefined {
	const tracker = projectTracker(home, project, clonePath);
	return tracker?.adapter === "beads" ? tracker.db : undefined;
}
