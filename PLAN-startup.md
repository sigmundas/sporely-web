The Capacitor Android app already ships its `dist` assets inside the APK, so the application shell itself is local. A service worker matters much more for the PWA later.  Your agent correctly found that what Sporely currently lacks is a **read-side data cache**; the existing IndexedDB storage is primarily drafts and queued writes. 

## Reconciled implementation plan

1. **First fix cold start without changing offline semantics yet.** Remove `await initializeInaturalistOAuth()` from the critical startup path and lazy-load `@capgo/capacitor-social-login` only when Google/iNaturalist is actually needed. Your agent is right that the static SocialLogin imports enlarge the main bundle substantially.  Also remove the duplicate Home initialization I found: `initHome()` currently calls `refreshHome()`, while the authenticated routing path calls `refreshHome()` again; header profile refresh is duplicated as well. Keep exactly one network Home refresh. Bundle the fonts locally for Android or at least stop the Google Fonts stylesheet from blocking paint. Add simple boot timings (`app-js-start`, `local-session-ready`, `shell-visible`, `cache-rendered`, `online-refresh-complete`) so subsequent changes are measurable.

2. **Create an explicit “last validated local account” record.** Do not rely solely on whether Supabase can produce a currently usable access token. After every successful online account resolution, persist a small record such as `{ userId, email, profileComplete, profileSummary, cloudPlan, lastValidatedAt }`. Do **not** duplicate access/refresh tokens in this record; Supabase remains responsible for its credentials. Reuse the existing local-data-owner concept as the privacy boundary. On sign-out/account deletion, delete this local account record. On account switch, never reveal one user's cached data while resolving another. This gives Sporely an answer to the important offline question: “Who was the last authenticated owner of these local data?”

3. **Introduce an explicit cached-authenticated mode.** I would add something like `AUTHENTICATED_CACHED` rather than pretending the user has just been server-validated. Normal startup should become: local account exists → owner matches → initialize the user's local shell immediately → render cached data → attempt Supabase session validation in the background. `navigator.onLine` can be a hint, but should not determine correctness; a phone can report “online” while Supabase is unreachable. If validation succeeds, transition silently to normal `AUTHENTICATED_COMPLETE`. If it fails due to ordinary network failure, remain in cached mode. If the server explicitly proves the credentials are invalid/revoked, then transition to the login flow. This is safer than simply changing `refresh:true` to `refresh:false`. Your agent's recommendation is directionally correct, but `refresh:true` is Sporely's own cache-bypass flag: it forces another `supabase.auth.getSession()` call, which may require the network when the stored token needs renewal.

4. **Make Home cache-first rather than network-first.** This is the architectural change I would do before trying to cache every individual Supabase query. Refactor Home into roughly `readHomeCache(userId) → renderHome(model)` and `fetchHomeOnline(userId) → writeHomeCache(userId, model) → renderHome(model)`. Cache the **assembled Home model**, not arbitrary PostgREST responses: recent observations, stats, comments/friend-request summaries, profile summary, and timestamps. On every launch, render that snapshot immediately. When online, refresh it asynchronously. When there has never been a successful Home load, render an empty but usable Home with “No cached data / Offline” instead of a login screen. The current design blocks reveal until profile resolution and `refreshHome()` have finished; your agent correctly identified this as the major startup bottleneck. 

5. **Add a real persistent image cache.** This is required for “cache-only” to feel real. Current protected media explicitly uses `cache: 'no-store'` and creates in-memory object URLs, so those images disappear when Android kills the WebView process.  I would add a user-scoped IndexedDB media store keyed by something stable like `{userId, mediaKey, variant}` and store thumbnail blobs. `ProtectedMediaLoader` becomes cache-first: local blob → object URL immediately; if missing and online → authenticated Worker fetch → verify image → persist blob → display it. Start with thumbnails/small-medium images rather than full-resolution originals. Add an LRU/size limit. The existing **Clear local cache** function should clear this store, and sign-out/account changes must remove or make inaccessible that user's media cache.

6. **Make Capture → Review → Queue explicitly offline-safe.** Much of this is already present: the sync queue, import sessions and review drafts are IndexedDB-backed. The audit confirms that Sporely already has these write-side stores.  Audit every operation in Capture/Import/Review and enforce the rule that **creating a local observation never requires Supabase**. Cloud sync should be the only part that needs a valid online session. Cache the last validated cloud plan too: `fetchCloudPlanProfile()` currently falls back to the default policy when its query fails, which could otherwise make an offline Pro user prepare images using the wrong policy.  When connectivity returns and the session is revalidated, drain the existing queue normally.

7. **Extend cache-first reads beyond Home in a second offline milestone.** After Home works, cache **My Finds → observation detail → profile summary → map observations**. This is where the app starts to feel genuinely offline rather than merely able to capture. The cache should always be namespaced by user ID. For Finds, persist the normalized observation objects already returned by the online loader. Observation detail can persist its last successfully assembled detail model. Map can render the cached observations. Social/community feeds can remain cached/read-only initially. I would *not* attempt to ship the entire taxonomy in this pass: taxonomy search currently calls Supabase RPCs, so it is inherently online today.  Allow an observation to remain unidentified offline; optionally cache recently used/search-result taxa later.

8. **Make online-only capabilities visibly degrade rather than fail.** In cached mode, Google login, password operations, friend accept/decline, account/profile writes, AI identification, iNaturalist and uncached taxonomy lookup should either be disabled or show a concise “Internet connection required” message. Do not route the user back to Login merely because one of these operations cannot reach the network. Add a small persistent **Offline** indicator, probably in the header near sync status. The upload state can say something like `3 waiting to sync`.

9. **Preserve the existing account-isolation hardening.** I would not simply revert the August “prepare then reveal” work. Instead, distinguish **cold boot of the known local owner** from **an actual account transition**. Cold boot can safely render that owner's namespaced cache immediately. A→B sign-in must still blank A's DOM, keep the blocker up, establish B's identity, select B's cache namespace, and only then reveal anything. This retains the privacy guarantee that motivated the current startup architecture while removing network latency from ordinary launches.

10. **Lock the work down with offline acceptance tests before calling it finished.** The critical scenarios should be: log in online → populate Home → force-stop → airplane mode → reopen and get cached Home instead of Login; perform the same test with an expired access token; create/import several photographed observations offline → force-stop → reopen and verify they still exist → restore connection → sync them; launch offline with no Home cache and confirm Capture still works; verify a Pro account retains its cached media policy offline; switch A→B and prove no A Home data or images ever appear; sign out and then launch offline and verify Sporely does **not** let that account back in; and test protected cached thumbnails across process death.

### The startup architecture I would aim for

The current path is roughly:

**APK → JS → native OAuth init → Supabase session → profile query → Home queries → images → finally show Home.**

The target should instead be:

**APK → JS → local account + local cache → show Home → validate/refresh online in background.**

And offline:

**APK → JS → local account + local cache → show Home → remain Offline.**

That is a much better fit for a field-observation application.

I would split implementation into **three agent-sized stages** rather than one large rewrite:

**Stage A — cold-start cleanup:** lazy social login, remove duplicate refreshes, local fonts, boot instrumentation, reveal clean shell independently of Home network hydration.

**Stage B — offline foundation:** cached authenticated account, user-scoped IndexedDB read cache, cached Home/profile/cloud-plan, persistent thumbnail cache, reconnect/revalidation semantics.

**Stage C — useful field-offline app:** cached My Finds/detail/map, completely offline-safe Capture/Import/Review, reconnect queue draining, offline UI states and the cross-account/privacy test matrix.

I would **not add a service worker yet**. Once Android behaves correctly, the same read-cache layer can be reused for the PWA, and *then* a service worker can solve the separate problem of getting the web application shell itself to launch without a connection.

The end goal is therefore not too optimistic. In fact, Sporely is already halfway there because its hardest offline-write problem—persisting photos/drafts and queueing uploads—exists. The missing half is essentially **offline identity plus read-side caching**.

---

## Stage A — implementation progress (branch `startup-perf-and-offline`)

Status: **implementation complete, uncommitted** on branch `startup-perf-and-offline`. Base commit `37ab74e`. Not committed; awaiting review.

### What shipped

Files touched:

- New: `src/boot-timings.js`, `src/boot-timings.test.js`.
- New: `public/fonts/` (Outfit, DM Mono, Instrument Serif italic — latin + latin-ext .woff2 files, OFL licensed) + `LICENSE-fonts.txt`.
- Modified: `index.html`, `src/style.css`, `src/main.js`, `src/screens/home.js`, `src/google-auth.js`, `src/native-oauth.js`, `src/inaturalist.js`.

Item-by-item:

- **A. Boot instrumentation.** `src/boot-timings.js` exposes `mark(name)` / `measure(from, to)` / `snapshot()` anchored to module load. Marks placed at `js-init-start`, `authenticated-user-resolved`, `app-shell-initialized`, `app-shell-revealed`, `home-refresh-start`, `home-refresh-end`. Zero I/O, no user-identifying data, no `await`s on the boot path. Six unit tests, all pass.
- **B. Lazy SocialLogin.** `@capgo/capacitor-social-login` is no longer statically imported from the eager startup graph. `initializeInaturalistOAuth()` no longer runs during `init()`. The plugin is loaded on demand from a single lazy loader shared by `google-auth.js`, `native-oauth.js` and `inaturalist.js`; combined provider registration and initialize-once semantics are preserved via a shared init promise. Build verified: SocialLogin implementation lives in `dist/assets/web-m7WQyxfB.js` (44 kB, 11.38 kB gzipped) + `dist/assets/index-B1XnNOld.js` (6.25 kB, 2.16 kB gzipped) — the main chunk contains only the lazy loader wrapper (`dynamic import().catch(...)`).
- **C. One Home hydration.** `initHome()` now only binds UI. Startup performs exactly one `refreshHome()`. The redundant `runBootStep('header-profile-buttons', …)` in `bootApp()` was removed — the authenticated-resolve path already awaits it. Regression coverage lives in the `home.js` inline behavior (no `refreshHome()` call inside `initHome`).
- **D. Reveal-before-hydrate.** `_resolveAndRouteForUser()` now: (1) `_ensureAppReadyForUser` behind the blocker, (2) `refreshHeaderProfileButtons` awaited so chrome reflects B before reveal, (3) `hideAuthOverlay()` + `hideAccountTransitionBlocker()`, (4) `void refreshHomeSafe()` fires-and-forgets, filling sections into DOM skeletons already present in `index.html`. Skeleton CSS is in `src/style.css`. `refreshHomeSafe` catches per-section errors and renders inline offline/error states — a Home network failure after reveal never bounces the user back to the auth overlay.
- **E. Boot-path awaits trimmed.** `initializeInaturalistOAuth()` gone from `init()`. iNat OAuth-return handling is gated behind `_urlLooksLikeInaturalistReturn(location.href)` (cheap synchronous URL check). Supabase OAuth callback handling is gated behind `_urlLooksLikeSupabaseOAuthCallback(...)`. Native app-link listener registration remains where it needs to be for correctness.
- **F. Self-hosted fonts.** Google Fonts stylesheet + `preconnect` removed from `index.html`. `@font-face` rules for Outfit (400 & full weight range), DM Mono (400, 500), Instrument Serif italic in `src/style.css` — all with `font-display: swap`. `public/fonts/LICENSE-fonts.txt` credits OFL. First paint no longer depends on `fonts.googleapis.com`. Turnstile remains load-on-auth (unchanged).

### Startup path — before → after

Before (from initial audit):

`APK → JS → initI18n → initializeInaturalistOAuth (await) → 4 more awaits → getSharedAuthSession({refresh:true}) → fetchProfile → bootApp → refreshHome (await) → hideAuthOverlay`

After (Stage A):

`APK → JS → initI18n (sync) → cheap URL-shape checks → getSharedAuthSession → fetchProfile → _ensureAppReadyForUser (blank A's DOM behind blocker) → refreshHeaderProfileButtons (await, so B's chrome is correct) → navigate('home') → hideAuthOverlay + hideAccountTransitionBlocker → void refreshHomeSafe() (fills skeletons, per-section errors render inline)`

### Account-transition privacy (unchanged guarantees)

- `_ensureAppReadyForUser` still synchronously clears previous-user DOM behind the account-transition blocker.
- `isCurrentAccountTransition(...)` is re-verified at every await boundary (`_ensureAppReadyForUser`, `refreshHeaderProfileButtons`) — a superseded transition returns `STALE` and never calls `hideAuthOverlay()`.
- Reveal now happens **after** header chrome reflects B, **before** Home data lands. Home data replaces the skeletons; skeletons themselves are account-agnostic.
- `refreshHomeSafe` never throws to the caller, so a per-section network failure cannot force the auth overlay back up while A's DOM is still being cleared elsewhere.

### Chunk-size evidence

Post-build (`npm run build`):

| Chunk | bytes | gzip |
| --- | --- | --- |
| `dist/assets/main-*.js` | 973 448 | 263.74 kB |
| `dist/assets/web-m7WQyxfB.js` (SocialLoginWeb) | 44 059 | 11.38 kB |
| `dist/assets/index-B1XnNOld.js` (plugin registration) | 6 248 | 2.16 kB |
| `dist/assets/main-*.css` | 124 580 | 21.51 kB |

Baseline main chunk size from the pre-Stage-A audit: 972 kB. The eager main chunk did **not** shrink materially because the web SocialLogin implementation was already a small stub; the win is that it no longer **runs** on boot (no provider init, no plugin instantiation) and its 44 kB lazy chunk is only fetched when the user actually taps Google / iNaturalist. Baseline vs current worktree builds were not compared side-by-side because a worktree build was not required to reach this conclusion.

### Runtime timings

**No trustworthy pre-change runtime timings exist.** The new `boot-timings` module is the baseline for Stage B comparisons.

### Test / build results

- `npm test`: 720 passing, 2 failing. Both failures are pre-existing on `main` (verified): `src/screens/map.test.js` (leaflet CSS import in the Node test env), `supabase/functions/admin-ops/adminActions.test.ts` (Deno). Neither is caused by Stage A.
- `npm run build`: succeeds; sizes above.

### Manual reasoning (not exercised on device)

1. Email/password existing-user cold start: session resolves → header refreshes → reveal → skeletons → Home fills.
2. Native Google sign-in: click → lazy loader dynamically imports SocialLogin → provider init runs once (shared promise) → sign-in.
3. iNaturalist connect: same lazy loader; combined provider registration preserved.
4. Supabase OAuth callback launches with `?code=…` still routed via `maybeHandleSupabaseOAuthCallback`.
5. Home refresh failure after reveal: per-section `_renderSectionError` inline; auth overlay stays down.
6. A → B transition: blocker + DOM blank happen before any B reveal; STALE checks at every await; skeletons are user-agnostic.

### Remaining Stage A work

None blocking. Optional follow-ups for a later polish pass, not required for Stage B:

- Verify skeleton-clear timing on `initHome` bind path (the container `innerHTML` replacement in `loadRecentFinds` / `loadRecentComments` already replaces skeletons; friend-requests currently has skeleton attribute but no rows — cosmetic).
- Preload `outfit-latin.woff2` via `<link rel="preload">` if measurements later show FOUT on Android WebView cold start.

### Handoff to Stage B

Seams introduced that Stage B can build on:

- `boot-timings.js` gives Stage B a `js-init-start → app-shell-revealed → home-refresh-end` baseline for measurement.
- Home now has an explicit `refreshHomeSafe()` seam that Stage B's cache-first `renderHome(model)` can slot into: cache read renders synchronously into the same DOM regions, then `refreshHomeSafe()` (or its replacement) writes the fresh model.
- `_resolveAndRouteForUser` already has an explicit reveal boundary; Stage B's `AUTHENTICATED_CACHED` mode can reveal at the same point without further restructuring.
- Lazy SocialLogin loader is centralized — Stage B does not need to touch native OAuth to add cached-authenticated mode.

Stage A explicitly did NOT touch:

- `getSharedAuthSession({refresh:true})` — kept as-is; do not change in Stage B without the "last validated local account" record that gives us a correct offline auth story.
- Logout / revocation semantics.
- Any read-side cache. No service worker.
- Account-switch reveal path — the same reveal boundary is used for cold boot and account switch today. If Stage B introduces a cached-first cold-boot path, keep account-switch on the current (post-header, post-STALE-check) reveal; make the distinction explicit (e.g. `revealMode: 'cold-boot' | 'account-switch'`).

Stage B refinements suggested by Stage A findings:

- Home skeletons + `refreshHomeSafe` mean Stage B can render a cached model into the skeleton slots without any DOM restructuring.
- Because `refreshHeaderProfileButtons` is now the load-bearing await before reveal, Stage B's cached-authenticated mode should render header chrome from the cached profile summary synchronously — that removes the last remaining network dependency before reveal.
- The redundant duplicate-hydration bug fixed here would silently reappear under a naive cache-then-network refactor; keep the "exactly one intentional startup Home hydration" invariant explicit in Stage B tests.

---

## Stage B — implementation progress

Status: **B1 implementation complete, uncommitted** on branch `startup-perf-and-offline`. Base commit `230c990` (Stage A). Not committed; awaiting review.

### B1 scope shipped

Files created:

- `src/last-validated-account.js` — versioned localStorage record for the last successfully-online-validated account on this device.
- `src/last-validated-account.test.js` — 15 unit tests.
- `src/cloud-plan.test.js` — 8 unit tests around the new NETWORK / FALLBACK / CACHED source tagging.
- `src/cached-header.test.js` — 6 unit tests around synchronous cached-header rendering.
- `src/offline-boot.test.js` — 11 orchestration tests mirroring `_tryCachedAuthenticatedBoot`.
- `src/startup-invariants.test.js` — 11 structural tests (Stage A + Stage B1 invariants).

Files modified:

- `src/auth-state.js` — added `AUTHENTICATED_CACHED` state.
- `src/cloud-plan.js` — `_source` tagging (`NETWORK` / `FALLBACK` / `CACHED`), `reviveCachedCloudPlan`, `getCloudPlanSource`.
- `src/screens/profile.js` — added `renderCachedHeaderProfileButtons()` (synchronous, no Supabase).
- `src/main.js` — cached-boot path (`_tryCachedAuthenticatedBoot`), snapshot writer, background revalidation, `_isExplicitAuthRejection` / `_isTransportSessionError` classifiers, offline indicator toggle, `clearLastValidatedAccount()` in SIGNED_OUT handler.
- `src/auth-state.test.js` — new AUTHENTICATED_CACHED distinctness test.
- `src/i18n.js` — `common.offline` key (en/nb_NO/sv_SE/de_DE), setText wiring for the new indicator label.
- `index.html` — persistent `#app-offline-indicator` element.
- `src/style.css` — offline indicator pill styling.

### Chosen schema (last-validated-account, v1)

Persisted at localStorage key `sporely-last-validated-account-v1`:

```json
{
  "version": 1,
  "userId": "<uuid>",
  "email": "<string>",
  "profileComplete": true,
  "profileSummary": { "username": "<string|null>", "display_name": "<string|null>", "avatar_url": "<string|null>" },
  "cloudPlan": <cloud plan blob | null>,
  "lastValidatedAt": <ms epoch>
}
```

Explicit exclusions: NO access_token, NO refresh_token, NO session object. Supabase remains authoritative for its credentials. The write path enumerates accepted fields so a careless caller cannot smuggle tokens into the record (guard test included).

Storage mechanism: `localStorage` — same as `local-data-owner.js`. Fail-closed on malformed JSON, schema-version mismatch, missing userId, or any storage exception (private-mode Safari). The write API returns `false` on failure so the caller can decide whether to log.

### New auth states

Two distinct reveal-only states were introduced. Both mean "the shell is revealed with a cached identity but the server has NOT confirmed the current session during this launch"; downstream code that writes to Supabase must gate on `AUTHENTICATED_COMPLETE` only. `isAuthorizedForAuthenticatedNetworkOps(state)` is the canonical predicate — it returns `true` for `AUTHENTICATED_COMPLETE` and `false` for every other state.

- `AUTH_STATE.AUTHENTICATED_CACHED` — the reachability probe reported UNREACHABLE. Home network activity is presumed to fail; the Offline indicator is shown.
- `AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED` (refined from initial B1 draft) — the reachability probe reported REACHABLE but the local Supabase session is missing/expired-and-unrefreshable. The shell reveals cached identity so drafts remain available, but authenticated network writes MUST NOT be attempted (would return a real 401). Reconnect triggers still fire; when a genuine session materializes, the state transitions to `AUTHENTICATED_COMPLETE`.

### Auth-error classifier (refined)

Extracted into `src/auth-classification.js` for testability. `isExplicitAuthRejection(err)` matches ONLY server-confirmed session rejections:

- `invalid_grant`, `invalid_refresh_token`, `refresh_token_not_found`, `refresh_token_already_used`, `refresh token expired`, `user_not_found`, `session_not_found`.

Tags REMOVED from the initial B1 draft:

- `jwt expired` — a bare expired access JWT is common on every offline launch (access tokens are short-lived by design). Denying cached boot on this signal would deny it on every offline launch.
- `jwt malformed` — same reasoning; the access token expired well before the WebView came up, so the JWT does not decode cleanly. Not a server rejection.
- `no user found with that email` — this is an auth-form-error string, not a session-rejection signal.
- Bare `401` / `403` status without a matching payload — these are ambiguous (could be a transient network path issue). Only the payload tags above are conclusive.

`isTransportSessionError(err)` matches network keywords, HTTP 5xx, and an EXPLICIT `err.status === 0` field (an unrelated Error without a status is no longer force-classified as transport).

### Reachability probe

`probeBackendReachability({ timeoutMs=3000, fetchImpl=fetch, origin=SUPABASE_ORIGIN })` — a tiny anonymous `GET /auth/v1/health` with `cache: 'no-store'` and no auth headers. Classifies as:

- REACHABLE — any well-formed HTTP response with status < 500 (200, 301, 401, 403, 404 all count — the hop reached Supabase).
- UNREACHABLE — thrown fetch, abort/timeout, status 0, HTTP 5xx.

Never used as auth authority — the write gate remains `AUTHENTICATED_COMPLETE`. The probe result only controls cached-boot state selection and gates the reveal-time UI. `navigator.onLine` remains banned as an auth signal.

### Deferred re-probe (replaces the unconditional 3s timer)

The initial B1 draft had an unconditional `setTimeout(trigger, 3000)` that fired on every cached boot regardless of state. That was removed because a REAUTH_REQUIRED state (server reachable, session missing) is not helped by an automatic re-probe — the user needs to sign in, and the reconnect triggers already re-run the session refresh. The refined design schedules a **single** deferred re-probe (5 s) only when the initial probe classified the backend as UNREACHABLE, so a genuinely-offline boot self-heals if the network flakes back within a few seconds.

Reconnect triggers (`window.online` event, `visibilitychange → visible`) are unchanged.

### Ownership invariant

Cached-authenticated boot requires `readLastValidatedAccount().userId === getLocalDataOwner()`. Any mismatch (including the "no owner marker at all" case on a fresh install) fails closed — the snapshot is cleared and control falls through to the unauthenticated flow. This preserves the Stage A privacy guarantee against cross-account leaks.

### Cached header

`renderCachedHeaderProfileButtons(profileSummary, { email })`:

- Purely synchronous. Zero Supabase calls.
- Paints initials + optional avatar across all four header targets (`home-profile-*`, `finds-profile-*`, `map-profile-*`, `people-profile-*`).
- Accepts inline (`data:`) and public http(s) avatar URLs. Signed URLs (`?token=` / `/object/sign/`) are refused — the loader would need a network fetch that we already know is failing — and the header degrades to initials in that case.
- Runs BEFORE the shell is revealed on the cached path, matching Stage A's "chrome-first" contract.

### Cached cloud-plan behavior

- `fetchCloudPlanProfile()` now tags its result. A successful policy fetch is `NETWORK`; the previously-silent default fallback is now `FALLBACK`; a revived persisted plan is `CACHED`.
- Snapshot writer only overwrites `record.cloudPlan` when the fresh result is `NETWORK`-sourced. A `FALLBACK` result never overwrites a previously good plan (this is exactly the "no silent Pro downgrade offline" rail).
- On cached boot, `state.cloudPlan` is revived from `snapshot.cloudPlan`. Uploads that consult `state.cloudPlan` therefore see the last-known Pro/Free status even when the network is unreachable.
- `updateLastValidatedCloudPlan(userId, cloudPlan)` is a userId-gated single-field updater; a mismatched userId is a no-op (defensive against in-flight account transitions).

### Boot orchestration (cached path)

1. `readLastValidatedAccount()` — `last-validated-account-loaded` mark.
2. Owner-match guard. Missing owner OR mismatch => clear snapshot + fall through to unauth.
3. If eager session threw an explicit-rejection classifier match => skip cached boot (goes to normal SIGNED_OUT recovery).
4. `probeBackendReachability()` — `reachability-probe-started` / `reachability-probe-completed` marks.
5. Target state selected: REACHABLE → `AUTHENTICATED_REAUTH_REQUIRED`; UNREACHABLE → `AUTHENTICATED_CACHED`.
6. `cached-auth-selected` mark, begin account-transition boundary, `clearUserScopedUi()`, show blocker, minimal `state.user = { id, email }`, revive `state.cloudPlan`.
7. `_ensureAppReadyForUser` runs behind the blocker (init screens + restore drafts).
8. `renderCachedHeaderProfileButtons()` — `cached-header-rendered` mark.
9. `setAuthState(target)`, `navigate('home')`, hide auth overlay + blocker, `_setOfflineIndicator(true)`, `app-shell-revealed` mark.
10. `_scheduleCachedRevalidation({ initialReachability })` — `online` + `visibilitychange:visible` triggers, plus a single deferred re-probe at 5 s ONLY when the initial probe was UNREACHABLE.

Home hydration is intentionally NOT called on the cached path — this matches the plan's "zero online Home refresh until revalidation" invariant. Home renders the existing Stage A skeletons; when a section-level fetch fails on future navigation, `refreshHomeSafe` already renders inline offline placeholders instead of modal errors.

### Reconnect behavior

`_attemptCachedRevalidation(source)` re-probes reachability, then re-runs the session refresh:

- Same-user, session found => routes through `resolveAuthenticatedSessionOnce()` (the existing pipeline) which refreshes header + cloud plan, writes a fresh snapshot, and transitions to `AUTHENTICATED_COMPLETE`. `revalidation-completed` mark. Works whether the previous state was `AUTHENTICATED_CACHED` or `AUTHENTICATED_REAUTH_REQUIRED`.
- Transport failure or no session => `_syncCachedStateWithReachability` reflects the fresh probe result: cached ↔ reauth-required. No transition to COMPLETE.
- Explicit auth rejection => invoke `supabase.auth.signOut()` which fires SIGNED_OUT and the normal sign-out cleanup runs — including `clearLastValidatedAccount()`.
- A different user's session materializing on this device is handled by the same `resolveAuthenticatedSessionOnce()` call (kicks the normal account-transition path).

### Logout / delete behavior

- `SIGNED_OUT` handler in `main.js` clears the snapshot **only after** the draft purge succeeds — same ordering as `clearLocalDataOwner()`. A failed purge preserves both markers so the next boot retries; boot code will fail closed on the mismatched-owner check.
- A transport failure never triggers this path (an explicit `SIGNED_OUT` event is required).
- Account deletion routes through `supabase.auth.signOut()` (existing behavior) which then hits the SIGNED_OUT handler. No new call site required.

### A → B account switch (privacy)

- Same reveal path as Stage A. Cached boot only reveals when `snapshot.userId === getLocalDataOwner()`; if the owner marker was updated by an interrupted transition, cached boot fails closed.
- The Stage A account-transition boundary (`beginAccountTransition` + `clearUserScopedUi` + blocker + STALE check) is preserved by cached boot. Structural test (`startup-invariants.test.js`) enforces this.
- Reveal ordering: header chrome from the CURRENT owner's cached summary first, then reveal. A → B online sign-in during a cached-mode session goes through `resolveAuthenticatedSessionOnce()` which re-establishes B's identity through the normal `_resolveAndRouteForUser` pipeline.

### Boot timings (new marks)

Emitted on the cached path via `boot-timings.mark()`:

- `last-validated-account-loaded` — after the localStorage read.
- `reachability-probe-started` / `reachability-probe-completed` — around the `/auth/v1/health` GET.
- `cached-auth-selected` — after owner-match + error-classification passed. Includes the `targetState` and `reachability`.
- `cached-header-rendered` — after synchronous header paint.
- `revalidation-started` — background revalidation kicked (with source: `online-event` / `visibility-visible` / `deferred-reprobe`).
- `revalidation-completed` — successful revalidation transitioned state to COMPLETE.

Also emitted on the COMPLETE branch: `last-validated-account-written` (with cloudPlan source + headerRefreshOk).

### Offline UI

- Persistent `#app-offline-indicator` (top-centre, small amber pill, `role="status"`, `aria-live="polite"`). Shown by `_setOfflineIndicator(true)` when cached mode is entered; hidden on successful revalidation and on SIGNED_OUT.
- Home sections remain in Stage A skeleton state on cached boot (no online refresh is called). Per-section errors on later navigations continue to render inline via `refreshHomeSafe`. No modal error surfaces on the cached path.

### Boot classifier

`_isExplicitAuthRejection(err)` matches: `invalid_grant`, `invalid_refresh_token`, `refresh_token_not_found`, `refresh_token_already_used`, `user_not_found`, `jwt expired`, `jwt malformed`, `session_not_found`, HTTP 401/403.

`_isTransportSessionError(err)` matches network keywords and HTTP 5xx / status 0. This is a hint-only helper — the cached boot decision only refuses on _explicit_ rejection; every other failure (or missing session with no thrown error) falls through to cached mode if a valid owner-matched snapshot exists.

Explicitly NOT used as auth authority: `navigator.onLine`. Structural test enforces this (`startup-invariants.test.js: no navigator.onLine is used as auth authority`).

### Tests + results

`npm test`: 810 tests, **772 pass**, **2 fail**, 36 skipped, 0 cancelled, 0 todo.

The two failures are the pre-existing Stage A failures — confirmed unrelated to Stage B1:

- `src/screens/map.test.js` — leaflet CSS import in Node test env.
- `supabase/functions/admin-ops/adminActions.test.ts` — Deno runtime.

New / extended tests all pass:

- `src/last-validated-account.test.js` — **15 tests** (roundtrip, malformed JSON, schema mismatch, missing userId, storage exceptions, clear, cloud-plan userId-gated update, token-leak guard, sanitization).
- `src/cloud-plan.test.js` — **8 tests** (NETWORK / FALLBACK / CACHED tagging, missing-column edge, thrown error, empty userId, revive-cached, JSON.stringify guard).
- `src/cached-header.test.js` — **6 tests** (initials fallback, public URL avatar, signed URL rejection, all four screens covered, email-initial fallback, synchronous return).
- `src/offline-boot.test.js` — **11 tests** (validated snapshot + owner match, no snapshot, owner mismatch, missing owner, corrupt JSON, explicit auth-reject, sign-out then relaunch, reconnect variants, account-delete).
- `src/startup-invariants.test.js` — **11 tests** (Stage A hydration invariant, cached path has zero online Home refresh, snapshot integration, SIGNED_OUT snapshot clear, snapshot write ordering, FALLBACK guard, classifier presence, revalidation listeners, boot marks, navigator.onLine guard, account-transition boundary preserved).
- `src/auth-state.test.js` — **+1 test** (`AUTHENTICATED_CACHED` distinctness).

Total new/extended assertions across Stage B1: **52** new tests.

`npm run build`: succeeds. Main chunk `main-DxlsBxWA.js` = 980.90 kB (265.97 kB gzipped) — up ~7.4 kB from Stage A's 973 kB baseline. Delta accounted for by `last-validated-account.js` + Stage B1 additions in `main.js` and `cloud-plan.js`.

`git diff --check`: clean.

### Manual Android verification

**Not yet executed on device.** Requires device verification before B1 can be marked "complete":

- Scenario 1: online sign-in on Android; observe snapshot creation via `window.__sporelyBoot` marks + localStorage inspection.
- Scenario 2: force-close app + enable airplane mode + relaunch => cached shell revealed, Offline indicator shown, correct username/avatar/plan.
- Scenario 3: enable airplane mode DURING first launch (before snapshot write) + force-close + relaunch offline => must fall through to unauth (no snapshot yet).
- Scenario 4: cached boot with an expired access token but valid refresh token => refresh succeeds when network returns; auto-transition to COMPLETE + Offline indicator hidden.
- Scenario 5: cached boot with a revoked session (server-side revocation) => reconnect fires SIGNED_OUT + snapshot cleared + login screen.
- Scenario 6: A → B on Android with cached boot (log in as A, force-close offline, sign in as B when online again). B's cached record replaces A's after the online COMPLETE flow.
- Scenario 7: Pro user offline: verify `state.cloudPlan.hasProAccess === true` from snapshot in DevTools.

All scenarios above are architecturally exercised by unit / orchestration tests, but the Capacitor Android WebView's actual behavior for `supabase.auth.getSession()` in airplane mode is not covered by Node tests.

### Boot timing observations

Not measured on device this stage. The new synchronous paint path (cached-header before reveal, no network on the critical path) is strictly a subset of Stage A's online cold path, so the cached cold start is expected to be at least as fast as Stage A's online cold start — and materially faster when the network is actually reachable but slow, because the shell reveals without waiting on any Supabase RPC.

### Deliberately deferred to B2 / B3

- Home read cache (assembled Home model). Cached boot currently shows Stage A skeletons on Home.
- Media/thumbnail IndexedDB cache. Protected media still refuses to render offline; header avatar degrades to initials when the cached URL is signed.
- My Finds / observation-detail / map cached reads.
- Service worker for the PWA shell.

### B2 / B3 refinements suggested by B1 findings

- `renderCachedHeaderProfileButtons`'s "public URL only" avatar policy is deliberate for B1; B2 should introduce a user-scoped IndexedDB media blob store so cached avatars survive Android process death and cached URLs stop being an implicit surface area problem.
- The snapshot writer runs post-reveal in `void (async () => …)()`. B2 may want to persist the assembled Home model in the same background task so the next cold start renders Home from cache before revalidation. Keep the "only write on NETWORK-sourced data" rule.
- Cached-mode gating for online-only actions (Google connect, friend-accept, taxonomy search, AI ID, iNat connect) is NOT implemented in B1. B2 should subscribe to `subscribeAuthState` and disable/annotate these actions when `state === AUTHENTICATED_CACHED`.
- `_attemptCachedRevalidation` uses a fixed 3-second post-reveal retry. B2 should replace this with a proper reachability probe (a cheap Supabase HEAD or a Postgres health RPC) rather than an unconditional timer.
- The `_isExplicitAuthRejection` classifier is conservative. If Supabase-JS surfaces newer error tags we may need to add them; the current tag list is documented in `main.js` and covered by structural tests.

### Requires device verification before B1 → merged

- All seven Android scenarios above.
- Verify the persistent Offline indicator is placed correctly across screen headers on real Android (safe-area handling on notch/dynamic-island parity).

