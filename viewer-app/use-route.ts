import { useEffect, useState } from "preact/hooks";
import { route } from "./routes.ts";
export function useRoute() {
 const [current,setCurrent] = useState(() => route(location.hash));
 useEffect(() => {
  const update = () => {
   const next = route(location.hash);
   setCurrent(next);
  };
  update(); window.addEventListener("hashchange",update);
  return () => window.removeEventListener("hashchange",update);
 },[]);
 return current;
}
