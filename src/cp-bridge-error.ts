/** The bridge's refusal type, in its own module so `src/parent-model.ts` needs no import cycle; re-exported by `src/cp-bridge.ts`. */
export class CpBridgeError extends Error {}
