import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.tsx";
export function CopyReply({reply}: {reply:string}) {
 const [state,setState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
 const code = useRef<HTMLElement>(null); const mounted = useRef(true);
 const timer = useRef<ReturnType<typeof setTimeout>>();
 useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(timer.current); }; },[reply]);
 const copy = async () => {
  clearTimeout(timer.current); setState("copying");
  try {
   if (!navigator.clipboard) throw new Error("clipboard unavailable");
   await navigator.clipboard.writeText(reply);
   if (!mounted.current) return;
   setState("copied"); timer.current = setTimeout(() => setState("idle"),1600);
  } catch {
   if (!mounted.current) return;
   setState("failed");
   if (code.current) { const range = document.createRange(); range.selectNodeContents(code.current); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); code.current.focus(); }
  }
 };
 return <><div class="overview-reply"><code ref={code} tabIndex={0}>{reply}</code><button type="button" title="Copy reply" aria-label="Copy reply for the operator chat" disabled={state === "copying"} onClick={copy}><Icon name={state === "copied" ? "check" : "copy"} size={14}/>{state === "copied" ? "Copied" : "Copy"}</button></div><span role="status" class="overview-copy-status">{state === "failed" ? "Clipboard unavailable. Reply selected for manual copying." : ""}</span></>;
}
