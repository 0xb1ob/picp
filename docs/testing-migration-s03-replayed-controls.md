# S03 inherited control replay

These are new executions, not reconstructed historical provenance. Each mutation was applied independently and restored immediately. Unless a record says otherwise, base HEAD is `f30d532f5eed302ec17661dafad2cdf56b3d1d42`, merging main `a61a117757f69c6a7ea28d23be8a1ccf80f74d97`. Commands use `TMPDIR="$PWD/.s03b-review2-runtime" npm run test:one -- --test-name-pattern='<pattern>' tests/e2e/landing.test.ts`. Only production is mutated; fixtures and assertions stay fixed.

For a replay, first create `.s03b-review2-runtime/package.json` containing `{"type":"commonjs"}`.
The local TMPDIR keeps the mock `gh` executable in CommonJS mode under this ES-module repository;
remove that directory after the run. Each test still creates and cleans its own isolated home and agent.

## S03-exclusions

Base: `7266e5df1d469ee861abb20f2b5559d3d5144fce`.
Pattern: `landing S02: only reported`. Exit 1, all eleven independent exclusion subtests fail, including local/pipeline, absent/artifact receipts, merged/landed/uppercase/trimmed statuses and waiting/done/failed phases. Log: `s03b-review2-exclusions.log`.

```diff
--- src/ci-watch.ts: isWatched
- if (record.delivery !== "pr") return false;
- if (record.phase !== "held") return false;
- if (record.reported_at === undefined) return false;
- const receipt = prReceiptOf(record);
- if (!receipt) return false;
- return !LANDED_RECEIPT_STATUSES.includes(receipt.status.trim().toLowerCase());
+ return true;
```

## S03-authority

Pattern: `landing S03: actual parent CI notices`. Exit 1: `/evidence, not authorization/i` fails on the actual CI message. Log: `s03b-review2-authority.log`.

```diff
--- src/ci-watch.ts: formatCiNotice
- "A green run is evidence, not authorization, and this raises no Awaiting-you row. Nothing has been merged.",
+ "CI finished.",
```

## S03-advice

Pattern: `landing S03: actual parent CI notices`. Exit 1: `/cp_integrate/` fails on the actual CI message. Log: `s03b-review2-advice.log`.

```diff
--- src/ci-watch.ts: formatCiNotice
- "This notice IS the CI read for that head: do not re-query gh to confirm it. Ancestry and whether the",
- "repository permits the merge are cp_integrate's read — call cp_integrate <job-id> and branch on next.",
+ "Verify CI yourself and check ancestry with gh pr view.",
```

## S03-red

Pattern: `landing S03: actual parent CI notices`. Exit 1: `/Merging red is forbidden/` fails on the actual red CI message. Log: `s03b-review2-red.log`.

```diff
--- src/ci-watch.ts: formatCiNotice
- "Merging red is forbidden, so there is no merge question here: relay the failure, name the job, the",
- "workflow and the run, and exercise ordinary judgment (promote the held worker, or re-dispatch).",
+ "Ask whether to merge the failing run.",
```

## S03-confirm

Pattern: `landing S03: corrupt`. Exit 1: `duplicate arrival changes nothing`, actual [key], expected []. Log: `s03b-review2-confirm.log`.

```diff
--- src/ci-watch.ts: confirm
- if (existing.announced.includes(key)) continue;
```

## S03-corrupt

Pattern: `landing S03: corrupt`. Exit 1: `corrupt memory is forgotten, not a failed read`, actual 1 error, expected 0. Log: `s03b-review2-corrupt.log`.

```diff
--- src/ci-watch.ts: read catch
- return EMPTY_CI_WATCH_FILE;
+ throw new CiWatchError("corrupt watch memory");
```

## S03-schema

Pattern: `landing S03: corrupt`. Exit 1: `corrupt memory is forgotten, not a failed read`, actual 1 error, expected 0. Log: `s03b-review2-schema.log`.

```diff
--- src/ci-watch.ts: read
- const result = validateCiWatchFile(JSON.parse(readFileSync(this.file, "utf8")));
- return result.ok ? result.value : EMPTY_CI_WATCH_FILE;
+ return JSON.parse(readFileSync(this.file, "utf8"));
```

## S03-blocking

Pattern: `landing S02: watcher queries`. Exit 1: `watcher command: run watch 12345` (blocking_watch versus undefined). Log: `s03b-review2-blocking.log`.

```diff
--- src/ci-watch.ts: ghPrRest
- const stdout = await exec("gh", ["api", `repos/${target.owner}/${target.repo}/pulls/${target.number}`], {
+ const stdout = await exec("gh", ["run", "watch", "12345"], {
```

## S03-eligible

Pattern: `landing S02: only reported`. Exit 1: `the eligible delivery is queried`. Log: `s03b-review2-eligible.log`.

```diff
--- src/ci-watch.ts: isWatched
- if (record.delivery !== "pr") return false;
- if (record.phase !== "held") return false;
- if (record.reported_at === undefined) return false;
- const receipt = prReceiptOf(record);
- if (!receipt) return false;
- return !LANDED_RECEIPT_STATUSES.includes(receipt.status.trim().toLowerCase());
+ return false;
```

## S03-rest-merged

Pattern: `landing S03: REST`. Exit 1: `REST merged flag reaches the public observation`. Log: `s03b-review2-rest-merged.log`.

```diff
--- src/ci-watch.ts: parsePrRest
- const observation: PrObservation = { merged: row.merged === true };
+ const observation: PrObservation = { merged: false };
```

## S03-failed-run

Pattern: `landing S03: actual parent CI notices`. Exit 1: `only the failing run is named`. Log: `s03b-review2-failed-run.log`.

```diff
--- src/ci-run-ref.ts: failedRunOn
- return runs.find((run) => shaMatches(run.headSha, head) && run.status === "completed" && !GREEN_CONCLUSIONS.has((run.conclusion ?? "").toLowerCase()));
+ return runs[0];
```

## S03-fleet-write

Pattern: `landing S03: corrupt`. Exit 1: `a watch tick writes no receipts or fleet state`. Insert immediately before `return fresh` in confirm. Log: `s03b-review2-fleet-write.log`.

```diff
--- src/ci-watch.ts: confirm
+ const fleetFile = join(this.home, LAYOUT.fleetFile);
+ const fleet = JSON.parse(readFileSync(fleetFile, "utf8"));
+ fleet.jobs[0].receipts = [];
+ atomicWriteJson(fleetFile, fleet);
```

## S03-generation / S03-observed-head / S03-missing-head

Pattern: `landing S03: facts changed`. Exit 1, generation/observed/missing independently fail with review_started instead of stale/stale/wait; remote stays guarded. Insert first in #stale. Log: `s03b-review2-stale.log`.

```diff
--- src/held-continuation.ts: #stale
+ return undefined;
```

## S03-remote-head

Pattern: `landing S03: facts changed`. Exit 1, remote subcase fails with review_started instead of stale. Log: `s03b-review2-remote-head.log`.

```diff
--- src/held-continuation.ts: #drive
- const reviewing = result.head_sha && trigger.head && !shaMatches(result.head_sha, trigger.head)
+ const reviewing = false
```

## S03-coalesce / S03-red-coalesce

Pattern: `landing S03: lost watch|landing S03: a stopped red`. Exit 1: `an in-flight replay starts no additional integration read` and `a completed red replay starts no integration step`. Log: `s03b-review2-coalesce.log`.

```diff
--- src/held-continuation.ts: trigger
- if (this.#seen.has(key)) return skip("coalesced", `${key} was already handled or is queued`);
```

## S03-rearm

Pattern: `landing S03: lost watch`. Exit 1: `the same identity can read again after settling on wait`. Log: `s03b-review2-rearm.log`.

```diff
--- src/held-continuation.ts: trigger
- if (outcome.action === "wait" || outcome.action === "draining") this.#seen.delete(key);
```

## S03-run-key

Pattern: `landing S03: a stopped red`. Exit 1: `a new attempt reaches integration once`. Log: `s03b-review2-run-key.log`.

```diff
--- src/held-continuation.ts: continuationKey
- const run = trigger.run !== undefined && trigger.run.length > 0 ? `#${trigger.run}` : "";
+ const run = "";
```

## S03-generation-key

Pattern: `landing S03: a stopped red`. Exit 1: `a reopened generation is a new continuation identity`. Log: `s03b-review2-generation-key.log`.

```diff
--- src/held-continuation.ts: continuationKey
- const generation = trigger.generation !== undefined ? `@${trigger.generation}` : "";
+ const generation = "";
```

## S03-driving

Pattern: `landing S03: a driving worker`. Exit 1: spawn-cap `assert.rejects` reports `Missing expected rejection`. Log: `s03b-review2-driving.log`.

```diff
--- src/held-continuation.ts: driving
- return this.#driving.has(jobId);
+ return false;
```

## S03-driving-finally

Pattern: `landing S03: a driving worker`. Exit 1: `the throwing step clears its busy fence`, unwanted spawn-cap rejection. Log: `s03b-review2-driving-finally.log`.

```diff
--- src/held-continuation.ts: trigger finally
- this.#driving.delete(trigger.jobId);
```

## S03-sampled

Pattern: `landing S03: a real review verdict samples`. Exit 1: all three independent sampled-hold regex assertions fail (none recorded, bounded recorded reason, unconfirmed state). Insert first in #sampledHold. Log: `s03b-review2-sampled.log`.

```diff
--- src/held-continuation.ts: #sampledHold
+ return "Hold not sampled";
```

## S03-each-step

Pattern: `landing S03: changes during`. Exit 1: generation, phase and head subcases return stopped rather than stale; drain remains guarded. Log: `s03b-review2-each-step.log`.

```diff
--- src/held-continuation.ts: #drive loop
- const stale = this.#stale(trigger);
- if (stale) return out(stale.action, step - 1, stale.reason, stale.action === "wait" ? "wait" : undefined);
```

## S03-mid-drain

Pattern: `landing S03: changes during`. Exit 1: drain subcase reaches the next integration step and returns wait rather than draining. Insert first in #draining. Log: `s03b-review2-mid-drain.log`.

```diff
--- src/held-continuation.ts: #draining
+ return false;
```

## S03-pending

Pattern: `landing S03: new CI`. Exit 1: `a new fact reaches the already-pending review gate`. Log: `s03b-review2-pending.log`.

```diff
--- src/held-continuation.ts: #drive
- if (this.#deps.reviews.pending(jobId, "review")) {
+ if (false) {
```

## S03-deadline

Pattern: `landing S03: a restarted parent`. Exit 1: `the restarted deadline reaches its terminal gate` times out after 45000ms; the persisted gate remains wait. This replaces the historical slow nine-variant control with the existing real-parent restart consumer, without changing its assertions. Log: `s03b-review2-deadline.log`.

```diff
--- src/held-continuation.ts: #arm timer callback
- void this.trigger(trigger).catch((error) => this.#notice(trigger.jobId, `timer:${identity}`, "retry", `deadline continuation failed: ${(error as Error).message.split("\n")[0]}`));
```

## S03-resume

Pattern: `landing S03: a restarted parent`. Exit 1: `startup did not arm the durable window`, no initial wait recomputation within 10000ms. Insert first in resume. Log: `s03b-review2-resume.log`.

```diff
--- src/held-continuation.ts: resume
+ return [];
```

## S03-owner

Pattern: `landing S03: a real parent that loses`. Exit 1: `disabled ownership cannot advance beyond the review wait`. Log: `s03b-review2-owner.log`.

```diff
--- src/command-post.ts: HeldContinuation construction
- enabled: () => options.continuation === true && this.#ownsHome(),
+ enabled: () => options.continuation === true,
```

## S03-outcome

Command pattern: `rpc: one CI-green key whose review is in flight` in `tests/e2e/headless-lifecycle.test.ts`. Exit 1 after 91.61 seconds: the handled-in-code notification does not arrive within its 90000ms RPC wait. Log: `s03b-review2-outcome.log`.

```diff
--- src/held-continuation.ts: ciOutcome
- return this.#ciOutcomes.get(key);
+ return undefined;
```

## S03-stop-head

Pattern: `landing S03: a stopped red`. Exit 1: `a changed handed-off head gets one more durable stop`. Log: `s03b-review2-stop-head.log`.

```diff
--- src/held-continuation.ts: #drive
- this.#notice(jobId, result.next === "done" ? "done" : `${tag}:${result.next}`, result.next, result.reason, result.pr_url);
+ this.#notice(jobId, result.next, result.next, result.reason, result.pr_url);
```

## S03-tracker

Pattern: `landing S03: a restarted parent`. Exit 1: the landed UI relay fails `doesNotMatch(/tracker|write-back|receipt note/i)`. Log: `s03b-review2-tracker.log`.

```diff
--- src/held-continuation.ts: NEXT_HINT
- done: "merged, torn down and closed without a parent turn.",
+ done: "merged, torn down and closed without a parent turn. tracker sync pending",
```

## S03-landed-turn

Pattern: `landing S03: a restarted parent`. Exit 1: `landing is relayed without waking the parent model`. Log: `s03b-review2-landed-turn.log`.

```diff
--- extensions/command-post/wakeup-surfaces.ts: pi.sendMessage boundary
- quiet ? { triggerTurn: false } : { deliverAs: "followUp", triggerTurn: true },
+ { deliverAs: "followUp", triggerTurn: true },
```

## S07-NC-3 / NC-37 rerun

Pattern: `landing: held CI repairs the same`. Exit 1: `restarted parent reads the spent allowance before looking for a local worker`. No manual integrate call is added. Log: `s03b-review2-s07-nc3.log`.

```diff
--- src/integrate.ts: repair allowance
- const prior = input.step === "conflict" && !!input.headSha && priorRec?.head_sha !== input.headSha ? 0 : (priorRec?.resolve_attempts ?? 0);
+ const prior = 0;
```

## S07-NC-2 rerun

Pattern: `landing: held CI repairs the same`. Exit 1: `another job in the project waits behind the CI repair`. Log: `s03b-review2-s07-nc2.log`.

```diff
--- src/held-continuation.ts: serialize
- const lane = this.#readRecord(jobId)?.project ?? jobId;
+ const lane = jobId;
```

## S07-NC-1 rerun

Pattern: `landing: held CI repair checks Sender`. Exit 1: `revoked` assert.match expects the mandate refusal and instead reaches the absent-worker restore refusal. Log: `s03b-review2-s07-nc1.log`.

```diff
--- src/send.ts: repair authority check
- this.#options.mandates.assertPermitted("repair", { jobId: request.jobId, project: record.project, kind: record.kind }, fleet.read().jobs);
```

## S03-delivery

Pattern: `landing S02: only reported`. Exit 1: independent local and pipeline exclusions fail. Log: `s03b-review2-delivery.log`.

```diff
--- src/ci-watch.ts: isWatched
- if (record.delivery !== "pr") return false;
```

## S03-receipt

Pattern: `landing S02: only reported`. Exit 1: independent empty and artifact-only receipt exclusions fail. Log: `s03b-review2-receipt.log`.

```diff
--- src/ci-watch.ts: isWatched
- if (!receipt) return false;
+ if (!receipt) return true;
```

## S03-landed

Pattern: `landing S02: only reported`. Exit 1: landed, uppercase MERGED and padded-merged exclusions independently fail. Log: `s03b-review2-landed.log`.

```diff
--- src/ci-watch.ts: isWatched
- return !LANDED_RECEIPT_STATUSES.includes(receipt.status.trim().toLowerCase());
+ return receipt.status !== "merged";
```

## Replay total

Review 2 re-executed **37 independent production mutations**, replacing all 40 historical table entries (grouped stale-read and coalescing controls retain independently failing scenarios/subtests). Eligibility also has separate delivery, receipt and landed controls. Every mutation exited 1 on its named consumer assertion and was restored. No production or fixture mutation belongs in the final diff.
