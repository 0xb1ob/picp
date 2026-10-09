import type { ComponentChildren } from "preact";

/**
 * One collapsible row for a run of consecutive tool calls, shared by Sessions and the Job detail transcript: a ▸/▾ marker,
 * the count label, an optional dimmed detail, and the run's rows only while open. Controlled, so each screen owns its own state.
 * `solid` is the Job detail look (bordered row); the default is Sessions' dashed line.
 */
export function ToolRunRow({count, detail, open, onToggle, solid = false, children}: {count: number; detail?: string | null; open: boolean; onToggle: () => void; solid?: boolean; children?: ComponentChildren}) {
 return <div class={solid ? "session-tool-run tool-run-solid" : "session-tool-run"}>
  <button type="button" class="session-tools" aria-expanded={open} onClick={onToggle}><span aria-hidden="true">{open ? "▾" : "▸"}</span> {count} tool call{count === 1 ? "" : "s"}{detail && <small> · {detail}</small>}</button>
  {open && children}
 </div>;
}
