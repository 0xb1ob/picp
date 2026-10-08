import type { ComponentChildren } from "preact";
import type { NavId } from "../routes.ts";
// Paths and stroke widths from design screens 00, 04, 05, 09, 10 and 11.
export function Icon({name, size = 20}: {name:NavId | "awaiting" | "copy" | "check" | "search" | "file" | "back" | "down" | "send" | "vmore" | "attach" | "close" | "refresh" | "notifications"; size?:number}) {
 let content: ComponentChildren;
 switch (name) {
  case "overview": content = <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></>; break;
  case "awaiting": content = <><path d="M4 4h16v12H8l-4 4z" stroke-linejoin="round"/><path d="M9 10h6" stroke-linecap="round"/></>; break;
  case "decisions": content = <><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 12.5l2 2 4-4.5" stroke-linecap="round" stroke-linejoin="round"/></>; break;
  case "sessions": content = <path d="M4 5.5h16v11H9.5L4 20.5z" stroke-linejoin="round"/>; break;
  case "jobs": content = <><path d="M9 6.5h11M9 12h11M9 17.5h11" stroke-linecap="round"/><circle cx="4.5" cy="6.5" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="17.5" r="1"/></>; break;
  case "board": content = <><rect x="3.5" y="4" width="5" height="16" rx="1.5"/><rect x="9.5" y="4" width="5" height="11" rx="1.5"/><rect x="15.5" y="4" width="5" height="7" rx="1.5"/></>; break;
  case "reports": content = <><rect x="4.5" y="3.5" width="15" height="17" rx="2"/><path d="M8 8.5h8M8 12h8M8 15.5h5" stroke-linecap="round"/></>; break;
  case "schedules": content = <><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2" stroke-linecap="round" stroke-linejoin="round"/></>; break;
  case "map": content = <><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="10" cy="18" r="2.5"/><path d="M8.4 6.4l7.2 1.2M6.9 8.4l2.2 7.2M16.4 10l-4.8 6" stroke-linecap="round"/></>; break;
  case "files": content = <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" stroke-linejoin="round"/>; break;
  case "settings": content = <><circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.5M12 18v2.5M3.5 12H6M18 12h2.5M6 6l1.8 1.8M16.2 16.2L18 18M6 18l1.8-1.8M16.2 7.8L18 6" stroke-linecap="round"/></>; break;
  case "back": content = <path d="M15 6l-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"/>; break;
  case "down": content = <path d="M12 5v14M6 13l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/>; break;
  case "send": content = <path d="M12 19V5M6 11l6-6 6 6" stroke-linecap="round" stroke-linejoin="round"/>; break;
  case "file": content = <><path d="M6 3.5h8l4 4v13H6z" stroke-linejoin="round"/><path d="M14 3.5v4h4" stroke-linejoin="round"/></>; break;
  case "more": content = <><circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/></>; break;
  case "vmore": content = <><circle cx="12" cy="5.5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="18.5" r="1.6"/></>; break;
  case "copy": content = <><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></>; break;
  case "check": content = <path d="M5 12.5l4.5 4.5L19 7.5" stroke-linecap="round" stroke-linejoin="round"/>; break;
  case "search": content = <><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2" stroke-linecap="round"/></>; break;
  case "attach": content = <path d="M19.5 11.5l-7.6 7.6a4.6 4.6 0 0 1-6.5-6.5l8-8a3.1 3.1 0 0 1 4.4 4.4l-8 8a1.5 1.5 0 0 1-2.2-2.2l7.3-7.3" stroke-linecap="round" stroke-linejoin="round"/>; break;
  case "refresh": content = <><path d="M20 7v5h-5M19.5 12a7.5 7.5 0 1 1-2-5.5L20 9" stroke-linecap="round" stroke-linejoin="round"/></>; break;
  case "notifications": content = <><path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zM10 20h4" stroke-linecap="round" stroke-linejoin="round"/></>; break;
  case "close": content = <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke-linecap="round"/>; break;
 }
 const dots = name === "more" || name === "vmore";
 return <svg width={size} height={size} viewBox="0 0 24 24" fill={dots ? "currentColor" : "none"} stroke={dots ? "none" : "currentColor"} stroke-width={name === "check" ? 2 : 1.6} aria-hidden="true">{content}</svg>;
}
