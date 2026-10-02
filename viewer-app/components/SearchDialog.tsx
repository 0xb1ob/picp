import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { FlightJob } from "../../src/viewer/api-types.ts";
import { jobHref, navigation } from "../routes.ts";
import { Icon } from "./icons.tsx";

export function SearchDialog({jobs,error,onClose}: {jobs:FlightJob[] | null;error:string | null;onClose:() => void}) {
 const dialog = useRef<HTMLDialogElement>(null);
 const input = useRef<HTMLInputElement>(null);
 const [query,setQuery] = useState("");
 const term = query.trim().toLowerCase();
 const entries = [
  ...navigation.filter(n => n.href).map(n => ({...n,icon:n.id,meta:""})),
  ...(jobs ?? []).map(job => ({id:job.id,label:job.title ?? job.id,href:jobHref(job.id),icon:"jobs" as const,meta:job.id})),
 ].filter(entry => `${entry.label} ${entry.id}`.toLowerCase().includes(term));
 useLayoutEffect(() => {
  const opener = document.activeElement as HTMLElement | null;
  const element = dialog.current!;
  element.showModal(); input.current?.focus();
  return () => { element.close(); if (opener?.isConnected) opener.focus(); };
 },[]);
 return <dialog ref={dialog} class="search-dialog" aria-label="Search" onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
  const links = [...dialog.current!.querySelectorAll<HTMLAnchorElement>("a")];
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
   event.preventDefault();
   const index = links.indexOf(document.activeElement as HTMLAnchorElement);
   const next = index < 0 ? event.key === "ArrowDown" ? 0 : links.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + links.length) % links.length;
   links[next]?.focus();
  } else if (event.key === "Enter" && event.target === input.current && !event.isComposing) {
   event.preventDefault(); links[0]?.click();
  }
 }}>
  <div class="search-header"><label class="search-field"><Icon name="search" size={16}/><input ref={input} type="search" aria-label="Search navigation and in-flight jobs" placeholder="Search" value={query} onInput={event => setQuery(event.currentTarget.value)}/></label><button type="button" aria-label="Close search" onClick={onClose}>Close</button></div>
  <div class="search-results"><nav aria-label="Search results">{entries.map(entry => <a key={entry.href} href={entry.href} onClick={onClose}><Icon name={entry.icon}/><span class="search-label"><span>{entry.label}</span>{entry.meta && <code>{entry.meta}</code>}</span><span aria-hidden="true">&rarr;</span></a>)}</nav>
   <p role="status">{error ?? (jobs === null ? "Loading in-flight jobs" : entries.length === 0 ? "No results" : `${entries.length} results`)}</p>
  </div>
 </dialog>;
}
