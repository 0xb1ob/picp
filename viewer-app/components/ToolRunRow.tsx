import type { ComponentChild, ComponentChildren } from "preact";

/**
 * One controlled, collapsible row for a run of tool calls (Sessions and Job detail): marker, count, optional detail.
 * `solid` is the Job detail's bordered look; the default a borderless line; `steps` the Sessions pill (StepsRow).
 */
export function ToolRunRow({count, detail, title, open, onToggle, solid = false, steps = false, notice, children}: {count: number; detail?: string | null; title?: string | undefined; open: boolean; onToggle?: () => void; solid?: boolean; steps?: boolean; notice?: ComponentChild; children?: ComponentChildren}) {
 if (steps) return <StepsRow count={count} detail={detail} title={title} open={open} onToggle={onToggle} notice={notice}>{children}</StepsRow>;
 return <div class={solid ? "session-tool-run tool-run-solid" : "session-tool-run"}>
  <button type="button" class="session-tools" aria-expanded={open} onClick={onToggle}><span aria-hidden="true">{open ? "▾" : "▸"}</span> {count} tool call{count === 1 ? "" : "s"}{detail && <small> — {detail}</small>}</button>
  {open && children}
 </div>;
}

/**
 * "≡ N steps · detail ▸" over one card. `notice` stays mounted, with its own toggle, open or closed;
 * without `onToggle` (Tools on) there is no pill. `title`: the full id a compact `detail` abbreviates.
 */
function StepsRow({count, detail, title, open, onToggle, notice, children}: {count: number; detail?: string | null; title?: string | undefined; open: boolean; onToggle?: () => void; notice?: ComponentChild; children?: ComponentChildren}) {
 return <div class={open ? "session-tool-run session-steps session-steps-open" : "session-tool-run session-steps"}>
  {onToggle && <button type="button" class="session-tools" aria-expanded={open} title={title} onClick={onToggle}><span class="session-steps-face"><span aria-hidden="true">≡</span> {count} step{count === 1 ? "" : "s"}{detail && <small> · {detail}</small>}<span aria-hidden="true">{open ? " ▾" : " ▸"}</span></span></button>}
  {(notice || open) && <div class="session-steps-card">{notice}{open && children}</div>}
 </div>;
}
