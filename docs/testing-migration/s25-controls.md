# S25 executed production controls

Each mutation was applied alone in this worktree, exercised through the real worker or bridge, then restored.
Each control's failing assertion is in s25.md. No mutation is shipped.

| Control | Bug patched back |
|---|---|
| S25-policy | the worker compaction guard never cancels a summarizer after a policy block |
| S25-default | the default parent compaction threshold rises from 200000 to 300000 tokens |
| S25-carry | parent compact instructions keep only next actions, dropping escalations, holds, mandates and unsettled sends |
| S25-digest | the digest-in-context check always answers false, so digests are re-sent on resume |
| S25-auto | automatic parent context control returns before doing anything |
| S25-drain | a new drain is no longer refused while a compaction or rotation is busy |
| S25-deadline | parent compact uses the ordinary 30000 ms request timeout instead of the compact deadline |
| S25-refresh | a successful parent compaction no longer redelivers the hidden digests |
| S25-start | session start no longer delivers the hidden digests |
| S25-below | automatic control no longer skips a context below the threshold |
| S25-length | automatic control no longer skips a length stop whose effective context is below the threshold |
| S25-rebuilt | the cache-rebuild check never reports a rebuild |
| S25-warm | the cache-rebuild check ignores the cache read, so a warm cache counts as a rebuild |
