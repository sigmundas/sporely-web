# Android Import Recovery (formerly G5 I6)

Workflow: `android-import-recovery`. Branch `fix/android-import-recovery`,
based on `c35186f` (the first I6 fix, on top of accepted photo-location Stage 5
`51fab3c`). Owner-approved 2026-10-17.

## Background

An Android import group was lost from the pending Sporely import sessions after
a failed save. Gallery originals were not affected. `c35186f` stopped
`saveAll()` from clearing groups that failed to queue. Codex
(`codex-g5fix-review-1.txt`, CHANGES REQUESTED) and the coordinator's review
found these remaining gaps, all verified in code at `c35186f`:

1. `src/import-store.js` `saveImportSessions`: `store.clear()` precedes the
   `put()` calls. A synchronous throw from `put()` (for example
   `DataCloneError`) escapes without aborting the transaction, so the clear
   and the earlier puts commit and wipe the other pending groups. The DB
   connection is also left open on that path.
2. `src/screens/import_review.js` `initImportReview`: Home (`import-back`) and
   Cancel (`import-cancel-btn`) both call `_cancelImport()`, which discards all
   groups and `pending_import` without confirmation, including a group that
   just failed to save.
3. Duplicate observations after restart. The session store (`sporely` /
   `pending_import`) and the sync queue (`sporely_sync`) are separate IndexedDB
   databases, `enqueueObservation` uses an unconditional `add()`, and uploads
   use plain `observations.insert()`. Paths:
   - 3a. The process dies during the `saveAll()` enqueue loop after group A was
     queued: `pending_import` still holds A, startup (`main.js`) restores it
     automatically, and Queue All inserts A again. No storage failure needed.
   - 3b. Fire-and-forget `_persistSessions()` writes are unsequenced and read
     file bytes before opening their transaction, so a write started before
     Queue All can commit after the post-save cleanup and resurrect queued
     groups.
   - 3c. `clearImportSessions()` swallows a failure after a fully successful
     save, so the next launch restores the whole queued batch.
   - Codex's case: queue A, fail B, then the rewrite to `[B]` fails.

## Owner decisions

- Fix 1, 2 and 3 now with a narrow safeguard. No new persistence architecture,
  no import identity, no server idempotency.
- Accepted residual risk: a duplicate observation if Android dies between the
  committed queue insert and the committed removal of that group's saved
  session. Document it for the later synchronization redesign.
- Confirmation is required whenever at least one group with photos exists, on
  both Home and Cancel.

## Stage 1 — Persistence and navigation hardening with emulator restart verification

### Scope

Files you may change:

- `src/import-store.js`
- `src/screens/import_review.js`
- `src/i18n.js` (new strings only, every supported language)
- `src/sync-queue.js`: **only** to make the `enqueueObservation` IndexedDB
  transaction request strict durability
  (`db.transaction(STORE_NAME, 'readwrite', { durability: 'strict' })`),
  degrading gracefully where the option is unsupported. No other change to the
  sync queue, upload, or retry code.
- `src/import-persist-failure.test.js` (extend; reuse its harness) and, if
  cleaner, one new focused test file beside it.
- `docs/verification/2026-10-android-import-recovery.md` (new): the recovery
  contract, the residual-risk limitation for the synchronization redesign, and
  the verification record.

Out of scope, do not touch: I2 (`android/`, `NativeCameraPlugin`, manifest
queries), `_snapshotPickedFiles`, the sync queue beyond the line above, upload
code, migrations, `supabase/schema.sql`, the photo-location G5 evidence under
`sporely-worktrees/g4-evidence/`, and any `.sparring` gate outcome.

### Required changes

1. **Atomic session save.** In `saveImportSessions`, wrap `clear()` and the
   `put()` loop so any synchronous exception calls `tx.abort()` and the call
   returns `false` with the stored records unchanged. Close the connection in a
   `finally` that covers the whole transaction, in both save and load. Handle
   `indexedDB.open` `onblocked` as a failure instead of waiting forever.
2. **`deleteImportSession(id)`.** Delete one record by its key path `id` in its
   own transaction; resolve `true` only on `oncomplete`, `false` on any error.
3. **Serialized writes that cannot jam.** Run every `pending_import` write
   (`saveImportSessions`, `deleteImportSession`, `clearImportSessions`,
   `clearImportSessionsStrict`) through one module-level FIFO chain, so writes
   commit in call order. A rejected, synchronously throwing, or blocked
   operation must settle its own caller and release the chain for the next
   operation. Strict clear keeps throwing to its caller (sign-out and
   owner-mismatch purge semantics unchanged).
4. **Delete only after a durable enqueue.** In `saveAll()`, after
   `await enqueue(...)` resolves for a group, `await deleteImportSession(id)`
   before the next group. `enqueueObservation` resolves only from
   `tx.oncomplete` of a strict-durability transaction; keep that, and prove it
   with a test. A failed delete is logged with `describePersistError` and
   leads to the existing persist-failed warning; it never becomes silent and
   never re-queues the group. The kept-group rewrite stays. The final clear
   after a fully successful save uses the strict variant in a `try`, and a
   failure shows the persist-failed warning.
5. **Confirm before discarding.** `_cancelImport()` asks for confirmation
   (`window.confirm`, new i18n key, e.g. "Discard N import groups? The photos
   stay in your gallery.") when at least one group has files. Declining leaves
   memory, `pending_import` and the screen unchanged. Confirming keeps today's
   behaviour. No prompt when there are no groups. The existing
   `importAiBatchState.running` guard stays.

### Tests (node, deterministic; each must fail with its fix disabled)

Record in the verification doc which fix each test depends on, and that you
broke it and saw it fail.

- T1 `put()` throws synchronously on the second record: the transaction is
  aborted, previously stored records survive, the call returns `false`, and
  the connection is closed.
- T2 order: enqueue(A) resolves, then delete(A) commits, then enqueue(B).
  The delete never starts before enqueue resolves, and never runs when
  enqueue rejects.
- T3 simulated process death: enqueue(B) never settles. The store holds only
  B; a reload (`loadImportSessions`) returns only B.
- T4 Codex reproduction: persist `[A,B]`, queue A, fail B, fail the rewrite,
  restart, retry. The queue holds exactly one A and one B.
- T5 delete(A) fails and the rewrite fails: the user is warned; no silent
  success.
- T6 overlap: a slow session write begun before Queue All does not leave
  queued groups in the store after `saveAll()` finishes.
- T7 chain liveness: a rejected op, a synchronously throwing op, and a blocked
  open each settle their caller, and the next queued operation still runs.
- T8 Home/Cancel with groups: decline changes nothing (memory, store,
  navigation); confirm clears. With no groups: no prompt.
- T9 mixed methods before rejection: a group with `native_picker` and
  `web_file_picker` photos, one photo removed, enqueue rejected. The kept group
  keeps both files and both ingest methods in order, and the retry queues the
  same methods.
- T10 strict durability: the enqueue transaction is opened with
  `{ durability: 'strict' }` and resolution happens only in `oncomplete`.
- The four existing tests in `src/import-persist-failure.test.js` still pass.

Verification commands: the focused test files; the neighbours
`src/import-review.test.js`, `src/import-store.test.js`,
`src/import-location-provenance.test.js`, `src/sync-queue.test.js`,
`src/sync-queue-recovery.test.js` and `src/connectivity-loss.test.js`;
then `npm test` once, `npm run build`, `npx eslint` on changed files and
`git diff --check`.

Baseline `npm test` at `c35186f` (recorded by the coordinator): 1684 tests,
1634 pass, 11 fail. The 11 pre-existing failures are four taxonomy manifest
checks, `connectivity-loss.test.js` "enqueueObservation is IndexedDB-only (no
supabase/network before the commit)", and six Deno `.ts` files run under node.
Do not attribute these to the change; report any new failure, and if the
strict-durability edit changes the `connectivity-loss` result, say how.

### Acceptance criteria

- No code path removes a group from memory or from `pending_import` unless that
  group's enqueue has resolved after its committed transaction, or the user
  confirmed discarding it.
- After any simulated restart, a retry queues each group at most once, except
  the accepted residual window, which is documented.
- Every persistence failure is visible to the user; nothing reports success
  falsely.
- The write chain cannot be blocked permanently by a failed operation.
- I2 files are untouched, and `src/sync-queue.js` differs from `c35186f` only
  by the strict-durability option.

### Review instructions for the sparring reviewer

Review the **complete I6 implementation against `51fab3c`**
(`git diff 51fab3c..HEAD`), not only the increment over `c35186f`. That range
contains only I6 work: `c35186f` plus this stage. Re-check Codex's earlier
findings (`/Users/sigmundas/Documents/Code/sporely/sporely-worktrees/identity-impl/codex-g5fix-review-1.txt`)
and paths 3a–3c above. Confirm each test fails without its fix where the
implementer claims so (spot-check at least T1, T2, T4, T7, T8).

### Required human gate: Android emulator restart verification

Before READY, return NEEDS_YOU for the emulator checks below. The coordinator
performs them on a debug APK built from the exact candidate SHA, against the
local Supabase stack only (no production, no personal data), and resumes with
evidence. Do not accept the stage without that evidence.

- E1 I6 sequence in matrix ordering: native picker A–D, add a file-picker photo
  to the second group **before** removing B, then Queue All. Expected: two
  observations with the expected ingest methods; gallery checksums unchanged.
- E2 Restart restore: build two groups, force-stop the app during review,
  relaunch. Expected: both groups restored with all photos and methods; Queue
  All yields exactly two observations.
- E3 No restore after success: after E2's save, force-stop and relaunch.
  Expected: no import review restored, no extra queue items or observations.
- E4 Home with groups: the confirmation appears; declining keeps the groups,
  and after a force-stop and relaunch they are restored.

Gallery originals must be unchanged across all checks.

### Deferred and residual

- Accepted residual: duplicate observation if Android dies between the
  committed queue insert and the committed session delete. Proper fix: shared
  import identity and idempotent inserts in the synchronization redesign.
- `_snapshotPickedFiles` memory pressure on large selections, and its
  `lastModified || Date.now()` treatment of a zero timestamp.
- Revoked thumbnails when the user declines the "save without location"
  prompt (files intact, preview only).
- Codex finding 4 (the original exception subtype is unproven): recorded in
  the verification doc; the original G5 evidence stays unedited.
