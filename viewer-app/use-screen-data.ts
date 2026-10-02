import { useEffect, useState } from "preact/hooks";
import { createResource, type Snapshot } from "./resource.ts";
export function useScreenData<T>(url: string, streamUrl: string): Snapshot<T> {
 const [value,setValue] = useState<Snapshot<T>>({data:null,status:"connecting",error:null});
 useEffect(() => {
  const resource = createResource<T>(url,streamUrl);
  const unsubscribe = resource.subscribe(setValue);
  const visibility = () => resource.setVisible(!document.hidden);
  document.addEventListener("visibilitychange",visibility); visibility();
  return () => { document.removeEventListener("visibilitychange",visibility); unsubscribe(); resource.dispose(); };
 },[url,streamUrl]);
 return value;
}
