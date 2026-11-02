import { type ProjectSelection, selectionValue, UNTAGGED } from "../project-filter.ts";

/** A labelled native select (All, Untagged, sorted names, a retained unknown selection); the screen owns the hash. */
export function ProjectFilter({names, selection, onChange}: {names:readonly string[]; selection:ProjectSelection; onChange:(value:string)=>void}) {
 const value = selectionValue(selection), sorted = [...new Set(names)].sort((a,b) => a.localeCompare(b));
 const option = (v: string, label: string) => <option key={v} value={v} selected={v === value}>{label}</option>;
 return <label class="project-filter"><span>Project</span><select aria-label="Filter by project" onChange={e => onChange(e.currentTarget.value)}>
  {option("","All")}
  {option(UNTAGGED,"Untagged")}
  {value && value !== UNTAGGED && !sorted.includes(value) && option(value,value)}
  {sorted.map(name => option(name,name))}
 </select></label>;
}
