/** The skills a dashboard message mentioned (its code-written `[cp-skill …]` lines), one chip each. */
export function TranscriptSkills({names}: {names: readonly string[]}) {
 return <ul class="session-files session-skills" aria-label="Skills">
  {names.map(name => <li key={name}><code>@{name}</code></li>)}
 </ul>;
}
