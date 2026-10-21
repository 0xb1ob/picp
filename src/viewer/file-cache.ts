import { realpathSync, statSync, type Stats } from "node:fs";

const identity = (s: Stats) => `${s.dev}:${s.ino}:${s.mtimeMs}:${s.ctimeMs}:${s.size}`;

let scope: Map<string, string | {error: unknown}> | undefined;
let memo: Map<string, unknown> | undefined;
/** Run one synchronous read-only view with each cached file stat'ed once: one snapshot, fewer syscalls. */
export function statScope<T>(view: () => T): T {
 if (scope) return view();
 scope = new Map(); memo = new Map();
 try { return view(); } finally { scope = undefined; memo = undefined; }
}
/** `compute()` once per `statScope` and `key`, for a pure read one view repeats; outside a scope, every call. */
export function scoped<T>(key: string, compute: () => T): T {
 if (!memo) return compute();
 if (memo.has(key)) return memo.get(key) as T;
 const value = compute(); memo.set(key, value);
 return value;
}
/** `realpathSync.native`, resolved once per `statScope`: for a root that every job's path is checked against. */
export const scopedRealpath = (path: string): string => scoped(`realpath|${path}`, () => realpathSync.native(path));

/**
 * Cache source reads, never time-dependent projections. Failed reads evict old values.
 * A directory caches like a file: adding, removing or renaming an entry moves its mtime.
 */
export function fileCache<T>(read: (file: string) => T, retainedBytes?: (value: T) => number): (file: string) => T {
 const entries = new Map<string, {identity: string; value: T; bytes: number}>();
 let bytes = 0;
 const drop = (file: string) => { bytes -= entries.get(file)?.bytes ?? 0; entries.delete(file); };
 return file => {
  const seen = scope?.get(file);
  if (typeof seen === "object") throw seen.error;
  try {
   const prior = entries.get(file);
   if (seen !== undefined && prior?.identity === seen) return prior.value;
   let stat: Stats;
   try { stat = statSync(file); } catch (error) { scope?.set(file, {error}); throw error; }
   const key = identity(stat); scope?.set(file, key);
   if (prior?.identity === key) return prior.value;
   drop(file);
   const value = read(file);
   // Each entry also pays a fixed overhead, so the byte bound caps entry count without a fixed limit
   // that a home with thousands of runs (several small files each) would thrash.
   const size = (retainedBytes ? retainedBytes(value) : stat.size) + 256;
   // Prefix readers charge only retained records, not the entire journal on disk.
   if ((stat.isFile() || stat.isDirectory()) && size <= 32 * 1024 * 1024 && identity(statSync(file)) === key) {
    while (bytes + size > 32 * 1024 * 1024) drop(entries.keys().next().value!);
    entries.set(file, {identity:key, value, bytes:size}); bytes += size;
   }
   return value;
  } catch (error) { drop(file); throw error; }
 };
}
