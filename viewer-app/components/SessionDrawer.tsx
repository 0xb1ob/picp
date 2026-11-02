import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { Icon } from "./icons.tsx";

/** The phone's Conversations drawer (M3): the Chats list (current Operator session, Fleet) in a modal left drawer. */
export function SessionDrawer({onClose, children}: {onClose: () => void; children: ComponentChildren}) {
 const dialog = useRef<HTMLDialogElement>(null);
 useLayoutEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
 // A followed link closes it too: picking the session already shown moves no route.
 return <dialog ref={dialog} class="workspace-sessions" aria-label="Conversations" onCancel={event => { event.preventDefault(); onClose(); }}
  onClick={event => { if (event.target === event.currentTarget || (event.target as Element).closest?.("a")) onClose(); }}>
  <header class="workspace-sessions-head">
   <h2>Conversations</h2>
   <button type="button" class="workspace-close" aria-label="Close conversations" onClick={onClose}><Icon name="close"/></button>
  </header>
  <nav class="workspace-sessions-list" aria-label="Session streams">{children}</nav>
 </dialog>;
}
