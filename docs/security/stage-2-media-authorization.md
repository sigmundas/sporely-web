# Stage 2 — Private Media Storage and Authorized Delivery

**Status:** design + Stage 2a implementation (three review rounds applied)
**Branch (intended):** `fix/private-media-delivery`, stacked on `fix/lock-down-observation-sync`
**Migrations (final Stage 2a set):**
- `20260803120000_lock_down_observation_sync_tables.sql` (Stage 1)
- `20260805120000_media_authorization.sql` (Stage 2a foundation)
- `20260805130000_media_authorization_hardening.sql` (round 1 hardening)
- `20260805140000_media_authorization_variant_matrix.sql` (round 2: variant matrix + key-aliasing prevention)
- `20260805150000_media_authorization_read_integrity_and_mosaic.sql` (round 3: mosaic identity, read-time integrity, final-state guard, protected origin, revoked helper grant)

## 1. Threat model

- **Leaked URL is permanent.** Bare `media.sporely.no/<key>` CDN URLs remain
  retrievable indefinitely after visibility, draft, tombstone, purge, or
  moderation state changes.
- **Prefix ≠ authorization.** Legacy worker `canReadMediaKey` treated a
  UUID-prefixed key as authorized. Removed.
- **Cache is a liability.** The historic `public, max-age=31536000, immutable`
  header persists past database revocation.
- **Community/friend/follow views leak keys** — Stage 1 tightened row
  visibility but the projected columns still include raw R2 keys. Stage 2b
  removes them.
- **`original` variant leak.** A pre-round-2 RPC applied uniform visibility to
  every variant, exposing `original_storage_path` on any public row.
- **Key aliasing via `original_storage_path`.** `storage_path` was constrained
  by RLS to the row owner's UUID namespace; `original_storage_path` was not.
  Rejected by round-2 trigger; enforced at read time by round-3 RPC.
- **Mosaic identity confusion.** Round 2 treated `mosaic` as an
  observation-image variant using an unrelated storage key. Round 3 moves
  mosaics to their own identity (`spore_measurement_mosaics.id`) with a
  dedicated route + RPC.
- **Session GUC redirect.** Round-1 URL builder read from
  `app.settings.media_worker_base_url` — any session, including anon, could
  override it. Round-3 replaces this with a protected single-row config
  table read via SECURITY DEFINER; the GUC is no longer consulted.
- **Nested trigger bypass.** Round-1 guard trusted any nested-trigger
  context. Round-3 adds an AFTER trigger that enforces the final `+0/+1`
  monotonic transition on `media_version` regardless of trigger nesting.
- **Overwrite destroys prior bytes.** Historic R2 `put` atomically replaces
  the object; if downstream DB finalization fails, the previous bytes are
  gone. Round-3 introduces a temp-key + promote state machine for
  `MEDIA_STORAGE_MODE=private`: bytes are staged under `<key>.pending-<nonce>`
  and only promoted to the final key AFTER quota + canonical_bucket PATCH
  succeed; on failure only the temp is deleted, original bytes intact.

## 2. Invariants

1. Private, friends-only, draft, deleted, purged, moderated, or banned-owner
   media MUST NOT be fetchable via any URL a client can construct from data
   it already has.
2. Every state change that would deny access MUST take effect on the next
   media request. No external CDN purge dependency.
3. Public media MAY be edge-cacheable BUT ONLY behind the Worker with a
   cache key that includes `media_version`, AND ONLY once a dedicated
   revocation test proves authorization-before-cache. **Stage 2a ships all
   `/m/` and `/mm/` responses with `Cache-Control: no-store`.**
4. Client Cache-Control on uploads MUST NOT influence stored canonical
   metadata in the private bucket.
5. Canonical uploads MUST go to a bucket with no public custom-domain and
   no public-development URL, once `MEDIA_STORAGE_MODE=private` is set.
6. Delivery is image/variant based; the Worker resolves keys server-side.
   Clients do not present arbitrary keys.
7. Trusted internal callers (Artsorakel, admin purge, account deletion) go
   through the same authorization decision function.
8. Server-owned fields (`canonical_bucket`, `media_version`) MUST NOT be
   writable by client roles by any path (direct or nested-trigger). The
   AFTER final-state guard enforces this.
9. `storage_path` AND `original_storage_path` MUST live under the row
   owner's UUID namespace. Enforced by the write guard AND re-checked at
   read time (defence in depth against legacy or trusted-role-written
   malformed rows).
10. A post-write failure MUST NOT destroy previously valid bytes at the
    canonical key.
11. Stage 3 (server-side EXIF, sensitive species, randomized keys,
    broad rate limits, CORS cleanup) is out of scope.

## 3. Design

### 3.1 Storage topology

- **`sporely-media`** (existing) — retained transiently as read-only "legacy"
  during backfill. No new uploads once `MEDIA_STORAGE_MODE=private`. Its
  public custom-domain `media.sporely.no` is manually detached at
  Stage 2c cutover.
- **`sporely-media-private`** (new — provisioned at Stage 2c) —
  `custom_domain=false`, no public-development URL. Bound to the Worker as
  `env.PRIVATE_MEDIA_BUCKET`.
- The Worker's `env.MEDIA_BUCKET` binding remains pointed at the legacy
  bucket so delivery can transparently serve either bucket based on the
  row's `canonical_bucket`.

### 3.2 URL shapes

- Image delivery:  `https://upload.sporely.no/m/<image_id>/<variant>?v=<media_version>`
- Mosaic delivery: `https://upload.sporely.no/mm/<mosaic_id>?v=<media_version>`

`variant` MUST be one of `full`, `thumb`, `original`. Mosaic is NOT an image
variant. `v` MUST be a positive integer matching the row's current
`media_version` at emission time; the Worker rejects any URL whose `v` does
not match.

### 3.3 Image delivery identity

`observation_images`:
- `media_version bigint NOT NULL DEFAULT 1 CHECK (media_version >= 1)`
- `canonical_bucket text NOT NULL DEFAULT 'legacy' CHECK (canonical_bucket IN ('legacy','private'))`

Version-bump triggers fire on `visibility`, `is_draft`, `user_id`
(cascaded to child images), `deleted_at`, `purged_at`, `storage_path`,
`original_storage_path`, `canonical_bucket`, and `is_banned` (cascaded).

### 3.4 Mosaic delivery identity (round 3)

`spore_measurement_mosaics`:
- `media_version bigint NOT NULL DEFAULT 1 CHECK (media_version >= 1)`
- `canonical_bucket text NOT NULL DEFAULT 'legacy' CHECK (canonical_bucket IN ('legacy','private'))`

Version-bump triggers fire on:
- `spore_measurement_mosaics.storage_key`, `canonical_bucket`,
  `observation_id` change (BEFORE UPDATE on the mosaic row).
- Parent `observations.visibility`, `is_draft`, `spore_data_visibility`,
  `user_id` change (AFTER UPDATE on `observations`, cascaded to every
  mosaic of the observation).

The mosaic version-bump is not currently triggered by `profiles.is_banned`
change; the authorization RPC re-checks `is_banned` at read time so a bump
is not strictly necessary for revocation, but Stage 2b will add it for
symmetry with the image path.

### 3.5 Variant allowlist

Canonical image variants: `full`, `thumb`, `original`. Enforced by
`public.media_variant_is_supported(text)` (Postgres) and the exported
`MEDIA_VARIANTS` constant (Worker). NULL, empty string, whitespace, and
mixed-case inputs all yield false. Unknown variants never construct a
URL (`build_worker_media_url` returns NULL) nor pass authorization.

### 3.6 Owner-only originals

`p_variant='original'` invokes an owner-only branch in
`media_authorize_delivery`. No non-owner path: not for public, not for
friends, not for accepted friends of the owner. `original_storage_path` is
returned only to the owner and only if it lives under the row owner's
namespace.

### 3.7 Spore-aware mosaics

`media_authorize_mosaic_delivery` requires BOTH:
- observation visibility permission (owner, public, or accepted friend on
  friends observation), AND
- spore-data-visibility permission (owner, public, or accepted friend on
  friends spore data).

Private spore_data_visibility restricts to the owner only, regardless of
observation visibility.

### 3.8 Protected Worker origin

`public._media_worker_config` — single-row superuser-owned table holding
the Worker base URL. Not SELECTable by anon/authenticated/service_role
directly. Read via SECURITY DEFINER helper
`public._media_worker_base_url()` which is EXECUTE-granted to
anon/authenticated/service_role. The prior `app.settings.media_worker_base_url`
session GUC is no longer read; anon and authenticated cannot influence
the emitted host.

### 3.9 Storage-mode / bucket selection

`MEDIA_STORAGE_MODE` env determines the target: `legacy` →
`env.MEDIA_BUCKET`, `private` → `env.PRIVATE_MEDIA_BUCKET`. Missing binding
in the selected mode is a 500. Private mode NEVER falls back to
`MEDIA_BUCKET`. `/healthz` reports the mode + binding availability + the
variant allowlist without exposing secrets.

### 3.10 Upload lifecycle

`PUT https://upload.sporely.no/upload/<key>` with Bearer JWT.

1. Resolve storage mode and target bucket. Fail closed on config error.
2. Verify JWT + key must start with `<claims.sub>/`.
3. `X-Sporely-Upload-Variant` in `MEDIA_VARIANTS` (legacy aliases
   `small`/`medium`/`cards`/`preview` coerced to `thumb`; unknown → 400).
4. Content-length / body / dimension caps.
5. Head existing object → `existingBytes`, `isOverwrite`.
6. Profile / quota / ban checks.
7. `X-Sporely-Image-Id`: REQUIRED in private mode. Row must exist, be owned
   by caller, and its `storage_path` (or derived thumb key) must match the
   URL key.
8. **Write to `writeKey`** — for a private-mode overwrite,
   `writeKey = <key>.pending-<nonce>`. Otherwise `writeKey = key`. The
   Worker sets `Cache-Control: private, no-store` on the R2 object in
   private mode; client Cache-Control is ignored.
9. Quota tally (`apply_profile_storage_delta`). On failure: delete
   `writeKey` (which is either the final key on a first upload, or the
   temp key on an overwrite — original bytes preserved in the latter case).
10. `canonical_bucket` PATCH — private mode only. On failure: delete
    `writeKey`, invert the quota delta.
11. **Promote (overwrite case)**: put `bodyBuffer` to the final `key`
    with new metadata; then delete the temp `writeKey`. Any failure
    during promotion leaves the previous `key` bytes intact and returns
    500.
12. Response: `{ ok, key, etag, size, canonical_bucket, storage }`. No
    `url` field in private mode.

### 3.11 Delivery lifecycle

`GET /m/<image_id>/<variant>?v=<v>` and `GET /mm/<mosaic_id>?v=<v>`
follow the same pattern:

1. Parse identity + variant (image only) + `v` — all must be
   syntactically valid. Any malformation → 404.
2. Optional Bearer → `callerSub`.
3. RPC decision (`media_authorize_delivery` or
   `media_authorize_mosaic_delivery`) via service role.
4. Deny → 404. Version mismatch → 404. Missing bucket binding → 500.
5. Per-variant key derivation (`thumb` → `deriveThumbKey(storage_path)`;
   others → verbatim). Mosaics: `storage_key` verbatim.
6. `bucket.get(objectKey)`. Missing object → 404.
7. `Cache-Control: no-store` + `Vary: Authorization` + ETag from R2.

### 3.12 Read-time integrity (round 3)

`media_authorize_delivery` fails closed on:
- `canonical_bucket` NOT IN (`legacy`, `private`) → `invalid_bucket`.
- `media_version < 1` → `invalid_media_version`.
- `observation_images.user_id <> observations.user_id` → `owner_mismatch`.
- `storage_path` (for full/thumb) not under owner namespace →
  `invalid_storage_namespace`.
- `original_storage_path` (for original) not under owner namespace →
  `invalid_original_namespace`.
- `original_storage_path` NULL/empty for `original` → `metadata_only`.
- `storage_path` NULL/empty for full/thumb → `metadata_only`.

These are re-checked at read time even though the write guard enforces
them at write time, so a legacy row or a trusted-role-inserted malformed
row cannot be served.

`media_authorize_mosaic_delivery` performs equivalent integrity checks:
`invalid_bucket`, `invalid_media_version`, `owner_mismatch`, `no_key`.

### 3.13 Server-owned field guard

Three-layer defence:

1. **RLS INSERT/UPDATE policies** on `observation_images` require
   `user_id = auth.uid()` and `storage_path` prefix.
2. **`trg_01_media_guard_key_ownership` (BEFORE)** — SECURITY DEFINER,
   trust boundary is `auth.uid() IS NULL`. For untrusted callers,
   verifies `NEW.user_id = auth.uid()`, `user_id = observations.user_id`,
   `storage_path` and `original_storage_path` namespace, and freezes
   `observation_id` / `user_id` on UPDATE.
3. **`trg_zz_media_final_state_guard_image` (AFTER)** — SECURITY DEFINER,
   trust boundary is `auth.uid() IS NULL`. For untrusted callers:
   `canonical_bucket` cannot change; `media_version` transitions must be
   exactly 0 or +1. A rogue BEFORE trigger that mutates NEW past the
   BEFORE guard's check is still rejected here at the committed final
   state.

Equivalent AFTER trigger on `observations` for its `media_version`.

The `auth.uid() IS NULL` trust signal is used because Supabase's PostgREST
pool always logs in as `postgres` and only `SET ROLE`s to anon/authenticated
after connection — so neither `session_user` nor `current_user` is a
reliable trust discriminator. `auth.uid()` is NULL for migrations and
service_role calls (no JWT context) and NON-NULL for authenticated
clients. Anon calls to observation_images writes are blocked by RLS
before reaching the trigger, so `auth.uid() IS NULL` is safe here as the
trusted-caller signal.

The RLS-bypass helper `_media_get_observation_user_id` is REVOKEd from
anon/authenticated/service_role after round 3 — the write guard reaches
it via SECURITY DEFINER (its function ownership is `postgres`), so
client-role EXECUTE grants are not required for the trigger to function.

### 3.14 Deployment recommendations

**Not fully dormant.** Triggers, guards, and new public routes are all
observable behaviour on deployment.

Deploy in order:
1. Database migrations `20260805120000` + `20260805130000` +
   `20260805140000` + `20260805150000`. Adds columns, triggers,
   RPCs, `_media_worker_config`, and the mosaic identity. Write behaviour
   changes only for the guarded columns; ordinary user-editable columns
   unaffected.
2. Worker (with `MEDIA_STORAGE_MODE=legacy`). New `/m/`, `/mm/` routes
   are inert until Stage 2b consumers emit URLs. Legacy `PUT /upload/*`
   continues to work unchanged except for variant allowlist enforcement
   (client aliases coerced).

**Not safe** to set `MEDIA_STORAGE_MODE=private` until Stage 2b consumers
ship (they stop reading response `url`) AND Stage 2c legacy backfill
completes.

**Not safe** to detach `media.sporely.no` custom-domain until Stage 2c
backfill success is confirmed.

### 3.15 Remaining legacy bypass

The `media.sporely.no` public custom-domain remains attached to the
legacy `sporely-media` bucket until Stage 2c. Until it is detached:

- Any client that already knows a legacy `<user>/…` key can retrieve it
  directly, bypassing the Worker and the authorization RPC.
- The Worker cannot enforce revocation on those requests.

The only definitive fix is Stage 2c cutover (detach the custom domain).
Stage 2a mitigates by: (a) not emitting any new `media.sporely.no` URLs
in RPCs (Stage 2b), (b) refusing to write new bytes to the legacy bucket
once `MEDIA_STORAGE_MODE=private` is activated.

### 3.16 Stage 2b / 2c scope

**Stage 2b (next review pass — consumer cutover):**
- Update public RPCs (`search_public_observation_images`,
  `get_public_observation_images`, `get_public_observation`,
  `get_public_spore_comparison_set`, species/spore URL emitters) to
  emit `/m/` and `/mm/` URLs via `build_worker_media_url` + mosaic
  equivalent.
- Drop `storage_path` from `observation_images_community_view`; drop
  `image_key`/`thumb_key` from `observations_community_view` etc.
- `src/images.js`: `getWorkerMediaUrl(imageId, variant, version)` and
  mosaic equivalent; refactor `resolveMediaSources`; retire direct URL
  construction.
- Frontend consumers: map, finds, find_detail, home.
- Signed-URL variant of `/m/` and `/mm/` for `<img src=…>` inline
  consumption.
- Repo guard test blocking new direct URL construction.
- Enable Cloudflare Cache API for `cache_class='public'` responses
  AFTER a dedicated revocation test proves authorization-before-cache.
- Desktop client updates in `sporely-py` — retire the public-CDN
  download fallback in `utils/cloud_sync.py:11504-11530`.
- CSP: remove `media.sporely.no` from `img-src`/`connect-src` when no
  consumer references it.
- Add mosaic `is_banned` cascade for symmetry with the image path.

**Stage 2c (final — legacy cutover + deployment):**
- Provision `sporely-media-private` R2 bucket.
- Legacy backfill script + `media_backfill_runs` audit table:
  enumerate → HEAD → COPY → HEAD verify → UPDATE canonical_bucket.
  Idempotent, restartable, `--dry-run`.
- Admin-ops `MEDIA_PUBLIC_BASE_URL` reroute.
- Set `MEDIA_STORAGE_MODE=private` env on the Worker.
- Detach `media.sporely.no` custom-domain in Cloudflare dashboard
  AFTER backfill success.
- Documented rollback that does not re-expose the legacy bucket.
