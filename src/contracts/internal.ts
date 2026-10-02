/** Type helpers shared by the contract modules. Deliberately NOT re-exported by src/contracts.ts. */

/**
 * Enum discipline: the const array is the single source, the literal union is
 * the TypeScript type, and StringEnum builds the JSON Schema. `Static<>` of a
 * StringEnum widens to `string`, so enum-typed fields are re-narrowed with
 * `Narrow<>` below wherever they appear in a persisted shape.
 */
export type Narrow<T, K extends keyof T, V> = Omit<T, K> & { [P in K]: V };
/** Replace the enum-typed fields of a Static<> shape with literal unions. */
export type Replace<T, R> = Omit<T, keyof R> & R;
