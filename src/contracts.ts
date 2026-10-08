/**
 * pi-command-post — binding wire contracts.
 *
 * Every later task implements against this file. Prose lives in
 * docs/contracts.md; where the two disagree, THIS FILE WINS (policy is code).
 *
 * Rules of the house:
 *  - Enums use StringEnum (Google-compatible) so worker-facing tool schemas
 *    survive every provider.
 *  - Objects are closed (`additionalProperties: false`) unless a comment says
 *    why they are open. Unknown fields are a contract violation, not a hint.
 *  - Everything that a model can author is validated with cross-field policy,
 *    not just shape (see `validateEnvelope`).
 *  - Path helpers fail closed on ids that are not path-safe.
 *  - Layout: one module per contract under src/contracts/; this file only re-exports them (import from here).
 *    src/contracts/internal.ts is not re-exported. Changing a contract updates tests/golden/contracts-exports.txt.
 */

export * from "./contracts/core.ts";
export * from "./contracts/envelope.ts";
export * from "./contracts/limits.ts";
export * from "./contracts/routing.ts";
export * from "./contracts/fleet.ts";
export * from "./contracts/questions.ts";
export * from "./contracts/jobs.ts";
export * from "./contracts/integration.ts";
export * from "./contracts/dispatch-queue.ts";
export * from "./contracts/cadence.ts";
export * from "./contracts/reviews.ts";
export * from "./contracts/escalations.ts";
export * from "./contracts/mandates.ts";
export * from "./contracts/pipeline.ts";
export * from "./contracts/awaiting.ts";
export * from "./contracts/wakeups.ts";
export * from "./contracts/runs.ts";
export * from "./contracts/workers.ts";
export * from "./contracts/status.ts";
export * from "./contracts/modes.ts";
export * from "./contracts/layout.ts";
export * from "./contracts/projects.ts";
export * from "./contracts/trackers.ts";
export * from "./contracts/settings.ts";
