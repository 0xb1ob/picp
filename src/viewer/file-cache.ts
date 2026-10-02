import { statSync, type Stats } from "node:fs";

const identity = (s: Stats) => `${s.dev}:${s.ino}:${s.mtimeMs}:${s.ctimeMs}:${s.size}`;

/** Cache source reads, never time-dependent projections. Failed reads evict old values. */
export function fileCache<T>(read: (file: string) => T, retainedBytes?: (value: T) => number): (file: string) => T {
 const entries = new Map<string, {identity: string; value: T; bytes: number}>();
 let bytes = 0;
 const drop = (file: string) => { bytes -= entries.get(file)?.bytes ?? 0; entries.delete(file); };
 return file => {
  try {
   const stat = statSync(file); const key = identity(stat);
   const prior = entries.get(file);
   if (prior?.identity === key) return prior.value;
   drop(file);
   const value = read(file);
   const size = retainedBytes ? retainedBytes(value) : stat.size;
   // Prefix readers charge only retained records, not the entire journal on disk.
   if (stat.isFile() && size <= 32 * 1024 * 1024 && identity(statSync(file)) === key) {
    while (entries.size >= 2048 || bytes + size > 32 * 1024 * 1024) drop(entries.keys().next().value!);
    entries.set(file, {identity:key, value, bytes:size}); bytes += size;
   }
   return value;
  } catch (error) { drop(file); throw error; }
 };
}
