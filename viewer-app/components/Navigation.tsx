import { navOwner, navigation, primaryNav, type Route } from "../routes.ts";
import { Icon } from "./icons.tsx";
export function Navigation({current, awaiting, desktop = false}: {current:Route;awaiting:number | null;desktop?:boolean}) {
 const shown = primaryNav(desktop);
 const entries = shown.map(id => navigation.find(n => n.id === id)!);
 const active = navOwner(current.screen,desktop);
 return <nav class={desktop ? "shell-sidebar-nav" : "shell-tabs"} aria-label={desktop ? "Desktop primary" : "Primary"}>{entries.map(n => {
  // The awaiting badge rides on Decisions on both layouts (audit P4 #25/#26).
  const content = <><span class="shell-nav-icon"><Icon name={n.id} size={desktop ? 18 : 20}/>{n.id === "decisions" && (awaiting ?? 0) > 0 && <span class="shell-count">{awaiting}</span>}</span><span>{n.label}</span></>;
  return <a key={n.id} href={n.href} aria-current={active === n.id ? "page" : undefined}>{content}</a>;
 })}</nav>;
}
