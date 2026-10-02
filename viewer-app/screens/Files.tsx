import type { FilesResponse } from "../../src/viewer/api-types.ts";
import { Icon } from "../components/icons.tsx";
import { filesHref, jobHref, sessionHref } from "../routes.ts";
export function Files({data}: {data:FilesResponse}) {
 const projects=data.roots.filter(r=>r.kind === "project"), worktrees=data.roots.filter(r=>r.kind === "worktree");
 const selected=data.roots.find(r=>r.id===data.selected), listing=data.listing;
 const path=(name:string)=>data.path ? `${data.path}/${name}` : name;
 return <div class={selected ? "files files-open" : "files"}>
  <div><h1>Files</h1><p class="files-subtitle">Clones and live worktrees · open read-only, 512 KiB cap</p></div>
  <section aria-labelledby="file-projects"><h2 id="file-projects">Projects</h2>{!projects.length && <p class="files-empty">No projects</p>}{projects.map(p=><div class="file-project" key={p.id}><Icon name="files" size={18}/><a class="file-root" href={filesHref(p.id)} aria-current={data.selected === p.id ? "location" : undefined}><span>{p.label}{p.paused && <span class="file-paused">paused</span>}</span><small>clone</small></a></div>)}</section>
  <section aria-labelledby="file-worktrees"><h2 id="file-worktrees">Live worktrees · {worktrees.length}</h2>{!worktrees.length && <p class="files-empty">No live worktrees</p>}{worktrees.map(w=><div class="file-worktree" key={w.id}>
   <div class="file-worktree-title"><span class={`session-dot session-dot-${w.phase ?? "unknown"}`}/><a href={filesHref(w.id)}><code>{w.job_id}</code></a><span>{w.phase ?? "unknown"}</span></div>
   <div class="file-worktree-meta"><span>{w.project}</span>{w.head && <code>head {w.head.slice(0,7)}</code>}</div>
   <div class="file-actions"><a href={jobHref(w.job_id!)}>Job</a>{w.pr_url ? <a href={w.pr_url} rel="noreferrer noopener" target="_blank">PR #{w.pr_url.split("/").pop()}</a> : <span aria-disabled="true">no PR</span>}<a href={sessionHref("workers",w.job_id!)}>Log</a></div>
  </div>)}</section>
  {selected && <section aria-labelledby="file-listing"><h2 id="file-listing"><a href={filesHref(selected.id)}>{selected.label}</a> / {data.path}</h2>
   {data.path && <a class="file-entry" href={filesHref(selected.id,data.path.split("/").slice(0,-1).join("/"))} aria-label="Parent directory">↑ ..</a>}
   {listing?.kind === "dir" && <>{listing.entries.map(f=><a class="file-entry" href={filesHref(selected.id,path(f.name))} key={f.name}><Icon name={f.type === "dir" ? "files" : "file"} size={16}/><code>{f.name}{f.type === "dir" ? "/" : ""}</code></a>)}{!listing.entries.length && <p class="files-empty">Empty directory</p>}{listing.truncated && <p class="files-empty">First 1,000 entries shown</p>}</>}
   {listing?.kind === "file" && (listing.too_large ? <p class="files-empty">File exceeds the 512 KiB cap</p> : listing.binary ? <p class="files-empty">Binary file · {listing.size} bytes</p> : <pre class="file-text">{listing.text}</pre>)}
  </section>}
  <p class="files-policy">Never listed or served: <code>.git</code>, <code>.env*</code>, any <code>secrets</code> segment, <code>*.pem</code>, <code>*.key</code>, <code>id_rsa*</code>, <code>*.p12</code>, <code>auth.json</code>.</p>
 </div>;
}
