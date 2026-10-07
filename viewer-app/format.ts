export const count = (value: number | null): string => value === null ? "-" : String(value);
export const amount = (value: number | null): string => value === null ? "-" : Intl.NumberFormat("en",{notation:"compact",maximumFractionDigits:2}).format(value);
export const money = (value: number | null): string => value === null ? "-" : `$${value.toFixed(2)}`;
export const elapsed = (seconds: number | null): string => seconds === null ? "-" : seconds < 3600 ? `${Math.floor(seconds/60)}m` : `${Math.floor(seconds/3600)}h ${Math.floor(seconds%3600/60)}m`;
// No timeZone option: every time is shown in the browser's own zone, never the server's.
export function time(value: string, seconds = false): string {
 return new Intl.DateTimeFormat("en-GB", {hour:"2-digit",minute:"2-digit",...(seconds ? {second:"2-digit"} : {})}).format(new Date(value));
}
export function observedTime(value: string): string {
 return new Intl.DateTimeFormat("en-GB",{dateStyle:"medium",timeStyle:"short"}).format(new Date(value));
}
/** Short zone name in the browser's own zone, e.g. `ICT`. Empty when the runtime names none. */
export function zone(at: Date): string {
 return new Intl.DateTimeFormat(undefined,{timeZoneName:"short"}).formatToParts(at).find(p => p.type === "timeZoneName")?.value ?? "";
}
/** The page-corner clock: local `HH:MM` and the short zone name, e.g. `12:41 ICT`. */
export function clock(at: Date): string {
 const name = zone(at);
 return name ? `${time(at.toISOString())} ${name}` : time(at.toISOString());
}
/** Local time plus zone for an ISO timestamp. `seconds` adds `:SS` (the desktop page header's full updated time, its title). */
export function stamp(iso: string, seconds = false): string {
 const name = zone(new Date(iso));
 const clockTime = time(iso, seconds);
 return name ? `${clockTime} ${name}` : clockTime;
}
/** Seven-character sha, or null when there is none. */
export function shortSha(sha: string | null): string | null {
 return sha ? sha.slice(0, 7) : null;
}
/** `#<last path segment>` of a PR url, or null. */
export function prNumber(url: string | null): string | null {
 if (!url) return null;
 const segment = url.split("/").filter(Boolean).at(-1);
 return segment ? `#${segment}` : null;
}
/** List phase label. Fleet `waiting` with no live run reads "no run status"; every other phase is unchanged. */
export function phaseText(phase: string): string {
 return phase === "waiting" ? "no run status" : phase;
}
export const percent = (value: number, max: number): number => Math.min(100,Math.max(0,max > 0 ? value/max*100 : 0));
