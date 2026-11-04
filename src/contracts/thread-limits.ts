/** Named-thread v1 limits, shared by the schema (./threads.ts), the owner and the viewer's reader; imports nothing. */

export const THREADS_VERSION = 1;
/** Read caps: past either the registry is unavailable, never truncated; the owner refuses an append past one. */
export const THREADS_MAX_BYTES = 1024 * 1024;
export const THREADS_MAX_LINES = 10_000;
/** Names are trimmed, 1–80 characters (code points), no control characters; duplicates are allowed. */
export const THREAD_NAME_MAX = 80;
export const THREAD_ID_SOURCE = "th-[0-9a-f]{16}";
export const THREAD_BIND_KINDS = ["message", "ask", "job", "parent_send"] as const;
export const THREAD_KEY_ID_MAX = 200;
/** S10b joins: rows per thread and list in `GET /api/threads`, newest first; the rest is counted in `omitted`. */
export const THREAD_JOINS_MAX = 100;
export const THREAD_AT_SOURCE = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z";
