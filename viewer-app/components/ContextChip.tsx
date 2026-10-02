import type { ContextUsage } from "../../src/viewer/api-types.ts";
import { time } from "../format.ts";

const tokens = (n: number): string => Intl.NumberFormat("en",{notation:"compact",maximumFractionDigits:n >= 1e6 ? 1 : 0}).format(n);
/** `ctx 84K / 272K · 31%`, or `context n/a` when tokens or the window are unknown — never 0. */
export function contextText(usage: ContextUsage): string {
 return usage.tokens !== null && usage.window !== null && usage.percent !== null ? `ctx ${tokens(usage.tokens)} / ${tokens(usage.window)} · ${Math.round(usage.percent)}%` : "context n/a";
}
/** The context chip with its bar; `compact` keeps the reason and last compaction in the tooltip only. */
export function ContextChip({usage,compact=false}:{usage:ContextUsage | null | undefined;compact?:boolean}) {
 if (!usage) return null;
 const compacted = usage.last_compact_at ? `compacted ${time(usage.last_compact_at)}` : null;
 const detail = [usage.percent === null ? usage.reason : null,compacted].filter(Boolean).join(" · ");
 const title = [usage.model,usage.percent === null ? usage.reason : null,compacted].filter(Boolean).join(" · ");
 return <span class={`ctx-chip ctx-${usage.level ?? "unknown"}${compact ? " ctx-compact" : ""}`} title={title || undefined}>
  <span class="ctx-text">{contextText(usage)}{!compact && detail && <small> · {detail}</small>}</span>
  {usage.percent !== null && <progress aria-label="Context window used" max="100" value={Math.min(100,usage.percent)}/>}
 </span>;
}
