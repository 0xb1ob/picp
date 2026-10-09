import { useEffect, useState } from "preact/hooks";
import { createResource, type Snapshot } from "./resource.ts";
export function useScreenData<T>(url: string, streamUrl: string): Snapshot<T> {
 const [value,setValue] = useState<Snapshot<T>>({data:null,status:"connecting",error:null});
 useEffect(() => {
  // A new URL starts from nothing: the previous URL's snapshot (its data, or its error) never stands in for the new query. The old resource is disposed by this effect's cleanup, so a late earlier response cannot land.
  setValue(prev => prev.data === null && prev.error === null && prev.status === "connecting" ? prev : {data:null,status:"connecting",error:null});
  const resource = createResource<T>(url,streamUrl);
  const unsubscribe = resource.subscribe(setValue);
  const visibility = () => resource.setVisible(!document.hidden);
  document.addEventListener("visibilitychange",visibility); visibility();
  return () => { document.removeEventListener("visibilitychange",visibility); unsubscribe(); resource.dispose(); };
 },[url,streamUrl]);
 return value;
}
