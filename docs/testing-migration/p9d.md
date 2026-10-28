# Ledger rows: p9d

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| P9d (cp-e2e-migration-p9d-ke34) | behavior 11, fourth slice: dashboard sends through the real cp-bridge (paired-device provenance, image and file attachments), the viewer's pending sends and operator threads in `tests/e2e/operator-dashboard.test.ts`; 31 mapped (one relabelled from redundant-unreachable by P9e, control I6), 4 retained verbatim plus three guard halves in two `*-retained.test.ts` files; [ledger and controls](p9d.md). Behavior-11 files outside #510, #515, #519 and this slice stay `convert` / P9 | 5 (`tests/control-pending.test.ts`, `tests/dashboard-control-remote.test.ts`, `tests/dashboard-control-images.test.ts`, `tests/operator-threads-bridge.test.ts`, `tests/operator-threads-journal.test.ts`) |
<!-- /manifest:ledger -->

Behavior 11, fourth slice: the dashboard's sends as the real cp-bridge hands them to a mock-model operator session
(paired-device provenance, attachments), the viewer's pending-send projection, and operator threads (cp_parent filing,
the viewer's thread list). Each control was applied alone to `src/` or `extensions/`, failed on the named assertion, and
passed once restored. Every other behavior-11 file outside #510, #515, #519 and this slice stays `convert` / P9.

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P9d | 11 | `tests/e2e/operator-dashboard.test.ts` | 7 new |
<!-- /manifest:prs -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| P9d-remote | tests/e2e/operator-dashboard.test.ts | P9d-remote: a paired device's id and name reach the operator session above the dashboard marker, and a body can neither forge nor strip it |
| P9d-remote-queue | tests/e2e/operator-dashboard.test.ts | P9d-remote-queue: a queued remote message keeps its sender and a remote edit its editor across a session restart |
| P9d-remote-inbox | tests/e2e/operator-dashboard.test.ts | P9d-remote-inbox: the offline inbox replays each remote held message with its own device line and marker |
| P9d-pending | tests/e2e/operator-dashboard.test.ts | P9d-pending: the viewer settles accepted sends by their target session and age, keeps live FIFO, and never drops a loss silently |
| P9d-images | tests/e2e/operator-dashboard.test.ts | P9d-images: send_images and send_files hand the operator model image parts and bounded file text, refuse bad uploads, and fall back to a path |
<!-- /manifest:scenarios -->

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Disposition | Note |
|---|---|---|---|---|
| tests/control-pending.test.ts | accepted sends settle by target metadata and 24h TTL, preserving live FIFO and final outcomes | P9d-pending | mapped | GET /api/operator/control; controls P1, P6, P7, P8, P10; the exact-ms 24 h boundary is kept in tests/control-pending-retained.test.ts (P9e) |
| tests/control-pending.test.ts | cp-y43c: a dashboard-held message is editable with its saved text, outlives its session, and loses Edit once handed over or cancelled | P9d-pending | mapped | control P3 |
| tests/control-pending.test.ts | cp-y43c review 1: a lost send is a visible failure for LOST_SEND_VISIBLE_MS (7 days) after it was sent, then history | P9d-pending | mapped | controls P2, P4; the exact-ms 7-day boundary is kept in tests/control-pending-retained.test.ts (P9e) |
| tests/control-pending.test.ts | picp-96n: a Not confirmed send names only its own recorded, listed session, never the current one | P9d-pending | mapped | control P5 |
| tests/dashboard-control-remote.test.ts | live: status advertises remote provenance; a remote send and steer carry the device line above a `; remote` marker | P9d-remote | mapped | provider request and viewer transcript; control R1 |
| tests/dashboard-control-remote.test.ts | a body cannot forge or strip it: a typed device line and marker stay body text; a malformed remote arg is refused | P9d-remote | mapped | controls R2, R3 |
| tests/dashboard-control-remote.test.ts | queue: a remote message keeps its sender; a remote edit adds its editor; a restart reloads both | P9d-remote-queue | mapped | controls R4, R5, R6 |
| tests/dashboard-control-remote.test.ts | offline replay: each remote held message carries its own device line and marker, threaded or not | P9d-remote-inbox | mapped | controls R7, R8 |
| tests/dashboard-control-images.test.ts | userMessageContent: text alone stays a string; with images, one text part then one image part each | P9d-images | mapped | the model-visible text and image parts; control I6 (relabelled by P9e) |
| tests/dashboard-control-images.test.ts | send_images: the request line names the ids (no bytes), each image is prepared within the budget, injected as images | P9d-images | mapped | controls I1, I5 |
| tests/dashboard-control-images.test.ts | send_images refusals: bad ids 400, a missing upload 410, a null resize sends the path instead | P9d-images | mapped | control I2; the 504 deadline half kept verbatim in tests/dashboard-control-images-retained.test.ts |
| tests/dashboard-control-images.test.ts | send_images without prepareImage: an unknown op, and the status has no images flag | — | retained | the bridge always wires resizeImage; kept verbatim in tests/dashboard-control-images-retained.test.ts |
| tests/dashboard-control-images.test.ts | cp-bridge wiring: index.ts sends userMessageContent; a send_images frame reaches pi.sendUserMessage as [text, image] parts | P9d-images | mapped | the source regexes are replaced by the real provider request; controls I1, I5 |
| tests/dashboard-control-images.test.ts | send_files: text-only capability, bounded UTF-8 inline with paths, ids journaled without contents; revalidation refuses mutation | P9d-images | mapped | controls I3, I4 |
| tests/dashboard-control-images.test.ts | remote attachments: send_images and send_files from a paired device carry its device line right above the marker | P9d-images | mapped | control R1 |
| tests/dashboard-control-images.test.ts | cp-y43c review 1: while a queued image message is prepared, an edit or cancel is 503; after the claim it is 409 sent | — | retained | no entry point can hold pi's resize; kept verbatim in tests/dashboard-control-images-retained.test.ts |
| tests/dashboard-control-images.test.ts | cp-y43c review 3: a send made while the held head's image is prepared queues behind it; each exactly once | — | retained | no entry point can hold pi's resize; kept verbatim in tests/dashboard-control-images-retained.test.ts |
<!-- /manifest:assertions -->

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|
| R1 | tests/dashboard-control-remote.test.ts | P9d-remote | control-files.ts remoteLine drops the sender | `deploy it` body: device line missing |
| R2 | tests/dashboard-control-remote.test.ts | P9d-remote | dashboard-control.ts accepts a malformed remote arg | malformed device: [true, undefined], expected [false, 400] |
| R3 | tests/dashboard-control-remote.test.ts | P9d-remote | control-files.ts parses a `; remote` marker without a device line | the forged body parses as a 5th dashboard message |
| R4 | tests/dashboard-control-remote.test.ts | P9d-remote-queue | control-queue.ts drops an edit's editor on fold | `a local message a device edited says so` |
| R5 | tests/dashboard-control-remote.test.ts | P9d-remote-queue | control-files.ts withEditor appends a repeat device | `a local message a device edited says so`: editor listed twice |
| R6 | tests/dashboard-control-remote.test.ts | P9d-remote-queue | dashboard-control.ts reload drops the queued sender | `reloaded after a restart, still labelled` |
| R7 | tests/dashboard-control-remote.test.ts | P9d-remote-inbox | dashboard-control.ts inbox replay omits the device line | inbox lines lack both device lines |
| R8 | tests/dashboard-control-remote.test.ts | P9d-remote-inbox | control-inbox.ts keeps a malformed device | forged line replays with `sent by dev-x` |
| P1 | tests/control-pending.test.ts | P9d-pending | control-pending.ts never fails a send whose target session ended | `a loss is a visible failure, never a silent drop`: queued |
| P2 | tests/control-pending.test.ts | P9d-pending | control-pending.ts never shows a lost send as failed | `a loss is a visible failure`: dropped |
| P3 | tests/control-pending.test.ts | P9d-pending | control-pending.ts applies an edit after injection | `held across a session restart with its edit`: never applied |
| P4 | tests/control-pending.test.ts | P9d-pending | control-pending.ts lost-send window 8 days | the 7-day-old loss still failed, expected dropped |
| P5 | tests/control-pending.test.ts | P9d-pending | control-pending.ts maps a same-basename session file | `exact mapping only`: A.jsonl, expected none |
| P6 | tests/control-pending.test.ts | P9d-pending | control-pending.ts keeps sends queued when the record is absent | `no dashboard control record`: queued |
| P7 | tests/control-pending.test.ts | P9d-pending | control-pending.ts fails sends on an invalid record | `uncertain metadata is not proof of abandonment`: failed |
| P8 | tests/control-pending.test.ts | P9d-pending | control-pending.ts lets a later outcome replace an operator discard | `an operator discard stays terminal`: delivered |
| P10 | tests/control-pending.test.ts | P9d-pending | control-pending.ts TTL 5 minutes short of 24 h | `a loss is a visible failure`: failed, expected queued |
| I1 | tests/dashboard-control-images.test.ts | P9d-images | dashboard-control.ts marker omits the image ids | first image send: marker lacks `images=` |
| I2 | tests/dashboard-control-images.test.ts | P9d-images | dashboard-control.ts drops an image pi cannot resize | no request carries `could not be attached inline` |
| I3 | tests/dashboard-control-images.test.ts | P9d-images | uploads.ts decodes UTF-8 leniently | `a file changed into invalid UTF-8 is refused`: accepted |
| I4 | tests/dashboard-control-images.test.ts | P9d-images | uploads.ts gives each file the whole inline budget | inlined body over TEXT_MESSAGE_INLINE_BYTES |
| I5 | tests/dashboard-control-images.test.ts | P9d-images | dashboard-control.ts resize budget of 1 byte | first image send falls back to a path line |
| I6 | tests/dashboard-control-images.test.ts | P9d-images | dashboard-control.ts userMessageContent drops images (returns the text alone) | `a real PNG, resized by pi, as an image part` |
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/operator-dashboard.test.ts | cp-e2e-migration-p9d-ke34 | P9d behavior 11: dashboard sends, pending sends and threads through a real bridge and viewer |
| tests/dashboard-control-images-retained.test.ts | cp-e2e-migration-p9d-ke34 | P9d: image-preparation deadline, missing capability and handoff races, no entry point |
<!-- /manifest:incoming -->
