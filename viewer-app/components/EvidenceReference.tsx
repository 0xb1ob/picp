import type { ComponentChildren } from "preact";
import type { EvidenceReference } from "../../src/evidence-reference.ts";
import { referenceLabel } from "../evidence-ref.ts";
import { composerHref } from "../routes.ts";
import { Icon } from "./icons.tsx";
import "./evidence-reference.css";

const FIELDS = [["kind","Kind"],["project","Project"],["job_id","Job"],["head_sha","Head"],["attempt","Review attempt"],["list","Finding list"],["ordinal","Position (from 0)"],["run_id","CI run"],["run_attempt","Run attempt"]] as const;

/** Opens the operator composer with this one reference (navigation, never a send); `unsupported` says why not. */
export function AskAbout({reference, draft = "", unsupported, children = "Ask about this"}: {reference: EvidenceReference; draft?: string; unsupported?: string; children?: ComponentChildren}) {
 if (unsupported) return <span class="evidence-ask evidence-ask-unsupported" title={unsupported}>{children} · unsupported</span>;
 return <a class="evidence-ask" href={composerHref(draft, reference)} title={`Ask the operator about ${referenceLabel(reference)}`}>{children}</a>;
}

/** The composer's one reference: its short label, every identifier behind a disclosure, and Remove (the text stays). */
export function EvidenceChip({reference, onRemove}: {reference: EvidenceReference; onRemove: () => void}) {
 return <div class="evidence-chip" role="group" aria-label="Reference sent with this message">
  <details class="evidence-chip-details">
   <summary>{referenceLabel(reference)}</summary>
   <dl>{FIELDS.filter(([key]) => reference[key] !== undefined).map(([key, name]) => <div key={key}><dt>{name}</dt><dd><code>{String(reference[key])}</code></dd></div>)}</dl>
   {reference.kind === "ci" && reference.run_id === undefined && <p>No run id was recorded: this names every CI observation of the head.</p>}
  </details>
  <button type="button" class="evidence-chip-remove" aria-label="Remove reference" title="Remove reference" onClick={onRemove}><Icon name="close" size={14}/></button>
 </div>;
}
