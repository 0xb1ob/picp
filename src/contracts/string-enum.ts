import { type TUnsafe, Type } from "typebox";

/**
 * A Google-compatible `{ type: "string", enum }` TypeBox schema; emits what pi-ai's StringEnum emitted through 1.4.0.
 * pi-ai 1.5 retyped its own as a pi-schema `Schema`, which `Static<>` of a TypeBox object cannot read.
 */
export function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}
