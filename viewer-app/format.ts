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
/** The page-corner clock: local `HH:MM` and the short zone name, e.g. `12:41 ICT`. */
export function clock(at: Date): string {
 // The zone name follows the browser locale (en-US shows PDT where en-GB shows GMT-7).
 const zone = new Intl.DateTimeFormat(undefined,{timeZoneName:"short"}).formatToParts(at).find(p => p.type === "timeZoneName")?.value;
 return zone ? `${time(at.toISOString())} ${zone}` : time(at.toISOString());
}
export const percent = (value: number, max: number): number => Math.min(100,Math.max(0,max > 0 ? value/max*100 : 0));
