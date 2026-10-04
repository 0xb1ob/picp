import { useState } from "preact/hooks";
import { uploadUrl } from "../control.ts";

/**
 * A dashboard message's sent images (cp-br81 D9): 96 px thumbnails from `/api/operator/uploads/<id>`; a tap opens one
 * at the bubble's full width and a second tap closes it. A file the server no longer has (the 7-day sweep, a cleaned
 * /tmp) answers 404, and its tile reads "image expired" instead of a broken image.
 */
export function TranscriptImages({ids}: {ids: string[]}) {
 const [open,setOpen]=useState<string | null>(null);
 const [expired,setExpired]=useState<string[]>([]);
 return <ul class="session-images" aria-label={ids.length === 1 ? "1 image" : `${ids.length} images`}>
  {ids.map((id,i) => <li key={id} class={open === id ? "session-image-open" : undefined}>
   {expired.includes(id) ? <span class="session-image-expired" title={id}>image expired</span>
    : <button type="button" class="session-image-toggle" aria-expanded={open === id} onClick={()=>setOpen(open === id ? null : id)}>
     <img class="session-image" src={uploadUrl(id)} alt={`Sent image ${i+1}`} onError={()=>setExpired(gone=>gone.includes(id) ? gone : [...gone,id])}/>
    </button>}
  </li>)}
 </ul>;
}
