import { navOwner, navigation, primaryNav, type Route } from "../routes.ts";
import { Icon } from "./icons.tsx";
/** `icons`: the Chat rail's foot and the phone drawer's, icon-only with each label kept for its accessible name. */
export function Navigation({current, awaiting, desktop = false, icons = false, label}: {current:Route;awaiting:number | null;desktop?:boolean;icons?:boolean;label?:string}) {
 const entries = primaryNav.map(id => navigation.find(n => n.id === id)!);
 const active = navOwner(current.screen);
 return <nav class={icons ? "shell-sidebar-nav shell-icon-nav" : desktop ? "shell-sidebar-nav" : "shell-tabs"} aria-label={label ?? (desktop ? "Desktop primary" : "Primary")}>{entries.map(n => {
  // The awaiting badge rides on More, which holds Decisions, on both layouts.
  const content = <><span class="shell-nav-icon"><Icon name={n.id} size={desktop || icons ? 18 : 20}/>{n.id === "more" && (awaiting ?? 0) > 0 && <span class="shell-count">{awaiting}</span>}</span><span class="shell-nav-label">{n.label}</span></>;
  return <a key={n.id} href={n.href} title={icons ? n.label : undefined} aria-current={active === n.id ? "page" : undefined}>{content}</a>;
 })}</nav>;
}
