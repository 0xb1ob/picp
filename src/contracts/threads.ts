/** Full match S8: the v1 events of `state/operator/named-threads.jsonl`. Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { THREAD_AT_SOURCE, THREAD_BIND_KINDS, THREAD_ID_SOURCE, THREAD_KEY_ID_MAX, THREAD_NAME_MAX, THREADS_VERSION } from "./thread-limits.ts";

export const NAMED_THREADS_VERSION = THREADS_VERSION;
const ThreadIdSchema = Type.String({ pattern: `^${THREAD_ID_SOURCE}$` });
const KeyPartSchema = Type.String({ minLength: 1, maxLength: THREAD_KEY_ID_MAX });
// toISOString() always carries milliseconds, which core's IsoTimestampSchema does not admit.
const AtSchema = Type.String({ pattern: `^${THREAD_AT_SOURCE}$` });

/** `create` and `rename`, one per owner request; `request_id` is the dashboard client_id that makes a retry replay. */
export const NamedThreadWriteEventSchema = Type.Object(
	{
		v: Type.Literal(THREADS_VERSION),
		type: StringEnum(["create", "rename"]),
		at: AtSchema,
		request_id: Type.String({ pattern: "^dc-\\d{14}-[0-9a-f]{8}$" }),
		thread_id: ThreadIdSchema,
		name: Type.String({ minLength: 1, maxLength: THREAD_NAME_MAX }),
		peer: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
	},
	{ additionalProperties: false },
);
export type NamedThreadWriteEvent = Static<typeof NamedThreadWriteEventSchema>;

/** A typed membership key; a key is bound once and never moves (same thread again is a no-op, another is refused). */
export const ThreadBindKeySchema = Type.Object(
	{ kind: StringEnum([...THREAD_BIND_KINDS]), id: KeyPartSchema, session_id: Type.Optional(KeyPartSchema) },
	{ additionalProperties: false },
);

/** `bind`: `thread_id` null is an explicit No thread. */
export const NamedThreadBindEventSchema = Type.Object(
	{ v: Type.Literal(THREADS_VERSION), type: Type.Literal("bind"), at: AtSchema, key: ThreadBindKeySchema, thread_id: Type.Union([ThreadIdSchema, Type.Null()]) },
	{ additionalProperties: false },
);
export type NamedThreadBindEvent = Static<typeof NamedThreadBindEventSchema>;

export const NamedThreadEventSchema = Type.Union([NamedThreadWriteEventSchema, NamedThreadBindEventSchema]);
export type NamedThreadEvent = Static<typeof NamedThreadEventSchema>;
