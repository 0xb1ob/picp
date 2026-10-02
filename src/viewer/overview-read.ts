import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { SourceAvailability } from "./api-types.ts";
import { obj, type Json } from "./sessions.ts";
import { fileCache } from "./file-cache.ts";
export interface Source<T> { availability: SourceAvailability; value: T }
export const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
export const text = (v: unknown): v is string => typeof v === "string" && /\S/.test(v);
export const timestamp = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v) && Number.isFinite(Date.parse(v));
export const nonnegative = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
export function today(value: unknown, now: number): boolean {
 if (!timestamp(value)) return false;
 const date = new Date(value); const current = new Date(now);
 return date.getFullYear() === current.getFullYear() && date.getMonth() === current.getMonth() && date.getDate() === current.getDate();
}
/** Bound before allocation, on the same descriptor; incomplete reads fail closed. */
function readUncached(file: string, max: number): string {
 const fd = openSync(file, "r");
 try {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.size > max) throw new Error("source unavailable");
  const buffer = Buffer.alloc(stat.size);
  if (readSync(fd, buffer, 0, buffer.length, 0) !== stat.size) throw new Error("source changed");
  return buffer.toString("utf8");
 } finally { closeSync(fd); }
}
const cachedText = fileCache((file: string) => readUncached(file, 16 * 1024 * 1024));
export function readBounded(file: string, max = 16 * 1024 * 1024): string {
 return max === 16 * 1024 * 1024 ? cachedText(file) : readUncached(file,max);
}
export function source<T>(read: () => T, empty: T): Source<T> {
 try { return {availability:"ok", value:read()}; }
 catch (error) { return {availability:(error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable", value:empty}; }
}
export function parseObject(text: string): Json | undefined {
 try { return obj(JSON.parse(text)); } catch { return undefined; }
}
export function objectList(file: string, key: string, valid: (item: Json) => boolean): Source<Json[]> {
 return source(() => {
  const value = parseObject(readBounded(file))?.[key];
  if (!Array.isArray(value) || value.some(item => !obj(item) || !valid(item))) throw new Error("invalid source");
  return value as Json[];
 }, []);
}
