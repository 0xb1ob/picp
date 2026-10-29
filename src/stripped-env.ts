/** Parent-session facts a worker must not inherit. Leaf module: tests/harness/hermetic-env.ts preloads it cheaply. */
export const STRIPPED_ENV_KEYS: readonly string[] = Object.freeze([
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_MODEL",
	"PI_PROVIDER",
	"PI_REASONING_LEVEL",
]);
