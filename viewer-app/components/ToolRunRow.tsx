import type { ComponentChild, ComponentChildren } from "preact";

/**
 * One collapsible row for a run of consecutive tool calls, shared by Sessions and the Job detail transcript: a ▸/▾ marker,
 * the count label, an optional dimmed detail, and the run's rows only while open. Controlled, so each screen owns its own state.
 * `solid` is the Job detail look (bordered row); the default, a borderless line; `steps`, Sessions' pill (StepsRow).
 */
export function ToolRunRow({count, detail, open, onToggle, solid = false, steps = false, notice, children}: {count: number; detail?: string | null; open: boolean; onToggle?: () => void; solid?: boolean; steps?: boolean; notice?: ComponentChild; children?: ComponentChildren}) {
 if (steps) return <StepsRow count={count} detail={detail} open={open} onToggle={onToggle} notice={notice}>{children}</StepsRow>;
 return <div class={solid ? "session-tool-run tool-run-solid" : "session-tool-run"}>
  <button type="button" class="session-tools" aria-expanded={open} onClick={onToggle}><span aria-hidden="true">{open ? "▾" : "▸"}</span> {count} tool call{count === 1 ? "" : "s"}{detail && <small> — {detail}</small>}</button>
  {open && children}
 </div>;
}

/**
 * "≡ N steps · detail ▸" over one card. `notice` stays mounted, with its own toggle, open or closed;
 * without `onToggle` (Tools on) there is no pill.
 */
function StepsRow({count, detail, open, onToggle, notice, children}: {count: number; detail?: string | null; open: boolean; onToggle?: () => void; notice?: ComponentChild; children?: ComponentChildren}) {
 return <div class={open ? "session-tool-run session-steps session-steps-open" : "session-tool-run session-steps"}>
  {onToggle && <button type="button" class="session-tools" aria-expanded={open} onClick={onToggle}><span class="session-steps-face"><span aria-hidden="true">≡</span> {count} step{count === 1 ? "" : "s"}{detail && <small> · {detail}</small>}<span aria-hidden="true">{open ? " ▾" : " ▸"}</span></span></button>}
  {(notice || open) && <div class="session-steps-card">{notice}{open && children}</div>}
 </div>;
}
