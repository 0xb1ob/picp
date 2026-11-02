import type { OverviewResponse } from "../../src/viewer/api-types.ts";
import { Icon } from "../components/icons.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { PushControl } from "../components/PushControl.tsx";
import type { PushView } from "../push.ts";
import { navigation, type NavId } from "../routes.ts";
export function More({data, push}: {data:OverviewResponse; push?:PushView}) {
 const subtitles: Partial<Record<NavId,string>> = {files:`${data.navigation.project_count} projects · ${data.availability.fleet === "unavailable" ? "-" : data.navigation.worktree_count} live worktrees`};
 // Every page outside Chat and Jobs, the same list on both widths.
 return <div class="more"><PageHeader title="More"/><nav aria-label="More views" class="more-menu">{navigation.filter(n => ["overview","decisions","stats","reports","schedules","files","settings"].includes(n.id)).map(n => {
  const children = <><Icon name={n.id}/><span class="more-label"><span>{n.label}</span>{subtitles[n.id] && <span class="more-meta">{subtitles[n.id]}</span>}</span><span aria-hidden="true">&rarr;</span></>;
  return <a key={n.id} href={n.href}>{children}</a>;
 })}</nav>{push && <PushControl view={push}/>}</div>;
}
