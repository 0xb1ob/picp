import { useEffect, useState } from "preact/hooks";
import { createResource, pollStream, type Snapshot } from "./resource.ts";
export function useScreenData<T>(url: string, streamUrl: string): Snapshot<T> {
 const [value,setValue] = useState<Snapshot<T>>({data:null,status:"connecting",error:null});
 useEffect(() => {
  // A new URL starts from nothing: the previous URL's snapshot (its data, or its error) never stands in for the new query. The old resource is disposed by this effect's cleanup, so a late earlier response cannot land.
  setValue(prev => prev.data === null && prev.error === null && prev.status === "connecting" ? prev : {data:null,status:"connecting",error:null});
  // The quick tunnel's listener renders <meta name="cp-refresh" content="poll"> (src/viewer/app-page.ts); local and named keep SSE.
  const poll = document.querySelector('meta[name="cp-refresh"]')?.getAttribute("content") === "poll";
  const resource = createResource<T>(url,streamUrl,poll ? {fetch: (u,i) => fetch(u,i), stream: pollStream} : undefined);
  const unsubscribe = resource.subscribe(setValue);
  const visibility = () => resource.setVisible(!document.hidden);
  document.addEventListener("visibilitychange",visibility); visibility();
  return () => { document.removeEventListener("visibilitychange",visibility); unsubscribe(); resource.dispose(); };
 },[url,streamUrl]);
 return value;
}
