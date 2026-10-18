import { GLOSSARY_HREF } from "../routes.ts";

/** "What is this?": opens the README glossary in a new tab, so the card or row stays where it was. */
export function GlossaryLink() {
 return <a class="glossary-link" href={GLOSSARY_HREF} target="_blank" rel="noopener noreferrer" title="Words you will see: the picp glossary">what is this? ↗</a>;
}
