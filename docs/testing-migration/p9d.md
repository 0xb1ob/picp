# Ledger rows: p9d

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| P9d (cp-e2e-migration-p9d-ke34) | behavior 11, fourth slice: dashboard sends through the real cp-bridge (paired-device provenance, image and file attachments), the viewer's pending sends and operator threads in `tests/e2e/operator-dashboard.test.ts`; 30 mapped, 1 redundant-unreachable, 4 retained verbatim plus three guard halves in two `*-retained.test.ts` files; [ledger and controls](p9d.md). Behavior-11 files outside #510, #515, #519 and this slice stay `convert` / P9 | 5 (`tests/control-pending.test.ts`, `tests/dashboard-control-remote.test.ts`, `tests/dashboard-control-images.test.ts`, `tests/operator-threads-bridge.test.ts`, `tests/operator-threads-journal.test.ts`) |
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
| P9d-threads | tests/e2e/operator-dashboard.test.ts | P9d-threads: cp_parent answer, ask and thread_bind file their ids under a thread through the real bridge, and a failed filing never fails them |
| P9d-threads-journal | tests/e2e/operator-dashboard.test.ts | P9d-threads-journal: the viewer's thread list folds the journal in line order and names every unreadable line or file |
| P9d-images | tests/e2e/operator-dashboard.test.ts | P9d-images: send_images and send_files hand the operator model image parts and bounded file text, refuse bad uploads, and fall back to a path |
<!-- /manifest:scenarios -->

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Disposition | Note |
|---|---|---|---|---|
| tests/control-pending.test.ts | accepted sends settle by target metadata and 24h TTL, preserving live FIFO and final outcomes | P9d-pending | mapped | GET /api/operator/control; controls P1, P6, P7, P8, P10 |
| tests/control-pending.test.ts | cp-y43c: a dashboard-held message is editable with its saved text, outlives its session, and loses Edit once handed over or cancelled | P9d-pending | mapped | control P3 |
| tests/control-pending.test.ts | cp-y43c review 1: a lost send is a visible failure for LOST_SEND_VISIBLE_MS (7 days) after it was sent, then history | P9d-pending | mapped | controls P2, P4 |
| tests/control-pending.test.ts | picp-96n: a Not confirmed send names only its own recorded, listed session, never the current one | P9d-pending | mapped | control P5 |
| tests/dashboard-control-remote.test.ts | live: status advertises remote provenance; a remote send and steer carry the device line above a `; remote` marker | P9d-remote | mapped | provider request and viewer transcript; control R1 |
| tests/dashboard-control-remote.test.ts | a body cannot forge or strip it: a typed device line and marker stay body text; a malformed remote arg is refused | P9d-remote | mapped | controls R2, R3 |
| tests/dashboard-control-remote.test.ts | queue: a remote message keeps its sender; a remote edit adds its editor; a restart reloads both | P9d-remote-queue | mapped | controls R4, R5, R6 |
| tests/dashboard-control-remote.test.ts | offline replay: each remote held message carries its own device line and marker, threaded or not | P9d-remote-inbox | mapped | controls R7, R8 |
| tests/operator-threads-bridge.test.ts | threadTag normalizes or throws naming the rule | P9d-threads | mapped | control T1 |
| tests/operator-threads-bridge.test.ts | answer with a thread posts, then writes open + bind once; a second answer with the tag writes only a bind | P9d-threads | mapped | controls T2, J2 |
| tests/operator-threads-bridge.test.ts | an invalid tag throws before any journal is written | P9d-threads | mapped | control T1 |
| tests/operator-threads-bridge.test.ts | a duplicate job_id answer writes no bind and says the first id was not re-filed | P9d-threads | mapped | control T2 |
| tests/operator-threads-bridge.test.ts | ask with a thread binds the ask id; asks.jsonl keeps today's keys; the result text is JSON with id and state | P9d-threads | mapped | control T1 |
| tests/operator-threads-bridge.test.ts | an unwritable threads journal: the answer and the ask still land, the result says NOT filed, isError stays false | P9d-threads | mapped | control T3 |
| tests/operator-threads-bridge.test.ts | fileUnderThread never throws on a bad ref and names the failure | — | retained | only generated or schema-checked ids reach it; kept verbatim in tests/operator-threads-retained.test.ts |
| tests/operator-threads-bridge.test.ts | thread_bind files job refs locally, normalizes, repeats without writes, and moves a job to the newest thread | P9d-threads | mapped | controls J2, J5 |
| tests/operator-threads-bridge.test.ts | thread_bind validates the whole request before writes; a journal failure is named without throwing | P9d-threads | mapped | journal-failure half: control T3; the bridge guard sits behind pi's schema (which coerces a lone id or 7), kept verbatim in tests/operator-threads-retained.test.ts |
| tests/operator-threads-journal.test.ts | normalizeThreadTag: trim, ASCII-lowercase, whitespace runs to '-'; anything else that is not a tag is null | P9d-threads | mapped | cp_parent tags and dashboard send thread 7/null; control T1 |
| tests/operator-threads-journal.test.ts | a missing journal is exists:false with nothing in it; nothing creates the file until a thread is used | P9d-threads-journal | mapped | availability missing |
| tests/operator-threads-journal.test.ts | fold: open, bind and done in line order; a later bind reopens; the newest bind of a ref wins | P9d-threads-journal | mapped | controls J3, J5 |
| tests/operator-threads-journal.test.ts | fold: a second open of one tag aliases to the first id | P9d-threads-journal | mapped | control J1 |
| tests/operator-threads-journal.test.ts | fold: bad lines, unknown threads, bad refs, repeated open ids and unknown types count in skipped; a repeat bind is ignored | P9d-threads-journal | mapped | controls J2, J3 |
| tests/operator-threads-journal.test.ts | fold: a torn last line is ignored; an oversized or unreadable journal is an error that names the file | P9d-threads-journal | mapped | control J4 |
| tests/operator-threads-journal.test.ts | bindThread: opens a tag once, binds, is idempotent per ref, writes 0600 under a 0700 dir | P9d-threads | mapped | controls T2, J2 |
| tests/operator-threads-journal.test.ts | bindThread never throws: a bad tag or ref writes nothing; an unreadable journal or failed append is an error | P9d-threads | mapped | unreadable and EACCES halves: control T3; bad tag/ref half kept verbatim in tests/operator-threads-retained.test.ts |
| tests/operator-threads-journal.test.ts | job refs fold like other refs: valid job contract ids, newest bind wins, repeats are idempotent | P9d-threads | mapped | invalid-id half kept verbatim in tests/operator-threads-retained.test.ts; controls J2, J5 |
| tests/operator-threads-journal.test.ts | job ids matching legacy ref ids bind, deduplicate and move independently by kind | P9d-threads | mapped | job id equal to an answer id; control J5 |
| tests/dashboard-control-images.test.ts | userMessageContent: text alone stays a string; with images, one text part then one image part each | P9d-images | redundant-unreachable | internal shape; the model-visible text and image parts are pinned by P9d-images and P9d-remote |
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
| T1 | tests/operator-threads-bridge.test.ts | P9d-threads | cp-bridge answer only trims and lowercases the tag | `bad tag!` not refused |
| T2 | tests/operator-threads-bridge.test.ts | P9d-threads | cp-bridge files a duplicate answer too | duplicate answer: thread details present |
| T3 | tests/operator-threads-bridge.test.ts | P9d-threads | operator-threads.ts fileUnderThread throws on failure | unwritable journal: answer isError true |
| J1 | tests/operator-threads-journal.test.ts | P9d-threads-journal | control-files.ts no alias for a second open of a tag | `a second open of one tag aliases`: open, expected done |
| J2 | tests/operator-threads-journal.test.ts | P9d-threads-journal | control-files.ts counts a repeat bind | `a repeat bind is ignored`: last_at T1 |
| J3 | tests/operator-threads-journal.test.ts | P9d-threads-journal | control-files.ts accepts a bridge-written done | `a repeat bind is ignored`: done, expected open |
| J4 | tests/operator-threads-journal.test.ts | P9d-threads-journal | control-files.ts cap doubled | oversized journal: availability ok |
| J5 | tests/operator-threads-journal.test.ts | P9d-threads-journal | threads-view.ts counts refs moved to another thread | `the newest bind wins`: answers 1, expected 0 |
| I1 | tests/dashboard-control-images.test.ts | P9d-images | dashboard-control.ts marker omits the image ids | first image send: marker lacks `images=` |
| I2 | tests/dashboard-control-images.test.ts | P9d-images | dashboard-control.ts drops an image pi cannot resize | no request carries `could not be attached inline` |
| I3 | tests/dashboard-control-images.test.ts | P9d-images | uploads.ts decodes UTF-8 leniently | `a file changed into invalid UTF-8 is refused`: accepted |
| I4 | tests/dashboard-control-images.test.ts | P9d-images | uploads.ts gives each file the whole inline budget | inlined body over TEXT_MESSAGE_INLINE_BYTES |
| I5 | tests/dashboard-control-images.test.ts | P9d-images | dashboard-control.ts resize budget of 1 byte | first image send falls back to a path line |
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/operator-dashboard.test.ts | cp-e2e-migration-p9d-ke34 | P9d behavior 11: dashboard sends, pending sends and threads through a real bridge and viewer |
| tests/operator-threads-retained.test.ts | cp-e2e-migration-p9d-ke34 | P9d: thread guards shadowed by pi's schema and generated ids |
| tests/dashboard-control-images-retained.test.ts | cp-e2e-migration-p9d-ke34 | P9d: image-preparation deadline, missing capability and handoff races, no entry point |
<!-- /manifest:incoming -->
