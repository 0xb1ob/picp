/**
 * Keyed JSON diff for screen deltas, shared by the server (`sendView`) and the app (`resource.ts`). Pure, no node imports.
 * Invariant: `JSON.stringify(applyDelta(a, diffJson(a, b) ?? {}))` equals `JSON.stringify(b)`, key order included.
 */
type Obj = Record<string, unknown>;
export type Delta =
	| { v: unknown }
	| { set?: Obj; sub?: Record<string, Delta>; del?: string[] }
	| { key: string; put: Obj[]; ids?: string[] };

const KEY_FIELDS = ["id", "job_id", "key"] as const;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const own = (o: Obj, k: string): boolean => Object.hasOwn(o, k);
// defineProperty, not assignment: a JSON `__proto__` key must stay an own property.
const put = (o: Obj, k: string, v: unknown): void => { Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); };

/** Deep equality that also requires the same key order (the serialized bytes match). */
function same(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
	if (!isObj(a) || !isObj(b)) return false;
	const ka = Object.keys(a), kb = Object.keys(b);
	return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same(a[k], b[k]));
}

/** The first key field whose values are unique strings in every element of both arrays, if any. */
function keyField(a: unknown[], b: unknown[]): string | undefined {
	return KEY_FIELDS.find((field) => [a, b].every((list) => {
		const seen = new Set<string>();
		return list.every((x) => isObj(x) && typeof x[field] === "string" && !seen.has(x[field]) && Boolean(seen.add(x[field])));
	}));
}

export function diffJson(a: unknown, b: unknown): Delta | undefined {
	if (same(a, b)) return undefined;
	if (isObj(a) && isObj(b)) {
		const kb = Object.keys(b), surviving = Object.keys(a).filter((k) => own(b, k));
		const compatible = surviving.every((k, i) => kb[i] === k) && kb.slice(surviving.length).every((k) => !own(a, k));
		if (!compatible) return { v: b };
		const set: Obj = {}, sub: Record<string, Delta> = {}, del = Object.keys(a).filter((k) => !own(b, k));
		for (const k of kb) {
			const d = own(a, k) ? diffJson(a[k], b[k]) : { v: b[k] };
			if (d === undefined) continue;
			if ("v" in d) put(set, k, d.v); else put(sub, k, d);
		}
		return { ...(Object.keys(set).length ? { set } : {}), ...(Object.keys(sub).length ? { sub } : {}), ...(del.length ? { del } : {}) };
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		const key = keyField(a, b);
		if (key === undefined) return { v: b };
		const before = new Map((a as Obj[]).map((x) => [x[key] as string, x]));
		const ids = (b as Obj[]).map((x) => x[key] as string);
		const changed = (b as Obj[]).filter((x) => !same(before.get(x[key] as string), x));
		const moved = ids.length !== a.length || ids.some((id, i) => (a[i] as Obj)[key] !== id);
		return { key, put: changed, ...(moved ? { ids } : {}) };
	}
	return { v: b };
}

/** Applies a delta from `diffJson` (or `{}`, "no change"); throws on a delta that does not fit `a`. */
export function applyDelta<T>(a: T, d: Delta | Record<string, never>): T {
	if (!isObj(d)) throw new Error("malformed delta");
	if (own(d, "v")) return (d as { v: T }).v;
	if (own(d, "key")) {
		const { key, put: rows, ids } = d as { key: unknown; put: unknown; ids?: unknown };
		if (!Array.isArray(a) || typeof key !== "string" || !Array.isArray(rows)) throw new Error("malformed array delta");
		const known = new Map<string, unknown>();
		for (const x of a) { if (!isObj(x) || typeof x[key] !== "string") throw new Error("base row has no key"); known.set(x[key], x); }
		const order = ids === undefined ? [...known.keys()] : ids;
		if (!Array.isArray(order)) throw new Error("malformed ids");
		const wanted = new Set(order);
		for (const x of rows) {
			if (!isObj(x) || typeof x[key] !== "string" || !wanted.has(x[key])) throw new Error("unknown key in put");
			known.set(x[key], x);
		}
		return order.map((id) => {
			if (typeof id !== "string" || !known.has(id)) throw new Error(`unknown id ${String(id)}`);
			return known.get(id);
		}) as T;
	}
	const { set = {}, sub = {}, del = [] } = d as { set?: unknown; sub?: unknown; del?: unknown };
	if (!Object.keys(d).length) return a;
	if (!isObj(a) || !isObj(set) || !isObj(sub) || !Array.isArray(del)) throw new Error("object delta on a non-object");
	const out: Obj = {};
	for (const k of Object.keys(a)) {
		if (del.includes(k)) continue;
		put(out, k, own(sub, k) ? applyDelta(a[k], sub[k] as Delta) : own(set, k) ? set[k] : a[k]);
	}
	for (const k of Object.keys(set)) if (!own(a, k)) put(out, k, set[k]);
	for (const k of Object.keys(sub)) if (!own(a, k)) throw new Error(`sub on missing key ${k}`);
	return out as T;
}
