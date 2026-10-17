# Android import recovery — contract and verification record

Plan: `docs/plans/active/2026-10-17-android-import-recovery.md`, Stage 1
(formerly G5 I6). Branch `fix/android-import-recovery`, base `fb6f79e`
(plan commit on top of `c35186f`). Review range for the complete I6 work:
`51fab3c..HEAD`.

## Recovery contract

Two separate IndexedDB databases are involved:

- `sporely` / `pending_import`: the import review's groups ("sessions"),
  one record per group, key path `id`. Written by `src/import-store.js`.
- `sporely_sync` / `offline_queue`: the sync queue. Written by
  `enqueueObservation` in `src/sync-queue.js`.

No transaction spans both, so the contract is defined by ordering:

1. **A group leaves `pending_import` only after its queue item is durable,
   or after the user confirmed discarding it.** In `saveAll()` the group's
   `enqueueObservation` must resolve first. It resolves only from
   `tx.oncomplete` of a `{ durability: 'strict' }` transaction. Only then
   does `deleteImportSession(id)` run, and it is awaited before the next
   group is queued. A rejected enqueue never deletes; the group stays in
   memory and in the store.
2. **Session writes commit in call order.** `saveImportSessions`,
   `deleteImportSession`, `clearImportSessions` and
   `clearImportSessionsStrict` all run through one module-level FIFO chain
   (`_enqueueImportStoreWrite`). A snapshot write started before Queue All
   therefore commits before that run's deletes and final clear, and cannot
   resurrect queued groups. A snapshot is taken at call time: fields and file
   lists are read synchronously, and only the bytes are read later.
3. **The chain cannot jam.** Each operation settles its own caller (true or
   false for save and delete, a throw for strict clear). The chain's own
   promise swallows the outcome, so the next operation always runs. An
   `indexedDB.open` that fires `onblocked` fails at once. If it later succeeds,
   that late connection is closed.
4. **A full rewrite is atomic.** `clear()` and the `put()` loop run in one
   transaction. A synchronous throw (for example `DataCloneError`) calls
   `tx.abort()`, so the stored records stay as they were and the call returns
   `false`. The connection is closed in a `finally` that covers the whole
   transaction, in save, delete, clear and load.
5. **Every persistence failure is visible.**
   - A failed per-group delete is logged (`describePersistError`) and never
     re-queues the group. It is then repaired by the kept-group rewrite (some
     groups failed) or by the strict clear (all queued).
   - A failed kept-group rewrite shows `import.persistFailed`, as in `c35186f`.
   - A failed strict clear after a fully successful batch shows
     `import.queuedClearFailed` instead of the success toast.
6. **Discarding needs consent.** Home and Cancel (`_cancelImport`) ask
   `import.discardConfirm` when at least one group has photos. Declining
   changes nothing: memory, store and screen stay as they are. With no groups
   there is no prompt. The `importAiBatchState.running` guard stays.
7. A group whose payload cannot be built (`obsPayload` null) is now kept as
   failed instead of being dropped unqueued.

Restore after a restart (`main.js` → `loadImportSessions` →
`restoreImportSessions`) is unchanged. It sees exactly the groups that are
not yet durably queued, plus the residual window below.

## Accepted residual risk (synchronization redesign)

A duplicate observation remains possible if Android kills the process after
group A's queue insert has committed and before `deleteImportSession(A)` has
committed. The window also covers a failed delete followed by a failed rewrite
or clear, which the user is warned about. On the next launch A is restored and
Queue All inserts it again: `add()` is unconditional and the upload uses a plain
`observations.insert()`. The outcome is a duplicate, never a loss.

The session store's own writes use the default (relaxed) durability. A
relaxed delete or clear lost in a crash only reopens the same duplicate
window; it never loses a group, because the queue write it follows is strict.

The proper fix belongs to the synchronization redesign: a shared import
identity carried from the session into the queue item and the observation,
with idempotent queue inserts and server inserts. It is out of scope here by
owner decision.

## Deviations from the brief (for the reviewer)

- **Clear-failure message.** The brief asks for "the persist-failed warning"
  when the final strict clear fails. `import.persistFailed` says "queue it
  before leaving". After a fully queued batch, that advice would cause the
  duplicate this stage prevents. I added `import.queuedClearFailed` instead
  ("Queued N, but this import could not be removed from the device. If it
  reappears after a restart, discard it instead of queuing it again."). It
  replaces the success toast. The kept-group path still uses
  `import.persistFailed`.
- **Failed delete followed by a successful repair.** If a per-group delete
  fails but the following rewrite or strict clear commits, the store ends
  correct and only the log records the failed delete. No toast is shown, since
  nothing is wrong any more. If the repair also fails, the user is warned (T5).
- **`durability` without try/catch.** WebIDL ignores unknown dictionary
  members, and engines that predate the option ignore an extra argument.
  Android System WebView has supported `durability` since Chromium 83. A
  fallback branch would never run, so the change is the option alone.
- **`clearImportSessions` call sites in `_cancelImport`, and `navigate` and
  `confirm`,** go through the existing `_importAiDependency` test seam. A new
  `__cancelImportForTests` export follows the module's `__…ForTests`
  convention.

## Tests and what each depends on

New file `src/import-recovery.test.js` runs the real store, `saveAll()`,
`_cancelImport()` and `enqueueObservation` against a fake IndexedDB. The fake
models all-or-nothing commits, abort rollback, blocked opens, held commits
and connection counts. Only the queue write (except T10), toasts, rendering
and navigation are replaced. `src/import-persist-failure.test.js` keeps its
four tests; its harness now also stubs `clearImportSessionsStrict` and
`deleteImportSession`.

I disabled each fix in turn, ran the focused tests, saw the listed tests fail,
and restored the fix. Results at the candidate:

| Test | Fix it depends on | Fix disabled as | Failed with it disabled |
|---|---|---|---|
| T1 sync `put()` throw | 1 abort on synchronous throw | `fill()` called without try/abort | T1 |
| T2 delete after enqueue, never after rejection | 4 per-group delete | `removed = true` (no delete) | T2, T3, T4 |
| T2 (rejection half) | 4 delete only when queued | `if (queued)` → `if (true)` | T2, T4 |
| T3 death during enqueue(B) | 4 per-group delete | as row 2 | T3 |
| T4 Codex reproduction | 4 per-group delete | as row 2 | T4 |
| T5 delete and rewrite fail | kept-group rewrite warning (`c35186f`) | kept path removed | T5 (with T2, T4, T9) |
| T5 delete and strict clear fail | 4 strict clear in `try` | non-strict `clearImportSessions` | T5 (second case) |
| T6 slow write before Queue All | 3 FIFO chain | `Promise.resolve().then(op)` (no chain) | T6 (T7 and T8 also fail: their idle wait relies on the chain) |
| T7 chain liveness | 3 chain swallows outcome | `_writeChain = run` | T7 alone (cascades to all later tests in the full file) |
| T7 blocked open | 1 `onblocked` → failure | `onblocked` handler removed | T7 |
| T8 Home/Cancel confirm | 5 confirmation | prompt skipped | T8 (with groups) |
| T9 mixed methods before rejection | kept-group path (`c35186f`) and the ingest-method store fields | `keptSessions = []` | T9 |
| T10 strict durability | `{ durability: 'strict' }` | option removed | T10 |
| T10 resolve only in `oncomplete` | resolve in `oncomplete` | added `req.onsuccess = () => resolve()` | T10 |

Note on the blocked-open mutation: the fake lets a blocked open succeed later,
so without the handler T7 fails on the wrong result (`true`), not on a
timeout. A real open that stays blocked would hang the chain.

## Verification commands (candidate, before commit)

- `node --test src/import-recovery.test.js src/import-persist-failure.test.js`:
  17/17 pass.
- Neighbours (`import-review`, `import-store`, `import-location-provenance`,
  `sync-queue`, `sync-queue-recovery`, `connectivity-loss`,
  `ingest-method-provenance`) plus the two above: 124 tests, 123 pass, 1 fail.
  The one failure is the known `connectivity-loss.test.js` "enqueueObservation
  is IndexedDB-only". It still fails for the same reason as at `c35186f`: its
  anchor range reaches `_retryObservationInsertWithoutProvenance`, which
  calls `supabase`. The strict-durability line does not change that result.
- `npm test`: 1697 tests, 1647 pass, 11 fail. These are exactly the 11 baseline
  failures (four taxonomy manifest checks, the `connectivity-loss` anchor
  above, six Deno `.ts` files). Baseline was 1684/1634/11, and the 13 extra
  tests are the new file.
- `npx eslint` on the changed files: 0 errors, 2 warnings, both pre-existing
  (`gapUnit`, `imageMeta` in `import_review.js`).
- `git diff --check`: clean.
- `npm run build`: **not run to completion.** In this worktree it stops at the
  `vite.config.js` guard "VITE_TURNSTILE_SITE_KEY is required for production
  builds", because the worktree has no `.env`. Running it with a test key or
  `--mode test` needed a permission this session did not have. The coordinator
  builds the debug APK for the emulator gate anyway.

## Emulator restart verification (human gate, pending)

Run on a debug APK built from the exact candidate SHA, against the local
Supabase stack only. Gallery originals must be unchanged across all checks.

| Check | Expected | Result |
|---|---|---|
| E1 native picker A–D, file-picker photo added to group 2 before removing B, Queue All | two observations with expected ingest methods; gallery checksums unchanged | pending |
| E2 two groups, force-stop during review, relaunch | both groups restored with all photos and methods; Queue All → exactly two observations | pending |
| E3 force-stop and relaunch after E2's save | no review restored; no extra queue items or observations | pending |
| E4 Home with groups | confirmation shown; declining keeps groups; after force-stop and relaunch they are restored | pending |

## Codex finding 4 (diagnosis)

The original G5 failure console recorded only `[object DOMException]`. The
lazy WebView `File` / `NotReadableError` diagnosis in the G5 fix notes is
consistent with the code. Neither the exception subtype nor the failing
operation was observed, so it remains a hypothesis. Since `c35186f`, failures
log `name: message` through `describePersistError`, so a recurrence will name
the exception. The original G5 evidence under `sporely-worktrees/g4-evidence/`
is left unedited.

## Deferred

- The residual duplicate window above (synchronization redesign).
- `_snapshotPickedFiles`: memory pressure on large selections, and
  `lastModified || Date.now()` turning a valid zero timestamp into "now".
- Revoked thumbnails when the user declines the "save without location"
  prompt (files intact, preview only).
- A hung (never-settling) `indexedDB.open` with no `onblocked`, or a file
  `arrayBuffer()` that never settles, would still stall later session writes.
  That includes the sign-out and owner-mismatch purge (`main.js`
  `_purgeUserDrafts`, which awaits `clearImportSessionsStrict`). No engine
  behaviour producing either is known: unreadable WebView files reject with
  `NotReadableError`. Neither is handled beyond `onblocked`. The chain also
  helps the purge: a session save started before sign-out can no longer
  commit after the purge and leave the previous user's import behind.
