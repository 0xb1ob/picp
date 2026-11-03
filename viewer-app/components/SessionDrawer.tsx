import type { ComponentChildren } from "preact";
import { useContext, useLayoutEffect, useRef } from "preact/hooks";
import { Icon } from "./icons.tsx";
import { ShellContext } from "./Shell.tsx";

/** The phone's Conversations drawer (M3): the rail's chrome (brand, search, icon nav) around the Chats list. */
export function SessionDrawer({onClose, children}: {onClose: () => void; children: ComponentChildren}) {
 const dialog = useRef<HTMLDialogElement>(null);
 const rail = useContext(ShellContext).rail;
 useLayoutEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
 // A followed link closes it too: picking the session already shown moves no route. Search opens over the chat.
 return <dialog ref={dialog} class="workspace-sessions" aria-label="Conversations" onCancel={event => { event.preventDefault(); onClose(); }}
  onClick={event => { if (event.target === event.currentTarget || (event.target as Element).closest?.("a, .shell-rail-search")) onClose(); }}>
  <header class="workspace-sessions-head">
   {rail?.head}
   <button type="button" class="workspace-close" aria-label="Close conversations" onClick={onClose}><Icon name="close"/></button>
  </header>
  <nav class="workspace-sessions-list" aria-label="Session streams">{children}</nav>
  {rail?.nav("Primary")}
 </dialog>;
}
