# S25 executed production controls

Each mutation was applied alone in this worktree, exercised through the real worker or bridge, then restored.
Run logs and patch copies were kept in `.s25-*` worktree files during execution; the complete patches and failures are preserved here and in s25.md. No mutation is shipped.

<!-- patch:S25-policy -->
```diff
diff --git a/extensions/worker-reporter/compaction.ts b/extensions/worker-reporter/compaction.ts
index 923eedc..4ecade6 100644
--- a/extensions/worker-reporter/compaction.ts
+++ b/extensions/worker-reporter/compaction.ts
@@ -7,7 +7,7 @@ const policyBlocked = (entries: readonly SessionEntry[]) =>
 /** picp-jan: keep a rejected transcript out of the summarizer, including after revival. */
 export function registerWorkerCompactionGuard(pi: ExtensionAPI): void {
 	pi.on("session_before_compact", (event) => {
-		if (policyBlocked(event.branchEntries)) return { cancel: true };
+		if (false && policyBlocked(event.branchEntries)) return { cancel: true };
 	});
 	pi.on("session_compact_failed", (event, ctx) => {
 		if (event.aborted || !event.errorMessage || policyBlocked(ctx.sessionManager.getBranch())) return;
```
<!-- /patch:S25-policy -->

<!-- patch:S25-default -->
```diff
diff --git a/src/parent-context.ts b/src/parent-context.ts
index 51b2801..a63977f 100644
--- a/src/parent-context.ts
+++ b/src/parent-context.ts
@@ -42,7 +42,7 @@ export function parentContextStatus(home: string): {
 	try { return JSON.parse(readFileSync(parentContextFile(home), "utf8")); } catch { return {}; }
 }
 
-export const DEFAULT_PARENT_COMPACT_TOKENS = 200000;
+export const DEFAULT_PARENT_COMPACT_TOKENS = 300000;
 
 /** Absent parent.json → the default; an explicit file with a bad value stays `{}` (disabled, doctor warns). */
 export function parentSettings(home: string): { compact_at_tokens?: number } {
```
<!-- /patch:S25-default -->

<!-- patch:S25-carry -->
```diff
diff --git a/src/parent-context.ts b/src/parent-context.ts
index 51b2801..7094218 100644
--- a/src/parent-context.ts
+++ b/src/parent-context.ts
@@ -69,13 +69,7 @@ export function parentCompactInstructions(home: string): string {
 	const mandates = new MandateStore(home).list().filter((item) => isActive(item, now)).map((item) => item.id);
 	const sends = new ParentSendOutbox({ file: parentSendFile(join(home, LAYOUT.sessions, "cp-parent.jsonl")) })
 		.list().filter((entry) => ["queued", "injected", "landed"].includes(entry.state)).map((entry) => entry.id);
-	return [
-		"Keep open escalations, holds, standing operator instructions, in-flight PRs and next actions.",
-		`Open escalation ids: ${escalations.join(", ") || "(none)"}`,
-		`Held PR jobs: ${held.join(", ") || "(none)"}`,
-		`Active mandate ids: ${mandates.join(", ") || "(none)"}`,
-		`Bridge sends not yet settled: ${sends.join(", ") || "(none)"}`,
-	].join("\n");
+	return "Keep next actions.";
 }
 
 export function missionEndOf(result: unknown): string | undefined {
```
<!-- /patch:S25-carry -->

<!-- patch:S25-digest -->
```diff
diff --git a/src/parent-context.ts b/src/parent-context.ts
index 51b2801..7c07c4c 100644
--- a/src/parent-context.ts
+++ b/src/parent-context.ts
@@ -284,7 +284,7 @@ export function digestsInContext(
 		const entry = branch[index]!;
 		if (entry.type === "custom_message" && entry.customType && !latest.has(entry.customType)) latest.set(entry.customType, entry.content);
 	}
-	return messages.length > 0 && [...new Set([...DIGEST_TYPES, ...messages.map((message) => message.customType)])].every((type) => latest.get(type) === messages.find((message) => message.customType === type)?.content);
+	return false;
 }
 
 export function standingOrdersDigest(home: string): string | undefined {
```
<!-- /patch:S25-digest -->

<!-- patch:S25-auto -->
```diff
diff --git a/src/parent-auto-control.ts b/src/parent-auto-control.ts
index b33f031..2cea197 100644
--- a/src/parent-auto-control.ts
+++ b/src/parent-auto-control.ts
@@ -19,6 +19,7 @@ export async function runAutoControl(
 	control: Parameters<typeof autoParentContext>[3],
 	relayError: (text: string) => void,
 ): Promise<void> {
+	return;
 	// An unreadable store (mandates, parent.json) is a failure the operator sees, never an unhandled rejection.
 	const outcome = await autoParentContext(home, missionEnd, lastAssistant, control)
 		.catch((error: Error): Awaited<ReturnType<typeof autoParentContext>> => ({ event: "failed", error: error.message }));
```
<!-- /patch:S25-auto -->

<!-- patch:S25-drain -->
```diff
diff --git a/src/cp-bridge.ts b/src/cp-bridge.ts
index 0635ed7..0c41bdd 100644
--- a/src/cp-bridge.ts
+++ b/src/cp-bridge.ts
@@ -435,7 +435,7 @@ export class CpBridge {
 		const proc = this.#proc;
 		if (!proc?.alive || !this.#ready || this.#stopping) throw new CpBridgeError("parent is not running; call cp_parent start");
 		// A cancel stays open; a new drain never races a compaction or rotation (it would finish while pi is mid-control).
-		if (timeoutS !== "cancel" && (this.#controlBusy || this.#autoControl)) throw new CpBridgeError(PARENT_CONTROL_BUSY);
+		if (false && timeoutS !== "cancel" && (this.#controlBusy || this.#autoControl)) throw new CpBridgeError(PARENT_CONTROL_BUSY);
 		return parentDiagnostic(proc, "drain", this.#options?.requestTimeoutMs, timeoutS === "cancel" ? timeoutS : drainArgs(timeoutS, cause));
 	}
 	/** `/cp-drain cancel` (cp-update's drain timeout): withdraws a draining or timed-out drain, or a drained record an earlier parent left; never the live parent's own drained one. */
```
<!-- /patch:S25-drain -->

<!-- patch:S25-deadline -->
```diff
diff --git a/src/cp-bridge.ts b/src/cp-bridge.ts
index 0635ed7..6b52850 100644
--- a/src/cp-bridge.ts
+++ b/src/cp-bridge.ts
@@ -449,7 +449,7 @@ export class CpBridge {
 		this.#controlBusy = true;
 		try {
 			const customInstructions = [parentCompactInstructions(this.#home!), instructions?.trim()].filter(Boolean).join("\n\n");
-			const response = await proc.request("compact", { customInstructions }, this.#options?.requestTimeoutMs ?? PARENT_COMPACT_TIMEOUT_MS);
+			const response = await proc.request("compact", { customInstructions }, this.#options?.requestTimeoutMs ?? 30000);
 			if (response.success === false) throw new CpBridgeError(`compact rejected: ${response.error ?? "unknown error"}`);
 			this.#recordControl({ lastCompactAt: new Date().toISOString(), contextTokens: (response.data as { estimatedTokensAfter?: number } | undefined)?.estimatedTokensAfter ?? null });
 			return (response.data ?? {}) as { tokensBefore?: number; estimatedTokensAfter?: number };
```
<!-- /patch:S25-deadline -->

<!-- patch:S25-refresh -->
```diff
diff --git a/extensions/command-post/session-hooks.ts b/extensions/command-post/session-hooks.ts
index 41fd3d2..d8a3693 100644
--- a/extensions/command-post/session-hooks.ts
+++ b/extensions/command-post/session-hooks.ts
@@ -127,7 +127,6 @@ export function registerSessionHooks(pi: ExtensionAPI, s: SessionState, session:
 		compactEpoch++;
 		// After pi's compact() has returned (its isCompacting cleared), held wakes go out.
 		setTimeout(() => compactHold.compacted(), 0);
-		if (s.parentLock) deliverDigests(currentRuntime().home, ctx);
 	});
 
 	// Hide pi's working loader for the outer extension-prompt span, and set
```
<!-- /patch:S25-refresh -->

<!-- patch:S25-start -->
```diff
diff --git a/extensions/command-post/session-hooks.ts b/extensions/command-post/session-hooks.ts
index 41fd3d2..bdcf4c2 100644
--- a/extensions/command-post/session-hooks.ts
+++ b/extensions/command-post/session-hooks.ts
@@ -397,7 +397,6 @@ export function registerSessionHooks(pi: ExtensionAPI, s: SessionState, session:
 		}
 
 		// Scaffold memory and inject both optional home-local contexts for the next turn.
-		deliverDigests(home, ctx);
 		// USER.md is repo-local, unlike the home-local orders.
 		deliverUserContext((message, options) => {
 			pi.sendMessage(message, options);
```
<!-- /patch:S25-start -->
