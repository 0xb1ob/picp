/** Audit P4 #23: one Jobs item, three views; the phone Board's Board/Map switch extended by List, on every width (styles in screens/jobs.css). */
export function JobsViews({current}:{current:"jobs" | "board" | "map"}) {
 return <nav class="board-view jobs-views" aria-label="Jobs view">{([["jobs","List"],["board","Board"],["map","Map"]] as const).map(([id,label])=><a key={id} href={`#${id}`} aria-current={current===id ? "page" : undefined}>{label}</a>)}</nav>;
}
