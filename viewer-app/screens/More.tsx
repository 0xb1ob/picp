import type { OverviewResponse } from "../../src/viewer/api-types.ts";
import { Icon } from "../components/icons.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { PushControl } from "../components/PushControl.tsx";
import type { PushView } from "../push.ts";
import { navigation, type NavId } from "../routes.ts";
export function More({data, push}: {data:OverviewResponse; push?:PushView}) {
 const subtitles: Partial<Record<NavId,string>> = {files:`${data.navigation.project_count} projects · ${data.availability.fleet === "unavailable" ? "-" : data.navigation.worktree_count} live worktrees`};
 // Audit P4 #25: More holds what is rarely needed, on desktop too; Reports is a sidebar item there and listed here on phone only.
 return <div class="more"><PageHeader title="More"/><nav aria-label="More views" class="more-menu">{navigation.filter(n => ["reports","schedules","files","settings"].includes(n.id)).map(n => {
  const children = <><Icon name={n.id}/><span class="more-label"><span>{n.label}</span>{subtitles[n.id] && <span class="more-meta">{subtitles[n.id]}</span>}</span><span aria-hidden="true">&rarr;</span></>;
  return <a key={n.id} href={n.href} class={n.id === "reports" || n.id === "settings" ? "more-phone" : undefined}>{children}</a>;
 })}</nav>{push && <PushControl view={push}/>}</div>;
}
