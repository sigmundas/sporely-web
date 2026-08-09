# Plan: Preserve HEIC/HDR Originals Alongside Sporely Cloud Derivatives

## Goal

Preserve original HEIC/HEIF files in Sporely Cloud so that:

* HDR / wide-gamut image data is not permanently lost during import.
* Compatible devices can later display the original HDR image.
* Sporely continues to use ordinary WebP/JPEG derivatives for normal cross-platform display.
* `sporely-web`, `sporely-py`, Android, and `sporely-landing` do not need HEIC support for their normal image-rendering paths.
* Original files remain private / owner-only.
* `sporely-py` can optionally sync/recover the original HEIC alongside its normal working image.

The central principle is:

> **Original HEIC is archival source media. WebP remains the canonical Sporely display format.**

---

# 1. Target media model

Each observation image may have up to three cloud representations:

```text
Observation image
│
├── thumb.webp
│   └── small SDR derivative for grids, lists, upload queue, maps
│
├── full.webp
│   └── normal SDR Sporely display derivative
│
└── original.heic
    └── immutable original source; owner-only
```

For ordinary JPEG imports:

```text
Observation image
│
├── thumb.webp
├── full.webp
└── original.jpg
```

The architecture should therefore be format-agnostic:

```text
original = source file supplied by user
full     = normalized Sporely display derivative
thumb    = normalized Sporely thumbnail
```

HEIC is only one original format.

---

# 2. Core invariants

## 2.1 Original is immutable source media

Once uploaded successfully, the original file should be treated as source material rather than a generated derivative.

Do not silently:

* recompress it
* resize it
* convert it
* strip HDR information
* replace it with the generated JPEG/WebP
* overwrite it during normal derivative regeneration

If the user explicitly replaces an observation image, the replacement can create a new original.

---

## 2.2 `storage_path` remains the normal display image

Do not switch the existing canonical image path to HEIC.

Keep normal Sporely rendering based on the existing derivative:

```text
storage_path → full WebP
```

and:

```text
original_storage_path → original HEIC/JPEG/etc.
```

This avoids forcing HEIC support into every client.

---

## 2.3 Original remains owner-only

`original_storage_path` must not become public simply because the observation is public.

The `original` variant should remain:

```text
owner only
```

This protects:

* EXIF metadata
* GPS data
* full-resolution source files
* original filenames / camera metadata
* future unsupported metadata types

Normal public/friend rendering should use the sanitized derivative.

---

# 3. Existing architecture to reuse

Sporely already has several useful pieces and should build on them instead of creating a parallel media system.

## Database

Use the existing:

```text
observation_images.storage_path
observation_images.original_storage_path
```

Do not add a separate HEIC-specific storage column.

---

## Media variants

Continue treating image media as:

```text
thumb
full
original
```

Do not introduce:

```text
heic
hdr
source_heic
```

as variants.

`original` describes the role; MIME type describes the format.

---

## sporely-py original lineage

Retain the distinction between:

```text
filepath
original_filepath
source_role
```

For converted local images:

```text
source_role = converted_local
filepath = converted working/display copy
original_filepath = original HEIC
```

The original-sync policy should continue to prefer `original_filepath` when available.

---

# 4. Desired HEIC import flow in sporely-web

## Current conceptual flow

```text
HEIC selected
    ↓
decode / convert
    ↓
JPEG/WebP working image
    ↓
thumbnail + AI input
    ↓
normal cloud upload
```

## Target flow

```text
HEIC selected
    │
    ├───────────────┐
    │               │
    ↓               ↓
preserve Blob      decode HEIC
as original           ↓
    │              normalized image
    │                  ↓
    │             full.webp
    │             thumb.webp
    │
    └───────────────┬───────────────
                    ↓
                 publish
                    │
        ┌───────────┼───────────┐
        ↓           ↓           ↓
   thumb.webp    full.webp   original.heic
```

The original HEIC Blob should remain available through the import-review/session pipeline until the observation is either:

* successfully published, or
* deliberately discarded by the user.

---

# 5. Preserve source identity during import

Extend import state only as much as necessary to retain source lineage.

A candidate conceptual structure:

```js
{
  sourceFile,
  sourceMimeType,
  sourceFilename,

  displayBlob,
  aiBlob,
  thumbnailBlob,

  sourceIsOriginal: true
}
```

Do not reuse:

```text
aiBlob
thumbnailBlob
convertedBlob
```

as the archival original.

The original must refer to the actual user-selected source bytes.

For HEIC:

```text
sourceFile === original HEIC
```

For JPEG:

```text
sourceFile === original JPEG
```

---

# 6. Upload policy

Original upload should be a separate operation from the normal derivative upload.

Conceptually:

```text
PUT full derivative
X-Sporely-Upload-Variant: full

PUT thumbnail
X-Sporely-Upload-Variant: thumb

PUT source file
X-Sporely-Upload-Variant: original
```

The Worker should:

* validate ownership
* enforce quota
* enforce upload-size limits
* retain correct `Content-Type`
* store the original under the user's namespace
* associate the resulting path with `original_storage_path`

Example content type:

```text
image/heic
```

or:

```text
image/heif
```

depending on the source.

Do not convert HEIC at the Worker.

---

# 7. Storage key strategy

Use a predictable role-based layout, not extension-dependent business logic.

Example only:

```text
<user-id>/<image-id>/full.webp
<user-id>/<image-id>/thumb.webp
<user-id>/<image-id>/original.heic
```

or retain the existing Sporely key layout if already established.

Requirements:

* all paths remain under the owner's UUID namespace
* `original_storage_path` cannot alias another user's object
* original extension should match actual source type where practical
* MIME type remains authoritative

Do not base authorization on filename extension.

---

# 8. Database finalization

Only set:

```text
original_storage_path
```

after successful original upload.

Do not write a DB path first and assume the object upload will succeed.

Desired lifecycle:

```text
upload bytes
    ↓
Worker confirms success
    ↓
update observation_images.original_storage_path
```

If the original upload fails:

```text
full derivative may still exist
original_storage_path stays null
```

The client should be able to retry original sync later.

---

# 9. Failure behavior

Original preservation should not make normal observation publishing fragile.

Recommended policy:

## Normal derivative

Required.

If `full.webp` fails:

```text
publish fails / remains queued
```

## Thumbnail

Required under current normal policy.

## Original

Prefer asynchronous/retryable behavior.

If original upload fails:

```text
observation can still exist with full.webp
original sync remains pending
```

Do not block an otherwise valid observation indefinitely because a 15–50 MB source original failed to upload.

Represent original-sync state explicitly if necessary rather than inferring success from derivative state.

---

# 10. Quota policy

Originals will significantly increase storage usage compared with derivative-only storage.

Make an explicit product decision before rollout.

Possible policies:

## Option A — originals count normally

Simplest model:

```text
all stored bytes count toward quota
```

Recommended initially.

---

## Option B — originals are Pro-only

Free:

```text
thumb + full
```

Pro:

```text
thumb + full + original
```

This may fit the value proposition of:

```text
full-resolution source preservation
HDR preservation
cross-device backup
```

---

## Option C — user opt-in

Reuse the concept:

```text
sync_full_resolution_originals
```

This is attractive for `sporely-py`, but web/mobile imports may benefit from preserving originals by default if storage economics permit.

Do not make a silent product-policy choice inside implementation code.

---

# 11. sporely-py cloud sync

Complete the existing original-sync architecture.

Desired remote/local mapping:

```text
Cloud
│
├── storage_path
│   └── full.webp
│
└── original_storage_path
    └── original.heic
```

becomes:

```text
sporely-py local image
│
├── filepath
│   └── local working/display image
│
└── original_filepath
    └── downloaded HEIC original
```

---

## Download policy

Only download originals when:

```text
sync_full_resolution_originals = true
```

or according to whatever opt-in policy is finalized.

Do not automatically download all originals to every desktop installation.

---

## Existing local original wins

If `sporely-py` already has a readable local original:

```text
original_filepath exists
```

do not overwrite it merely because Cloud also has an original.

Treat cloud-original download primarily as:

```text
recovery / sync
```

not canonical replacement of an existing source file.

---

# 12. sporely-py rendering

Do not require native HEIC rendering for this project.

Normal desktop UI should continue to use:

```text
filepath → SDR working/display representation
```

The original can exist solely for:

* recovery
* export
* archival use
* future HDR display support
* opening externally

Optional later feature:

```text
Open original
```

using the operating system's native viewer.

Do not make HDR rendering in PySide part of this implementation.

---

# 13. sporely-web rendering

## Grids / review thumbnails

Continue using SDR derivatives.

Do not display original HEIC directly in:

* Import Review grid
* upload queue thumbnails
* observation grids
* map popups
* search results
* home/feed cards

This keeps mixed galleries visually consistent and avoids HDR brightness jumps.

---

## Full-screen owner viewer — future phase

Later, compatible devices may optionally display the original.

Conceptually:

```text
owner opens image
    ↓
original exists?
    ↓
client supports original format/HDR?
    ↓
yes → display original
no  → display full.webp
```

Do not make this a requirement for original preservation.

Preservation comes first.

---

# 14. sporely-landing

No HEIC support required.

Landing/public website continues to receive/display:

```text
full.webp
thumb.webp
```

The presence of an original must be invisible to `sporely-landing`.

No HEIC parsing, HDR detection, or fallback logic should be added there.

---

# 15. Public HDR — future separate project

If public HDR display becomes desirable, do not expose the user's original HEIC.

Generate a public-safe HDR derivative instead.

Potential future media model:

```text
original.heic      owner only
full-hdr.avif      public/friends according to observation visibility
full.webp          SDR fallback
thumb.webp         SDR
```

This should be a separate project after original preservation is stable.

Do not introduce HDR AVIF in the first implementation.

---

# 16. Metadata and privacy

Original HEIC may contain:

* GPS
* creation timestamp
* device model
* lens/camera metadata
* editing metadata
* color profile
* orientation data
* Apple-specific auxiliary images or gain maps

Therefore:

```text
original = private source object
```

Normal published derivatives should continue to use Sporely's existing EXIF/privacy policy.

Do not copy all original metadata into the public derivative.

---

# 17. Account deletion / purge

Original objects must participate in the same lifecycle as normal image media.

Deletion must remove:

```text
thumb
full
original
```

Account deletion, observation deletion, purge, tombstone cleanup, and quota accounting must all understand `original_storage_path`.

Audit:

* account deletion worker/function
* observation purge
* orphan-media cleanup
* storage-byte accounting
* admin cleanup/recovery tools

Do not leave original HEIC objects orphaned in R2.

---

# 18. Tombstones and storage accounting

Original bytes must be included in storage accounting when uploaded.

When an image is tombstoned:

* preserve original until normal retention/purge policy says to delete it
* do not decrement storage merely because UI visibility changed unless existing storage policy already does so
* decrement when the object is actually removed from storage

Keep derivative and original accounting behavior consistent.

---

# 19. Media authorization

Continue using Worker-controlled image-variant delivery.

Desired URL:

```text
GET /m/<image-id>/original?v=<media-version>
```

Rules:

```text
owner              → allowed
friends            → denied
public anonymous   → denied
other users         → denied
```

Do not expose raw `original_storage_path` to untrusted clients.

Do not restore direct public R2 URLs.

---

# 20. Implementation phases

## Phase 1 — Audit

Audit current state across:

```text
sporely-web
sporely-py
R2 Worker
Supabase schema/migrations
account deletion
storage accounting
```

Document:

* where original source bytes currently disappear
* where `original_storage_path` is already consumed
* whether the Worker can upload `original`
* whether private delivery supports `original`
* whether deletion already removes original objects
* whether quota accounting includes originals
* how upload queue persistence handles source files

No implementation until data-loss points are understood.

---

## Phase 2 — Preserve HEIC locally through web import

Ensure the selected HEIC survives conversion.

Required result:

```text
source HEIC
+
converted working representation
```

remain distinct throughout Import Review and upload queue.

Tests:

* HEIC source bytes remain unchanged
* conversion does not replace source reference
* retry/reload behavior does not silently convert archival original into JPEG
* JPEG import follows same original/derivative abstraction

---

## Phase 3 — Original cloud upload

Implement owner original upload using existing media infrastructure.

Required:

* `original` upload variant
* correct MIME type
* original storage key
* quota accounting
* `original_storage_path` finalization
* retry behavior
* no publish blocking if original upload alone fails

Tests:

* successful HEIC upload
* JPEG original upload
* oversized original rejection
* quota rejection
* retry after failure
* no DB path written before successful object creation

---

## Phase 4 — Original delivery

Verify/complete:

```text
GET /m/<image-id>/original
```

with strict owner-only authorization.

Tests:

* owner 200
* anonymous 404
* friend 404
* unrelated authenticated user 404
* stale media version 404
* missing original 404

---

## Phase 5 — sporely-py upload sync

Complete original upload support from desktop using:

```text
resolve_full_original_upload_source()
```

For converted local HEIC:

```text
original_filepath wins
```

Tests:

* HEIC original selected
* converted working file not uploaded when original exists
* fallback to working copy when original is unavailable and policy permits
* > 250 MiB limit respected
* opt-in respected

---

## Phase 6 — sporely-py download/recovery

Implement original recovery.

When:

```text
sync_full_resolution_originals = true
```

and:

```text
remote original exists
local original does not exist
```

download into a dedicated local original/cache path.

Do not overwrite existing canonical originals.

Tests:

* original recovered
* existing original preserved
* disabled setting performs no download
* failed downloads are retryable
* recovered HEIC retains exact bytes

---

## Phase 7 — lifecycle cleanup

Audit and test:

* delete observation
* account deletion
* purge
* tombstones
* quota decrement
* media authorization versioning
* cloud audit tooling
* orphan detection/recovery

Original files must not become untracked R2 objects.

---

## Phase 8 — optional HDR viewing

Only after preservation/sync is stable.

Add progressive original display to compatible owner clients.

Start with:

```text
sporely-web on Safari/macOS/iOS
```

Fallback:

```text
full.webp
```

Do not change grid thumbnails.

Do not make this part of the storage implementation.

---

# 21. Migration/backfill policy

Do not attempt to reconstruct originals from existing WebP derivatives.

For historical observations:

```text
original_storage_path = null
```

unless a real original is later uploaded from a device that still possesses it.

If `sporely-py` has the original locally and cloud metadata lacks it:

```text
desktop original sync may backfill original_storage_path
```

That is safe because the real source still exists.

Never label a WebP derivative as an original simply to fill the column.

---

# 22. Compatibility rules

All clients must behave correctly when:

```text
original_storage_path = null
```

and when:

```text
original_storage_path != null
```

Original support is additive.

Older clients that only know:

```text
storage_path
```

must continue to work.

This is important for staged rollout across:

```text
sporely-web
sporely-py
Android
PWA
landing
```

---

# 23. Testing matrix

## Formats

Test at least:

* JPEG
* HEIC
* HEIF if distinct samples exist
* PNG if currently accepted

---

## HEIC cases

Include:

* SDR HEIC
* HDR HEIC
* portrait orientation
* GPS north/east
* GPS south/west
* no EXIF
* large-resolution image
* unusually large source file

---

## Cloud

Verify:

```text
full.webp != original.heic
```

and byte-for-byte equality between:

```text
selected original
downloaded cloud original
```

Use SHA-256 in tests/integration tooling where practical.

---

# 24. Observability

Expose enough state to diagnose original sync without verbose permanent logging.

Useful states:

```text
original_local
original_pending
original_uploading
original_synced
original_failed
```

Do not infer these from thumbnail/full upload state.

Diagnostics should be opt-in or ordinary structured state, not continuous console noise.

---

# 25. Non-goals

Do not include in the first implementation:

* public HEIC delivery
* HEIC thumbnails
* making HEIC the canonical display image
* PySide HDR renderer
* public HDR galleries
* AVIF HDR generation
* RAW support
* Apple Photos integration
* editing/re-encoding originals
* automatic format transcoding on the server

---

# 26. Recommended rollout order

Implement in this order:

```text
1. Preserve source HEIC locally
2. Upload original to R2
3. Secure owner-only original delivery
4. Lifecycle/quota/delete support
5. sporely-py original upload
6. sporely-py original recovery
7. Ship and observe
8. Add optional HDR viewing later
```

Do not begin with HDR display.

The critical first milestone is:

> **After a HEIC image enters Sporely, its original bytes are never irreversibly discarded.**

---

# 27. Acceptance criteria

The project is complete when all of the following are true:

* Importing an HEIC produces normal Sporely WebP derivatives.
* The exact original HEIC remains available separately.
* The original uploads to Cloudflare R2.
* `original_storage_path` references it.
* The normal `storage_path` still references the SDR display derivative.
* Public clients never require HEIC support.
* Original media is owner-only.
* Storage accounting includes the original.
* Purge/account deletion removes the original.
* `sporely-py` can optionally upload/download the original.
* A downloaded HEIC is byte-identical to the uploaded source.
* Existing observations without originals continue to work.
* `sporely-landing` requires no HEIC changes.
* HDR display remains optional and can be added later without changing the storage model.

---

# 28. Suggested first implementation task

Start with a cross-repo audit and produce an implementation map before editing code.

The audit should answer:

1. Where does `sporely-web` currently lose the source HEIC?
2. Can Import Review/upload queue retain the original Blob safely across its current lifecycle?
3. Does the Worker already accept `X-Sporely-Upload-Variant: original`?
4. Does upload authorization correctly validate `original_storage_path`?
5. Does quota accounting include original uploads?
6. Does account/observation deletion delete `original_storage_path` objects?
7. What state is missing to represent original upload pending/failed/synced?
8. Which pieces of `sporely-py` original upload/download are already implemented versus policy-only?
9. Can original sync be completed without changing normal desktop rendering?
10. What is the smallest staged implementation that prevents HEIC source loss immediately?

Do not make broad changes until this audit is complete.
