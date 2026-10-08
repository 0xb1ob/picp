import { attachmentSize, uploadUrl } from "../control.ts";

/** Native links open the hardened text/plain response; attachment contents never become HTML. */
export function TranscriptFiles({ids, metadata}: {ids: readonly string[]; metadata?: Record<string, {name: string; bytes: number}>}) {
 return <ul class="session-files" aria-label="Attached text files">
  {ids.map(id => <li key={id}><a class="session-file-link" href={uploadUrl(id)} target="_blank" rel="noopener noreferrer"><span>{metadata?.[id]?.name ?? id}</span>{metadata?.[id] && <small>{attachmentSize(metadata[id]!.bytes)}</small>}</a></li>)}
 </ul>;
}
