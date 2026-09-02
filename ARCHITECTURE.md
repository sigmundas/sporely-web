# Sporely Web — Architecture

## What this is

> For Supabase schema, RLS rules, and Storage conventions see [SUPABASE_DB.md](SUPABASE_DB.md).

A mobile-first PWA companion to the Sporely desktop app (PySide6 / SQLite).
Field capture (GPS + photos) and cloud sync via Supabase + Cloudflare. Not a replacement
for the desktop — the desktop owns taxonomy, microscopy, and publishing to
Artsobservasjoner, Artportalen, iNaturalist, and Mushroom Observer.

The same codebase also ships as a Capacitor Android app. The Android wrapper is
primarily there for more reliable file import, especially native HEIC/EXIF/GPS
handling from the device photo library.

---

## Stack

| Layer | Choice |
|---|---|
| Build | Vite 6, vanilla JS (ES modules) — no framework |
| Native wrapper | Capacitor Android + `@capawesome/capacitor-file-picker` + `@capawesome/capacitor-background-task` + custom `NativePhotoPicker` plugin |
| Styling | Plain CSS custom properties, no preprocessor |
| Auth & DB | Supabase JS v2 (`@supabase/supabase-js`) |
| Media storage | Cloudflare R2 bucket `sporely-media` |
| Media upload | Cloudflare Worker at `upload.sporely.no` (JWT-authenticated PUT/DELETE) |
| Media serving | Public CDN at `https://media.sporely.no` |
| Account/storage foundation | Supabase profile plan flags + worker-enforced storage tally/quota |

Supabase Storage (`observation-images`) is legacy-only and must not be used for
new uploads or as a media fallback. All canonical media now goes through the
Cloudflare R2 pipeline.

---

## Testing & Auditing

| Layer | Choice |
|---|---|
| Static Analysis | ESLint (planned) for automating the 10-point code review checklist |
| Unit Testing | Vitest (planned) for testing core logic like sync queues, AI crop math, and deduplication |
| Database | Supabase local testing utilities / pgTAP (planned) for automated RLS policy auditing |
---

## File structure

```
sporely-web/
├── index.html              Full app shell + auth overlay HTML (no JS inline)
├── package.json
├── cloudflare/
│   └── r2-upload-worker/   Cloudflare Worker for authenticated R2 uploads
│       ├── src/index.js    Worker source — JWT verify, R2 put, CORS
│       └── wrangler.toml   Worker config — routes, vars, R2 binding
├── supabase/
│   ├── config.toml         Supabase local/deploy config for Edge Functions
│   ├── profile-storage-usage.sql Supabase profile storage/quota tally helper
│   └── functions/
│       └── delete-account/
│           └── index.ts    Self-service account deletion (service-role Edge Function)
├── vite.config.js
└── src/
    ├── main.js             Entry point — hash parsing, session check, boot, deferred auth pipeline
    ├── supabase.js         createClient (URL + publishable key); early-boot SIGNED_OUT capture
    ├── state.js            Single shared mutable object (no reactivity layer)
    ├── router.js           navigate(screen) — swaps .active class, starts/stops camera
    ├── map-loader.js       Lazy loads the map screen so Leaflet stays off the startup path
    ├── toast.js            showToast(msg) — timed overlay message
    ├── geo.js              Location service/state, watchPosition, session tokens, location-state events
    ├── auth-state.js       6-state machine (RESOLVING / UNAUTHENTICATED / INCOMPLETE / COMPLETE / CACHED / REAUTH_REQUIRED)
    ├── auth-classification.js Refresh-side reject classifier + /auth/v1/health reachability probe
    ├── auth-session.js     getSharedAuthSession — 1 s in-memory session cache
    ├── auth-signout.js     performExplicitSignOut + consumeExplicitSignOutRequest (purge seam)
    ├── capabilities.js     canPerformCloudMutation / requiresReauthentication / capability gate
    ├── reauth.js           beginReauthentication / setReauthHandler — single recovery seam
    ├── last-validated-account.js B1 "device ever validated this identity online" snapshot (localStorage)
    ├── local-data-owner.js Draft-store ownership marker (IndexedDB) — privacy boundary
    ├── account-transition.js Monotonic generation token + A→B transition blocker overlay
    ├── home-cache.js       Per-user Home read-model cache (IndexedDB) — stale-while-revalidate
    ├── native-network.js   @capacitor/network monitor — OS-level wake-up hint for the revalidation pipeline
    ├── cloud-plan.js       Cloud plan lookup + effective upload policy helpers
    ├── settings.js         Local Settings preferences: camera, image resolution, sync history
    ├── images.js           Worker-backed image preparation, uploads + thumbnail variants, media URL helpers
    ├── image-worker.js     Off-main-thread resize/encode worker using OffscreenCanvas
    ├── image_crop.js       Shared AI crop math + cropped blob export helpers
    ├── ai-crop-editor.js   Full-screen AI crop editor used by review/import flows
    ├── sync-queue.js       IndexedDB offline queue for captured observations + background-task sync drain
    ├── import-store.js     IndexedDB persistence for pending import sessions
    ├── boot-timings.js     window.__sporelyBoot mark/measure registry — startup instrumentation
    ├── debug-dashboard.js  In-app debug overlay bound to window.__sporelyBoot
    ├── style.css           All CSS (custom properties, no utility classes)
    └── screens/
        ├── auth.js         Login, signup, resend confirmation, hash error handling, reauth overlay
        ├── home.js         Dashboard, recent finds from Supabase, sign-out, REAUTH banner
        ├── finds.js        Observation lists (Mine, Friends, Community, User) + Spores filter
        ├── capture.js      Camera (getUserMedia), shutter, batch capture
        ├── review.js       Review one captured observation batch, save to Supabase
        ├── import_review.js Import/group photos, native EXIF/GPS handling, save flow
        └── profile.js      Profile editing, avatar crop/upload, friends + blocked-users management, delete-account action, REAUTH banner
```

---

## Supabase connection

**Project URL:** `https://zkpjklzfwzefhjluvhfw.supabase.co`
**Key type:** Publishable (anon) key — safe to expose in client code; RLS enforces access.
**JWT algorithm:** ES256 (ECC P-256) — Supabase switched from HS256 to ES256.

All database requests go through the `supabase` client instance in `src/supabase.js`.
Raw `fetch` is no longer used for Supabase — everything goes through the SDK.

The client is created with `flowType: 'pkce'` and a custom `detectSessionInUrl` that
suppresses the OAuth callback hash parse on `/auth/callback` paths; `autoRefreshToken`
and `persistSession` are intentionally left at the supabase-js v2 defaults (both `true`).
Any future change that disables them — e.g. switching to a non-localStorage backing —
must update the auth state machine and the cached-boot classifier accordingly; the
"stay logged in" UX relies on the background refresh timer that `autoRefreshToken: true`
installs.

`src/supabase.js` also runs an early `onAuthStateChange` capture at module load. `auth-js`
calls `_recoverAndRefresh()` synchronously when the client is created, and a
non-retryable refresh rejection can remove the stored session + emit `SIGNED_OUT` before
`main.js` has had a chance to subscribe. The early capture buffer records event NAMES
(never tokens / sessions) so the deferred boot classifier can detect
`hadEarlyBootSignOut()` and route the launch into `AUTHENTICATED_REAUTH_REQUIRED` instead
of `UNAUTHENTICATED`. This is the *login limbo* fix from the v0.7.2 release.

---

## Auth state machine

The auth state lives in `src/auth-state.js`. It is a six-state enum (`AUTH_STATE`) with
`getAuthState` / `setAuthState` / `subscribeAuthState` and two derived predicates:

- `isAuthorizedForAuthenticatedNetworkOps(state)` — `true` only for
  `AUTHENTICATED_COMPLETE`. Every authenticated RPC, write, and upload calls this (via
  `canPerformCloudMutation()`) before dispatch.
- `isTerminallyResolvedAuthState(state)` — `true` for `AUTHENTICATED_COMPLETE` and
  `AUTHENTICATED_INCOMPLETE` only. The resolver's `_resolvedUsers` dedupe *combines* this
  with `_resolvedUsers.has(userId)` to decide whether a same-user `SIGNED_IN` is a no-op;
  CACHED and REAUTH_REQUIRED are intentionally NOT terminal so a live reconnect re-enters
  the resolver and lifts the state back to COMPLETE (this is the round-5 fix, commit
  `862af60`).

### The six states

| State | Meaning | UI surface | Authorizes network ops? |
|---|---|---|---|
| `RESOLVING` | Initial classification in flight | Auth overlay (or blank shell) | No |
| `UNAUTHENTICATED` | No session, no usable local identity | Auth overlay (login / signup) | No |
| `AUTHENTICATED_INCOMPLETE` | Signed in, profile setup not finished | Profile setup sheet over the app shell | No |
| `AUTHENTICATED_COMPLETE` | Online, server-validated this launch | Full app | **Yes (only state)** |
| `AUTHENTICATED_CACHED` | Device previously validated this identity online; current launch could not reach Supabase | Cached shell + Offline pill | No (capability gate denies) |
| `AUTHENTICATED_REAUTH_REQUIRED` | Device previously validated this identity online; current launch reached Supabase but the local session is unrecoverable | Cached shell + REAUTH banner ("Session expired" / "Sign in again") | No (capability gate denies) |

### Reachability probe vs session authority

`src/auth-classification.js` runs two distinct things, and conflating them is the most
common review error:

1. **`isExplicitAuthRejection(err)`** — matches *refresh-side* signals only
   (`invalid_grant`, `invalid refresh token`, `refresh_token_not_found`,
   `refresh_token_already_used`, `refresh token expired`, `user_not_found`,
   `session_not_found`). A bare `"JWT expired"` from the access token is deliberately
   NOT included — supabase-js's `autoRefreshToken` timer refreshes access tokens in the
   background; a bare access-token expiry is the normal "stay logged in" path, not a
   "session expired" event. Treating it as a reject would deny cached boot on every
   offline launch (this is the `auth-classification.test.js:39-42` regression guard).
2. **`probeBackendReachability({ timeoutMs: 3000 })`** — a tiny anonymous GET to
   `<project>/auth/v1/health` with the publishable `apikey` header, no tokens, `no-store`.
   `< 500` → `reachable`. The probe is the *only* way `AUTHENTICATED_CACHED` and
   `AUTHENTICATED_REAUTH_REQUIRED` are distinguished: same null session on the device,
   two different answers from the probe. The probe is *never* the authority for the
   session itself.

### Cached-boot privacy boundary

A cached reveal requires **two** local records to agree on the user:

- `readLastValidatedAccount()` — a `localStorage` record of the last online resolution
  for this device (`src/last-validated-account.js`).
- `getLocalDataOwner()` — an IndexedDB marker of who owns the draft store
  (`src/local-data-owner.js`).

If either is missing, or the two disagree, the cached reveal fails closed:
`clearLastValidatedAccount()` + `UNAUTHENTICATED`. This is the A→B privacy boundary — a
user who clears the snapshot must not be able to silently boot into a different user's
cached Home. See `src/offline-boot.test.js` for the contract and the
`reauth-ux.test.js` / `auth-reauth-recovery.test.js` guards.

### Deferred event pipeline

supabase-js holds an internal auth lock while dispatching `onAuthStateChange`. Awaiting
*any* Supabase API in the direct listener (`exchangeCodeForSession`, PostgREST, RPC,
`signOut`, `getSession`, …) deadlocks that lock — the current event never returns and
the next auth call hangs forever. The fix is enforced in `src/main.js`
`enqueueAuthEvent` / `_handleDeferredAuthEvent` and pinned by
`src/auth-deadlock.regression.test.js`: the direct callback is non-async, returns
immediately, and enqueues onto a single promise chain. The deferred handler runs the
resolve / sign-out / cached-revalidation pipeline outside the lock. **Do not**
"simplify" this by inlining the handler — the deadlock is not a hypothetical (it was
the bug that motivated the test).

### Live-reconnect pipeline (cached → complete)

When the app is in `AUTHENTICATED_CACHED` or `AUTHENTICATED_REAUTH_REQUIRED`, ten wake-up
sources converge on a single deduped + throttled revalidation entry point in
`src/main.js` `requestConnectivityRevalidation(reason, options)`:

| Source | Reason string | File / line |
|---|---|---|
| Native `@capacitor/network` `networkStatusChange` false→true | `native-network-change` | `src/native-network.js:170-179` |
| Native `App.resume` → `Network.getStatus()` | `native-resume-status` | `src/native-network.js:206-216` |
| Native `visibilitychange`→visible → `Network.getStatus()` | `native-resume-status` | `src/native-network.js:196-204` |
| Web `window 'online'` | `web-online` | `src/main.js:1897` |
| Web `window 'focus'` | `focus` | `src/main.js:1901` |
| Web `visibilitychange`→visible | `visibility` | `src/main.js:1905-1907` |
| 15 s cached watchdog (foregrounded CACHED only) | `cached-watchdog` | `src/main.js:422-470` |
| 5 s boot deferred re-probe (one-shot, only when initial reachability was `unreachable`) | `deferred-probe` | `src/main.js:1916-1920` |
| Finds pull-to-refresh | `finds-pull-refresh` (user-initiated; bypasses throttle) | `src/main.js:312-320` |
| Native `Network.getStatus()` polled check | `RESUME_STATUS` | `src/native-network.js:84-92` |

`requestConnectivityRevalidation` is a no-op in COMPLETE (it only nudges `triggerSync()`;
it does not re-run the resolve pipeline) and in any non-cached state other than COMPLETE.

`_attemptCachedRevalidation(source, { force })` holds the `_cachedRevalidationInFlight`
single-flight guard and the `CACHED_REVALIDATION_MIN_RETRY_MS = 12_000` automatic-attempt
throttle. Only `USER_INITIATED_REVALIDATION_REASONS` (currently just `finds-pull-refresh`)
and `options.force = true` bypass the throttle; the throttle is *never* bypassed for the
auth/capability gates or the single-flight guard.

`navigator.onLine`, `@capacitor/network` `connected`, and `networkStatusChange` are
**wake-up hints only** — the *real* authority is the `probeBackendReachability()` result
and the resulting `getSharedAuthSession({ refresh: true })` call. Device QA has proven
twice that native connectivity state is not reliable enough to be a *prerequisite* for
recovery (the round-4 regression). The 15 s cached watchdog runs an HTTP probe directly
without consulting the OS status.

---

## Sign-out semantics

There are exactly **two** sign-out paths and they must stay distinct. `src/auth-signout.js`
is the seam that classifies them.

### Explicit sign-out (user-initiated)

Any code that wants to sign the user out — Logg ut in the Profile sheet, delete-account,
password-reset flows, the "use another account" path on the setup screen, the
resolution-error escape — **must** call `performExplicitSignOut()`. The function sets an
`_explicitSignOutRequested` flag *before* the underlying `supabase.auth.signOut()` call,
then awaits the promise. The deferred `SIGNED_OUT` handler consumes the flag.

An explicit sign-out triggers the full purge:

- `clearLastValidatedAccount()` — the B1 snapshot dies here, so the next launch cannot
  boot offline.
- `clearSharedAuthSessionCache()` — the 1 s in-memory session cache.
- `_resolvedUsers.clear()` and `_resolutionInFlight.clear()` — the resolver dedupe memory.
- `beginAccountTransition()` + `clearUserScopedUi()` — DOM is blanked synchronously before
  any await, so no A's content can paint after this line.
- `_purgeUserDrafts()` — IndexedDB observation draft store. If this fails, the owner
  marker is preserved for the next-boot retry; the snapshot still dies immediately so
  cached boot fails closed regardless.
- `clearHomeCache(signedOutUserId)` and `clearMediaCacheForUser(signedOutUserId)` —
  user-scoped Home read-model and media blob caches.
- `forceCloseProfileOverlay()` and `_hideProfileResolutionError()`.

A direct `supabase.auth.signOut()` call would skip the flag and be misclassified as
internal session loss — the purge would never run, the user would still see a logged-in
shell, and queued work would be wiped by the wrong path. **Do not** call
`supabase.auth.signOut()` directly; route through `performExplicitSignOut()`.

### Internal session loss (auth-js self-purge)

`auth-js` also emits `SIGNED_OUT` on its own when it removes an unrecoverable stored
session — typically a non-retryable refresh rejection (refresh-token rotation race,
server-side revocation). This is the path the deferred handler at
`src/main.js:2175-2184` intercepts via `_isInternalSessionLossForTrustedUser()`. It
classifies the event before purging anything; if the trust invariants hold (snapshot
exists, owner marker matches, user id matches the resolved state), it pins
`AUTHENTICATED_REAUTH_REQUIRED` for the SAME user instead of purging. The capability
gate blocks every cloud op, the Profile sheet surfaces the "Sign in again" recovery,
queued observations and drafts survive, and the cached Home stays up — the user sees
the banner, not a sign-out.

The trust invariants are the same `last-validated-account` + `local-data-owner` pair
used by `_tryCachedAuthenticatedBoot`. If either is missing, the path falls through to
the full purge. This is the "always-online user" case: an internal session loss becomes
a recovery prompt, not a data loss.

### Recovery via `beginReauthentication`

The shared recovery seam is `beginReauthentication(prefillEmail)` in `src/reauth.js`,
injected once by `main.js` at init. The handler authenticates *without* signing out
first. A successful same-user sign-in fires `SIGNED_IN` →
`resolveAuthenticatedSessionOnce` → `_revalidateCachedRevealInPlace` →
`AUTHENTICATED_COMPLETE` (the `isUserAlreadyResolved` round-5 fix). A different-user
sign-in takes the existing full account-transition privacy boundary unchanged.

`beginReauthentication` is a no-op outside `AUTHENTICATED_REAUTH_REQUIRED` — a stale
button click can never open the login overlay over a live session, and a plain-offline
CACHED user can never trigger the reauth overlay. This is enforced by
`canBeginLoginOAuth()` in `src/capabilities.js` and pinned by `src/reauth-ux.test.js`.

### Diagnostics

If a user reports the "Session expired" banner, the only credential-free trace is
`_authLog(...)` in `src/main.js` and the auth-classification log lines in
`src/auth-classification.js`. The logger is structured (`[auth] ${phase} { extra }`)
and never emits tokens, session objects, or auth payloads — this is enforced by
`src/auth-reauth-recovery.test.js:259-267`. The relevant reason codes are:

| Log line | What it means |
|---|---|
| `cached_boot_auth_reject_reauth` | Boot hit a server-confirmed refresh-side rejection → REAUTH_REQUIRED |
| `cached_revalidation_auth_rejected` | Runtime revalidation hit the same → REAUTH_REQUIRED |
| `signed_out_internal_session_loss` | Deferred `SIGNED_OUT` for a trusted same-user → REAUTH_REQUIRED (no purge) |
| `reachability_probe` reachable=`true`/`false` | Reachability probe result at boot |
| `cached_state_synced_with_reachability` | State flipped between CACHED and REAUTH_REQUIRED after a probe |
| `cached_revalidation_no_user` | `getSession({ refresh: true })` returned null but no explicit error |
| `cached_revalidation_transport_failed` | `getSession({ refresh: true })` threw a transport error |

---

## Capability gate

`src/capabilities.js` is the centralized gate for every user-triggered action that
ultimately requires a live Supabase session (writes, RPCs, Edge Functions, Storage
uploads, AI, OAuth linking, iNaturalist, taxonomy search, etc.). Every call site MUST
consult this module before dispatching the request. The guarantees:

- **Single source of truth for "is this action allowed right now?"** — no call site can
  drift its own auth check.
- **Single, user-friendly message** — "Internet connection required." for offline,
  "Sign in to reconnect." for reauth and unauthenticated, "Finish setting up your
  account." for incomplete, "Please wait…" for resolving. Same wording across every
  screen.
- **No `navigator.onLine` dependency** — the capability is derived exclusively from the
  auth state machine, so a stale browser `online` flag can never bypass the gate.

`canPerformCloudMutation(overrideState?)` returns `{ allowed: true }` only when the
current state is `AUTHENTICATED_COMPLETE`; otherwise it returns
`{ allowed: false, reason, message }`. Call sites that want a toast on denial use
`requireCloudMutation({ showToast, overrideState, silent })`.

`requiresReauthentication(overrideState?)` is the predicate that `syncHomeSessionNotice`,
the Profile sheet banner, the Finds reauth note, and `beginReauthentication` itself all
consult. It is `true` only when the state is `AUTHENTICATED_REAUTH_REQUIRED` — never for
plain-offline `AUTHENTICATED_CACHED`, never for `AUTHENTICATED_COMPLETE`, never for
`UNAUTHENTICATED`. The `reauth-ux.test.js` suite pins this exactly.

`isOfflineCachedMode(overrideState?)` is the corresponding predicate for the Offline
pill. A REAUTH_REQUIRED user has a reachable backend, so the pill is hidden; the reauth
banner is shown instead.

There is a narrow `bypassCapabilityGate` rule for code paths that genuinely need to read
while the user is in a cached / reauth shell (the user's own avatar in the header, the
user's own protected media in the cache). See the `bypassCapabilityGate` references in
`src/capability-gates.test.js` and the `ProtectedMediaLoader` docblock in
`src/protected-media.js`. Do not introduce new bypasses; the rule is audited by
`src/capability-gates.test.js`.

---

## Auth invariants (structural tests)

The auth state machine, capability gate, recovery seam, deferred pipeline, and offline
revalidation are pinned by structural tests because `main.js` is too DOM/Supabase-heavy
to import in Node. Treat any change to these areas as failing these tests if not also
updated:

- `src/auth-reauth-recovery.test.js` — refresh-side error surfacing, early-boot SIGNED_OUT
  capture, recovery banner UX, "no tokens in logs" guard.
- `src/auth-classification.test.js` — `isExplicitAuthRejection` matches the refresh-side
  tags only; bare `"JWT expired"` does NOT count.
- `src/auth-state.test.js` — terminal-state predicate, `isUserAlreadyResolved` round-5
  dedupe.
- `src/auth-deadlock.regression.test.js` — the deferred event pipeline does not await
  Supabase APIs in the direct callback.
- `src/reauth-ux.test.js` — `beginReauthentication` is REAUTH-only; banner is REAUTH-only;
  i18n keys exist in every supported locale.
- `src/live-reconnect.test.js` — wake-up sources, the round-5 cached-reconnect no-op fix,
  the resolver's state-aware dedupe, `_revalidateCachedRevealInPlace` routing.
- `src/capability-gates.test.js` + `src/capabilities.test.js` — every call site respects
  the gate; `bypassCapabilityGate` is narrow.
- `src/startup-invariants.test.js` — boot ordering, one-time bindings,
  `home-network-refresh-started` fires exactly once per recover.
- `src/connectivity-loss.test.js` — COMPLETE→CACHED downgrade is same-user only, never
  signs out, never touches queued work.
- `src/offline-boot.test.js` — the cached-boot decision matrix.
- `src/field-offline-ux.test.js` — watchdog interval / throttle math, single entry point
  binding, native monitor wiring.

If you touch the auth state machine, the capability gate, the sign-out classification,
or the revalidation pipeline, run this list and update the test that pins the contract
you are changing.

---

## Media pipeline (Cloudflare R2)

All media is stored in Cloudflare R2, not Supabase Storage.

### Upload worker (`upload.sporely.no`)

- **Route:** `PUT /upload/{user_id}/{obs_id}/{filename}`
- **Delete route:** `DELETE /upload/{user_id}/{obs_id}/{filename}`
- **Auth:** Supabase JWT sent as `Authorization: Bearer {token}`
- **JWT verification:** Worker fetches the JWKS from Supabase (`/auth/v1/.well-known/jwks.json`) and verifies the ES256 signature using Web Crypto. The JWKS is cached in-memory for 10 minutes.
- **Key rule:** Upload path must start with the JWT `sub` (user ID) — enforced by the worker.
- **Current client policy:** Free and Pro/full-res accounts are both presented as 20 MP image tiers on normal WebP-capable runtimes. The desktop/web clients only downscale when the source image exceeds the internal safety gate (`>21 MP` or `>5300 px` longest edge), which keeps borderline 20 MP frames intact. Free accounts use standard 0.65 compression and a 1.5 MB full-image byte cap; Pro/full-res accounts use high 0.80 compression and a 5 MB full-image byte cap. On iOS WebKit, when canvas WebP export is unavailable, the browser path intentionally uses a reduced 6 MP JPEG policy before byte-cap attempts. 
- **Storage tally/quota:** After successful R2 writes/deletes, the worker updates `profiles.total_storage_bytes`, compatibility `profiles.storage_used_bytes`, and original-image `profiles.image_count` through the service-role Supabase RPC `apply_profile_storage_delta`. Free-tier storage can be limited per profile via `storage_quota_bytes` or globally via worker `FREE_STORAGE_QUOTA_BYTES`; the entitlement and quota fields on `profiles` are server-owned and protected by the database.
- **Source:** `cloudflare/r2-upload-worker/src/index.js`
- **Config:** `cloudflare/r2-upload-worker/wrangler.toml`

### CORS

Allowed origins are configured in `wrangler.toml` (`ALLOWED_ORIGINS`). The worker also
accepts any private network origin automatically (`10.x.x.x`, `192.168.x.x`, `172.16-31.x.x`)
so LAN dev testing from a phone works without hardcoding IPs.

### Media serving (`media.sporely.no`)

R2 bucket `sporely-media` is exposed publicly via Cloudflare. All media URLs are
**relative keys** stored in the database — never full URLs.

### Deploying the worker

**⚠️ Deploy after every worker change.** The worker is NOT automatically deployed when you
commit.

---

## Database schema (Supabase side)

> For full Supabase schema details, ownership rules, and RLS behavior, see SUPABASE_DB.md.

Full SQL is in `sporely/database/` (the desktop app repo).
Key tables used by the web app:

### `observations`
Maps 1-to-1 with the desktop SQLite `observations` table.
Extra cloud-only columns:
- `user_id uuid` — FK to `auth.users` (set by RLS, never trusted from client)
- `desktop_id int` — local SQLite `id`, used for dedup on sync
- `is_draft bool` — WIP state. Defaults to `true` (Drafts are public by default to promote Open Science streams, but hidden from featured/verified lists).
- `visibility text` — Cloud sharing scope. Values are `public`, `friends`, or `private` (legacy `draft` scope has been retired).
- `location_precision text` — `exact` or `fuzzed`.
- `location_public bool` — legacy compatibility flag; new privacy behavior is driven by `visibility` and `location_precision`.
- `image_key text` — relative R2 key of the cover image
- `thumb_key text` — relative R2 key of the cover thumbnail

Privacy slots are enforced by a Postgres trigger: a free account uses one of its 20 slots when an observation is private or fuzzed (`visibility != 'public' OR location_precision = 'fuzzed'`). The trigger takes a per-user transaction lock so concurrent writes cannot race past the cap. Pro accounts are unlimited.

### `follows`
Stores the web social trail subscriptions used by the `Feed 🧭` tab:
- `user_id uuid`
- `target_type text` — `user`, `observation`, `species`, or `genus`
- `target_id text`

Desktop does not expose social follow controls; this is a web/mobile feature.

### `observation_images`
- `storage_path text` — relative R2 media key (e.g. `{user_id}/{obs_id}/0_ts.jpg`)
- `image_type` — `'field'` | `'microscope'`
- `image_key text` — same as `storage_path` (normalized)
- `thumb_key text` — relative key of the primary thumbnail variant
- `ai_crop_x1`, `ai_crop_y1`, `ai_crop_x2`, `ai_crop_y2` — normalized AI crop rectangle (`0..1`)
- `ai_crop_source_w`, `ai_crop_source_h` — source dimensions when the AI crop was set
- `upload_mode` — `reduced` or `full`
- `source_width`, `source_height` — original dimensions seen by the uploading client
- `stored_width`, `stored_height` — dimensions actually stored in cloud
- `stored_bytes` — size of the stored original blob in bytes

AI crop metadata is stored per image and only affects Artsorakel requests. Gallery rendering still uses the full stored image.
- Full microscope metadata columns present but only populated by desktop sync

### `observation_identifications`
- Cached AI result sets for Artsorakel and iNaturalist.
- Owners can insert, update, and delete their own rows.
- Non-owners can read stored result lists only through `observation_identifications_community_view`, which joins through `observations` and only exposes rows for observations the viewer is already allowed to see.
- The detail screen uses the community view for read-only browsing and the base table for owner writes and reruns.

### Moderation / UGC Compliance
- `user_blocks` — Enforces one-way user blocking for feed filtering (`blocker_id`, `blocked_id`). The profile screen's "Friends | Blocked users" pill lists the caller's blocks (names resolved via the `get_blocked_user_profiles` RPC, since `public_profiles` hides blocked pairs) and unblocks via RLS-guarded DELETE.
- `reports` — Tracks user-reported objectionable content (`observation_id`, `comment_id`, `reason`).
- These tables, alongside `profiles.is_banned`, are required for Google Play Store User Generated Content (UGC) compliance. RLS and Views (e.g. `observations_community_view`) automatically filter out blocked or banned content.

### `profiles`
Auto-created by a Postgres trigger on `auth.users` insert.
Profile UI reads and writes `username`, `display_name`, `bio`, and `avatar_url`. The desktop **Profile & Cloud** page mirrors these same fields so the account identity is shared across web/mobile and desktop.
Server-owned account state also lives here:
- `cloud_plan` — `free` or `pro`; controls account status and full-res entitlement.
- `is_pro` — legacy entitlement mirror used by server access checks.
- `full_res_storage_enabled` — compatibility flag for manually granting full-res access.
- `storage_quota_bytes` — optional per-user storage cap; free plans can be limited here.
- `total_storage_bytes` / `storage_used_bytes` — worker-maintained byte tally. `storage_used_bytes` remains for compatibility.
- `image_count` — worker-maintained count of original uploaded images; thumbnail variants are not counted as images.
- `billing_status`, `billing_provider`, `billing_customer_id`, `billing_payment_id`, `billing_checkout_session_id`, `billing_updated_at` — reserved for website-led billing sync, likely from `sporely.no`/Stripe rather than an in-app checkout.
- `is_admin`, `is_banned` — server-controlled moderation/admin flags.
- A database trigger keeps the server-owned fields above immutable for normal authenticated writes; service-role code can still update them.

Billing UX is website-led: `sporely.no` can advertise Pro, take a one-time payment, and reflect the resulting entitlement state. Android/desktop clients should only read the resulting entitlement from `profiles` and link users out to the website for account management; they should not embed their own checkout flow.

Avatar initials are derived on the client, and avatar rendering prefers the stored URL
with a signed-URL fallback if the direct image fetch fails. That fallback is avatar-only
and does not apply to observation media.
The profile screen also exposes a self-service account deletion action, which calls the
`delete-account` Supabase Edge Function. That function removes canonical observation media
through the Cloudflare upload worker and only uses Supabase Storage for avatars and legacy
leftovers.
It now also shows an Account status block with image resolution, sync history, storage usage, and image count.

Desktop local databases bind to a single Supabase auth user via `linked_cloud_user_id`. If a user wants to move a desktop database to another Sporely Cloud account, they must explicitly reset/migrate the desktop cloud link; simply logging in with another account is blocked before credentials are saved. Deleting the web account does not by itself migrate a desktop database, and the migration flow must avoid both duplicate cloud rows and accidental loss of useful spore data.

### `friendships`
Bidirectional, status-gated (`pending` / `accepted` / `blocked`).
Used by `observations_friend_view` to filter what friends can see.

---

## Row Level Security (RLS)

All tables have RLS enabled. Default policy: **owner only**.

| Table | Who else can read |
|---|---|
| `observations` | Accepted friends (via `friendships` join) |
| `observation_images` | Accepted friends (via observation ownership) |
| `observation_identifications` | Read-only via `observation_identifications_community_view` for visible observations |
| `profiles` | Accepted friends |
| `reference_values` | All authenticated users |
| `observation_shares` | The specific `shared_with_id` user |

`private_comment` is never read by the web app.
Community and follow views expose exact coordinates by default for public observations.
Coordinates are rounded only when `location_precision = 'fuzzed'`; `location_public`
is retained as a legacy compatibility flag and is not the authoritative privacy switch.

Note: Supabase Storage bucket `observation-images` still exists for historical rows
and cleanup only. Do not route new media through it or treat it as a fallback.
Media access control is now handled by the R2 upload worker (JWT path enforcement)
and Cloudflare's public CDN for serving.

---

## Camera Behaviors (Native vs Web)

**Sporely Cam (Native Android / CameraX)**
- Activated when running inside the Capacitor Android app.
- Hooks directly into native CameraX APIs for full 12 MP captures, auto-selecting the 1x lens.
- Supports a dual-pipeline High Dynamic Range (HDR) capability. For Android 14+ devices (e.g. Samsung S25), it uses native Ultra HDR (`JPEG_R` output) capabilities. For older devices, it queries the CameraX `ExtensionsManager` for OEM vendor HDR extensions. When HDR is active, physical lens locks are cleared to allow the device's ISP to compute the HDR gain map across its logical lens array.
- Natively preserves full EXIF orientation and accurate GPS metadata securely without Canvas stripping.

**Web Cam (HTML5 `getUserMedia` / PWA)**
- Activated in mobile browsers (Safari/Chrome) or PWAs.
- Captures by painting a `<video>` stream to an HTML `<canvas>`, inherently limiting resolution to the browser's WebRTC stream (often ~2 MP).
- Mobile browsers aggressively strip EXIF/GPS from web captures for privacy. The app compensates by reading device geolocation via JS `navigator.geolocation` during capture.
- Android web users see warnings advising them to install the native app for better quality and metadata handling.

## Location State

The web app separates current-device location from per-observation coordinates.

- `state.location.fix` holds the latest current-device fix for location-aware UI.
- `state.captureSessionLocation.fix` holds the canonical live-capture coordinates for the current field observation.
- `state.reviewContext.gps` holds the canonical imported-review coordinates.
- `LOCATION_STATE_CHANGED_EVENT` is the single location update event screens subscribe to.
- Session tokens and `sessionStartAt` guard against stale asynchronous callbacks.
- Best-fix selection in a live session prefers the first usable fix, then finite accuracy over missing accuracy, then lower accuracy, then newer timestamp on ties.
- Save-time review requests use `requestFreshLocation()` with a bounded timeout instead of an open-ended watch.
- Persistent opt-out and session-only dismissal are separate: disabled preference suppresses location until the user re-enables it, while session-only dismissal only hides the warning for the current live observation.

## Capture → save flow

```
capture.js: capturePhoto()
  ├─ demo mode (no camera)  → push { blob: null, emoji, gps, ts }
  └─ real camera            → canvas.toBlob wrapped in Promise → push { blobPromise, gps, ts, aiCropRect, aiCropSourceW/H }

review.js: saveObservationBatch()
  1. await Promise.all(capturedPhotos.map(p => p.blobPromise ?? p.blob))
  2. Enqueue parent observation and per-image crop metadata to IndexedDB (sync-queue.js)
  3. Clear capture state, refresh lists, navigate away from review

sync-queue.js: triggerSync() (background)
  1. Read pending observations from IndexedDB
  2. INSERT observations row via Supabase
  3. Load effective cloud upload policy from the signed-in user's profile
  4. For each photo: prepare reduced/full upload blob, PUT to upload.sporely.no (R2 worker), generate variants, INSERT observation_images row with upload metadata
  5. Remove from IndexedDB offline queue
```

## Import flow

```
import_review.js: openPhotoImportPicker()
  ├─ Capacitor Android → NativePhotoPicker plugin returns native EXIF/GPS and JPEG cache files for HEIC/HEIF
  ├─ Capacitor iOS → Capawesome FilePicker path
  └─ Browser / fallback → file input or showOpenFilePicker()

handleSelectedFiles()
  1. Read capture time + GPS from native metadata or exifr
  2. Sort files by capture time
  3. Group files taken within the configured time gap into one observation
  4. Keep browser-decodable originals for preview/upload and create only reduced JPEG AI copies up front
  5. Pre-seed per-image AI crop metadata and save pending import sessions to IndexedDB so review survives app suspension

Single group:
  save immediately → open observation detail editor

Multiple groups:
  show grouped import cards → user edits species/location/sharing/AI crop → save all
```

Android APK note: HEIC/HEIF import must go through the custom `NativePhotoPicker`
bridge, not directly through Capawesome `FilePicker.pickImages()`. The custom
plugin decodes HEIC/HEIF with Android bitmap APIs, writes a temporary JPEG in app
cache, and returns native EXIF/GPS metadata separately. The native bridge uses
`ACTION_OPEN_DOCUMENT`, not Android 13+ `MediaStore.ACTION_PICK_IMAGES`, because
Photo Picker URIs can expose redacted GPS metadata such as `0,0`. Before opening the
custom picker, JS still asks Capawesome FilePicker for `accessMediaLocation`,
because Android can redact photo GPS unless that runtime permission is granted
and the native plugin opens `MediaStore.setRequireOriginal(uri)`. Sending an
HEIC blob directly into the WebView can produce a blank review image because
Android WebView cannot reliably decode HEIC object URLs. When native EXIF is
returned, the JS import flow trusts it and skips the slower `exifr` fallback;
otherwise single HEIC imports can spend several seconds re-reading metadata
after native conversion. Android native JPEG imports also skip eager JS image
decoding during the "Converting" phase; preview uses the native/cache JPEG blob
directly, and AI crop metadata can remain unset until the user explicitly opens
crop/AI tools.

**Android PWA (Web) note:** Android Chrome strips EXIF metadata (including GPS) for privacy when a web app uses a standard `<input type="file" accept="image/*">` quick picker. To preserve GPS on imported JPEGs, the web app routes Android browser users to a specific file picker (`import-browse-input` with explicit file extensions) that bypasses the privacy scrub and preserves the original bytes and metadata.

Confirmed on Samsung S25 / Android APK: `ACTION_OPEN_DOCUMENT` preserves GPS for
the test HEIC (`20260419_092927.heic`: about `63.45209, 10.43705`, altitude
`90 m`). The UX tradeoff is that Android shows the document picker, often opening
on "Recent" photos; users may need to open the side menu and choose "Images" to
browse the full photo library. If this becomes too confusing, the product should
offer two Android import choices: a friendly/fast gallery picker that may lose
EXIF GPS, and a metadata-safe picker for geotagged imports.

Import location metadata is intentionally stored separately from the image blob:
`gpsLat`, `gpsLon`, `gpsAltitude`, and per-photo `photoGps` values travel with
the pending import session and review context. This is important because Canvas
conversion/resizing strips EXIF, and because Android HEIC conversion writes a new
temporary JPEG. The review screen should show both the reverse-geocoded Location
name and a separate Lat/Lon row with the actual coordinates so stale place-name
lookups are easy to spot. Treat `0,0` as missing GPS, never as a real location.
If a JPEG truly has no GPS EXIF tags (example: `20260418_154138.jpg`, which has
Samsung/time metadata but no parsable GPSLatitude/GPSLongitude), the app should
show no coordinates instead of falling back to stale or current-device GPS.

Identification confidence follows the desktop app: the cloud/local observation
field is `uncertain`, not a separate `needs_id` field. The web UI labels this as
"Uncertain ID", prefixes displayed names with `?` when set, and offers a Finds
filter for uncertain observations.

Known Android HEIC tradeoff: the fastest single-HEIC path can show the edit
screen quickly even when metadata is not already available from the native picker
result. The import flow splits visual import from metadata hydration:

1. Convert/decode enough to show the image and open the edit screen immediately.
2. Continue EXIF/GPS extraction in the background.
3. When GPS arrives, update the active review/session location fields and persist
   the pending import session.
4. If the user saves before hydration finishes, the save path waits for pending
   metadata before enqueueing the observation so EXIF GPS is not dropped.

Multi-file HEIC import has previously appeared fast while still preserving GPS,
so do not assume speed and GPS are mutually exclusive. Before changing this path,
add timing logs around native decode, native EXIF, JS `exifr`, and review render
so regressions are easy to locate.

---

## Desktop ↔ Cloud sync (desktop-side, Sporely)

Implemented in `sporely/utils/cloud_sync.py` using the Supabase REST API directly (`requests`).
Media uploads use `sporely/utils/r2_storage.py` — a minimal S3-compatible client using
SigV4 signing directly against the R2 S3 endpoint (bypasses the upload worker, uses
service-level R2 API credentials from `sporely-admin.env`).

**Account binding safety:**
- Desktop stores `linked_cloud_user_id` in its local `app_settings.json` after first successful sync and verifies the active Supabase user before each later push/pull.
- If a local SQLite database is opened while signed into a different Supabase account, desktop sync aborts instead of duplicating observations/media into that account.
- Desktop Settings → Sporely Cloud → **Reset Cloud Link...** clears local cloud IDs and the account binding only after warning that old Supabase/R2 data must be deleted separately through the web Profile delete-account flow.

**Push (desktop → cloud):**
- Queries SQLite for `cloud_id IS NULL OR sync_status = 'dirty'`
- Upserts to Supabase (check-then-patch-or-post pattern)
- Writes `cloud_id` + `sync_status = 'synced'` back to SQLite
- Syncs selected clean desktop observation images plus one clean thumbnail per image. Online-publishing overlays, watermarks, measure plots, thumbnail galleries, and plates stay out of Sporely Cloud media.
- Pushes `observation_images.ai_crop_*` alongside the rest of each synced image row so web and desktop share the same AI crop geometry
- Uses a lightweight local media signature so unchanged images/media can be skipped on later syncs
- Media-signature comparison now ignores low-signal local-only churn such as file mtime drift, gallery layout state, order-only image changes, and older signature payloads that predate the shared AI crop fields
- Upload size is controlled by the desktop **Sync image size** setting (`Reduced (2 MP)` or `Full size`)
- Desktop now pushes the same upload metadata as web (`upload_mode`, source/stored dimensions, stored bytes), so future billing and entitlement logic can reason about already-uploaded media on both platforms

**Pull (cloud → desktop):**
- Fetches `observations WHERE desktop_id IS NULL` (created on mobile)
- Creates local SQLite rows via `ObservationDB.create_observation()`
- Writes `desktop_id` back to Supabase for future dedup
- Watermarked by `cloud_last_pull_at` in `app_settings.json`
- Pulls cloud-managed images into the local desktop observation and refreshes the local media baseline
- Hydrates local `images.ai_crop_*` fields from `public.observation_images` when cloud images already have AI crop metadata
- Uses a bulk-fetch `in.()` query for image metadata to prevent N+1 query performance bottlenecks during sync.
- Before deep comparison, desktop sync now prefilters cloud observations using one local lookup pass plus the cloud row `updated_at` versus local `synced_at`.
- A small grace window is applied to `updated_at > synced_at` checks so server-write timestamp skew from the same sync cycle does not cause every observation to be re-checked on next app launch.
- **EXIF restoration:** When downloading field images that have no EXIF (stripped by the web app's 2 MP Canvas conversion), the desktop re-injects observation GPS and date into the JPEG EXIF so "Set from current image" works in the Prepare Images dialog.
- **Local file preservation:** If the local copy of a field image is larger than the downloaded cloud version, the local full-res original is kept and only DB metadata is updated. This prevents the 2 MP cloud copy from overwriting full-resolution desktop-imported originals.

**Conflict rule:**
- Desktop sync stores a last-seen cloud snapshot for linked observations.
- If the same linked observation changed on both desktop and web since the last synced snapshot, the desktop skips automatic overwrite and reports a conflict.
- Conflict checking strictly compares only images designated for sync (e.g., skipping generated microscope plots or local plates) to prevent falsely flagging them as deleted by the cloud.
- Order-only image changes are treated as low-signal and no longer produce standalone cloud-conflict review items.
- `Keep desktop` still refreshes the cloud snapshot and sync markers, but it skips image re-upload work when no meaningful desktop media changes remain.
`private_comment` never leaves the desktop.

Triggered via Settings → Sporely Cloud Sync… in the desktop app.
