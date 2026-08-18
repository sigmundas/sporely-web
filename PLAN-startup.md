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

Status: **B1 complete, manually verified on Android, committed** as `8956744` on branch `startup-perf-and-offline` (Stage A committed as `230c990`).

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

- `SIGNED_OUT` handler in `main.js` clears the snapshot **only after** the draft purge succeeds — same ordering as `clearLocalDataOwner()`. A failed purge preserves both markers so the next boot retries; boot code will fail closed on the mismatched-owner check. *(Superseded in B2a: the snapshot is now cleared unconditionally BEFORE the purge — see the B2a logout section. Only the owner marker remains purge-gated.)*
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


---

## Stage B2a — Home read-model cache

Status: **implementation complete, uncommitted** on branch `startup-perf-and-offline`. Base commit `8956744` (B1). Awaiting review + Android manual verification.

Staged roadmap (unchanged):

- B1 = offline identity foundation — **COMPLETE** (committed `8956744`, Android-verified).
- B2a = Home/read-model cache — **THIS STAGE** (code complete, device verification outstanding).
- B2b = cached-mode gating for online-only actions — not started.
- B3 = persistent protected-media/avatar/thumbnail cache — not started.
- Later = broader Finds/detail/map caching.

### Pre-work audit of Home hydration (as found after A+B1)

`refreshHome()` / `refreshHomeSafe()` ran five parallel loaders, each coupling fetch + DOM mutation:

1. `loadRecentFinds` — `observations` (mine, 3) + `observations_friend_view` (friends, 3) → merge/sort → top 4; then `_loadProfileMap` (`public_profiles` + **signed** avatar URLs via `createSignedUrls`, 3600 s) and `fetchFirstImages(..., {variant:'medium'})` → `{ key, primaryUrl, fallbackUrl, protectedUrl }` per observation.
2. `loadFriendRequests` — pending + accepted `friendships` rows, `public_profiles` for requesters; "accepted unseen" filter mutates a localStorage seen-set at fetch time.
3. `loadRecentComments` — `comments_community_view` (5) + optional mention-preview query (3), `fetchCommentAuthorMap`, observation titles from `observations` + `observations_community_view`, `fetchFirstImages(..., 'small')`.
4. `loadStats` — three queries (obs count, genus/species rows, spore count).
5. `checkSyncStatus` — a 1-row Supabase query used purely as a connectivity probe for the header "Sync" tag.

Header/profile chrome is separate (B1 `renderCachedHeaderProfileButtons` + online `refreshHeaderProfileButtons`). Image URLs enter the model at `fetchFirstImages` (public URLs derived deterministically from the stable media `key`; `protectedUrl` is a session-bound authorized worker URL) and at `_loadProfileMap` (signed avatar URLs — never durable).

**Audit finding fixed in this stage:** `clearUserScopedUi()` cleared ids `home-recent-finds` / `home-recent-comments` / `home-recent-friend-requests`, which do not exist in `index.html`. The real containers (`recent-finds-list`, `recent-comments-list`, `home-friend-requests-list`, `hstat-obs|sp|spores`) were never blanked on A→B. Harmless while Home was skeletons-until-network, load-bearing once cached content renders pre-network — the lists in `account-transition.js` now use the real ids, and a structural test cross-checks every id against `index.html`.

### Files

New:

- `src/home-cache.js` — user-scoped IndexedDB Home model cache.
- `src/home-cache.test.js` — 13 store tests (in-memory backend).
- `src/home-cache-orchestration.test.js` — 11 boot/reconnect/isolation orchestration tests using the real cache module.

Modified:

- `src/screens/home.js` — fetch/render split, cache-first orchestration, offline gating, persist policy, offline empty states.
- `src/main.js` — cache-first COMPLETE boot, cached-boot Home render, in-place same-user revalidation, cache lifecycle (sign-out / account switch / clear-cache).
- `src/account-transition.js` — real Home container ids in the cleared lists.
- `src/i18n.js` — `home.offlineNoCache` (en / nb_NO / sv_SE / de_DE).
- `src/startup-invariants.test.js` — 13 new B2a structural invariants; the snapshot-after-reveal test rescoped to `_resolveAndRouteForUser` (the in-place helper legitimately persists without a reveal).

### Cache store (`home-cache.js`)

- IndexedDB `sporely-home-cache` v1, object store `home_models`, **keyPath `userId`** — one record per user; reads are keyed strictly by the requested id and additionally re-verify `record.userId`. No "last cache" fallback exists.
- Record: `{ version: 1, userId, updatedAt, model }`.
- Fail-closed reads: missing userId, version mismatch (no migration — caller refreshes online and overwrites), cross-user record, malformed model, storage exception ⇒ `null`; never throws. Reads are local-only and resolve `null` after a 4 s timeout if IndexedDB hangs, so boot can never block on cache I/O.
- Writes sanitize to plain JSON, allowlist top-level sections (`recentFinds`, `friendRequests`, `recentComments`, `stats`), and deep-scrub: `protectedUrl` / token-named keys dropped, signed-URL strings (`?token=` / `/object/sign/`) nulled. Tokens can never persist.
- Staleness: **stale-while-revalidate**. No TTL; `updatedAt` + derived `ageMs` returned as metadata (emitted into the `home-cache-rendered` boot mark; no age UI added — the existing Offline pill is the offline surface; revisit in B2b if wanted).
- `clearHomeCache(userId)` / `clearAllHomeCaches()`; injectable backend for Node tests.

### Normalized Home model (schema v1)

```
{
  recentFinds:    { items: [{ ...obs row, _owner, image: {key, primaryUrl, fallbackUrl} | null }],
                    profiles: { [userId]: {id, username, display_name, avatar_url} } },
  friendRequests: { pending: [rows], accepted: [unseen rows], profiles: {...} },
  recentComments: { items: [comment rows], authors: {...}, observations: { [obsId]: {id, genus, species, common_name} },
                    images: { [obsId]: {key, primaryUrl, fallbackUrl} } },
  stats:          { observations, species, sporeMeasurements }
}
```

Per-field decisions:

- **Cached (durable read data):** observation rows, display/taxon text, dates, locations, friend-request rows, comment bodies/authors, stats counts, stable media `key`s, public/immutable media URLs (deterministically derived from the key), public or `data:` avatar URLs.
- **Recomputed locally (never cached):** section loading/error flags, "seen accepted friend" filtering state (localStorage, applied at fetch time), camera-action label, sync-queue/pending state (owned by `sync-queue.js` IndexedDB + `QUEUE_EVENT`; the model has no sync section, and the store's allowlist drops any such key — test-enforced).
- **Online-only (excluded):** `checkSyncStatus` header-tag probe, `protectedUrl` (session-bound worker URL), signed avatar/media URLs, mention-preview availability, Supabase response objects/AbortControllers/DOM state.

### Fetch/render split (`screens/home.js`)

Each section is now `fetch*Model()` (network → plain data) + `render*()` (plain data → DOM): `fetchRecentFindsModel/renderRecentFinds`, `fetchFriendRequestsModel/renderFriendRequests`, `fetchRecentCommentsModel/renderRecentComments`, `fetchStatsModel/renderStats`. `renderHomeModel(model)` renders whatever sections are present; `renderHomeFromCache(userId)` is the local-only entry (cache read → render, offline empty states when missing); `renderHomeOfflineEmptyStates()` replaces boot skeletons with a quiet `home.offlineNoCache` notice. Markup/interaction code unchanged; `refreshHome()` now delegates to `refreshHomeSafe()` and rethrows the first section failure for callers that await success (setup completion, find-detail/review edits).

`fetchStatsModel` treats any failed sub-query as a section failure (a partial result must not render as truth or overwrite good cache). `fetchRecentFindsModel` fails only when both feed queries fail.

### Startup sequences

**Online (AUTHENTICATED_COMPLETE):** identity resolved → header refreshed → reveal (unchanged) → post-reveal task: cached Home render (bounded local read; keeps skeletons on miss, never blocks reveal) → **exactly ONE** `refreshHomeSafe()` → fresh sections render in place → assembled model persisted in the background. Cached render is **sequenced strictly before** the refresh so stale data can never paint over fresh data (invariant-tested). Because of that sequencing, the ONLINE-path cache read carries a tight startup budget (`HOME_CACHE_ONLINE_BOOT_BUDGET_MS = 300` in main.js, invariant-capped at ≤ 1 s): a slow/hung IndexedDB forfeits the cached paint instead of delaying a healthy network refresh. Offline boots keep the store's 4 s default, where the cache is the only content and waiting is the better trade.

**Offline (AUTHENTICATED_CACHED) / reauth (AUTHENTICATED_REAUTH_REQUIRED):** B1 owner-matched cached boot → reveal → local-only `renderHomeFromCache(userId)`; no cache ⇒ offline empty states, never Login, no error toasts. **Zero** Home Supabase hydration: `refreshHomeSafe`/`refreshHome` are gated on these two states and re-render from cache instead of touching the network (so Home nav taps offline are also silent). REAUTH_REQUIRED reads the same cached Home; authenticated hydration resumes only at COMPLETE.

Home network refresh count by state: COMPLETE cold boot = 1; CACHED = 0; REAUTH_REQUIRED = 0; reconnect transition to COMPLETE = 1.

### Cache write / failure semantics

- Writes only from a trustworthy online result: gated on `AUTHENTICATED_COMPLETE` + matching `auth.userId` + `state.user.id`.
- Per-section merge-preserve: sections that refreshed successfully update; failed sections keep their previous cached value; nothing is written when every section failed. **A temporary network failure can never destroy a good offline cache** (tested).
- Error rendering: if a section already shows content (cached or fresh), a failed refresh keeps it visible; the inline error placeholder renders only when the section has nothing (tracked per user via `resetHomeSectionTracking`, reset on sign-out).

### Reconnect (refresh-trigger ownership)

`_attemptCachedRevalidation` (online event / visibility / deferred re-probe, `_cachedRevalidationInFlight`-guarded) remains the single owner. On a session materializing for the SAME user whose cached shell is revealed, `_resolveAndRouteForUser` now short-circuits into `_revalidateCachedRevealInPlace`: profile check → header refresh → COMPLETE → snapshot persist → exactly one `refreshHomeSafe()`. **No blocker, no `clearUserScopedUi`, no skeleton flash** — cached Home stays visible and hydrates in place. Profile-fetch failure returns `cached-revalidation-deferred` (shell stays up; triggers retry). A DIFFERENT user's session always takes the full transition path. Duplicate-refresh protection: `_resolutionInFlight` / `_resolvedUsers` dedupe the auth-event and revalidation paths (orchestration-tested).

### Account isolation

- Storage lookups are userId-keyed; A's record is unreadable for B by construction (plus stored-userId re-verification and cross-user read tests).
- `renderHomeFromCache` additionally refuses to render when `state.user.id` differs from the requested id.
- A→B: B1 blocker/clear boundary unchanged; `clearUserScopedUi` now actually blanks the real Home containers (audit fix above); B's cache renders only after B's identity/ownership is established; B without a cache gets skeletons/empty states, never A fallback.

### Logout / delete / clear lifecycle

- **Explicit sign-out (refined during B2a review):** offline trust is revoked IMMEDIATELY and unconditionally — `clearLastValidatedAccount()` runs at the top of the SIGNED_OUT handler, before the draft purge, so a cleanup failure can never preserve a bootable offline identity. "May this account boot offline" (snapshot) and "does this account still have local data awaiting cleanup" (owner marker) are separate states: the owner marker still moves only after a successful purge so the next boot retries the cleanup, and cached boot fails closed on the missing snapshot regardless. The signed-out user's Home cache is likewise cleared unconditionally (outside the purge-success gate); a failed delete is logged only — the record is unreadable without a fresh online sign-in as the same user. This ordering is invariant-tested.
- **Account delete:** routes through `signOut()` → same handler.
- **Account switch (A→B):** A's Home cache is cleared alongside the existing draft purge in `_ensureAppReadyForUser` (follows current local-data-owner purge semantics — no multi-account retention today). Best-effort: a failed delete cannot leak because reads are user-scoped.
- **Settings → Clear local cache:** now also clears all Home caches.

### Media seam for B3

Persisted image sources are `{ key, primaryUrl, fallbackUrl }`. `key` is the stable media key; public `primaryUrl`s are deterministic per key and safe to persist. Protected media persists key-only ⇒ offline thumbnails render the existing 🍄 placeholder (no network attempts; `imageHtml` handles null sources). Signed avatar URLs are nulled at persist ⇒ cached author/friend avatars degrade to initials (same policy as the B1 header). B3 replaces "primaryUrl or placeholder" with "resolve `key` against a user-scoped blob store, then fall back to `primaryUrl`, then placeholder" — no model change needed. Public thumbnails may incidentally load from the browser HTTP cache offline; correctness does not depend on it.

### Boot timing marks added

`home-cache-read-started`, `home-cache-read-completed` (hit flag), `home-cache-rendered` (ageMs), `home-network-refresh-started`, `home-network-refresh-completed` (fresh/failed counts), `home-cache-write-completed` (section count). Stage A's `home-refresh-start`/`home-refresh-end` retained for measure continuity. None block startup; no PII.

### Tests / build

- New: `home-cache.test.js` (13), `home-cache-orchestration.test.js` (11), 13 new invariants in `startup-invariants.test.js`. Coverage: roundtrip, userId keying, A↛B, malformed/version-mismatch/missing-userId fail-closed, storage failure, hung-IDB timeout, stale-readable, per-user + all clear, signed-URL/protectedUrl/token scrub, unknown-section drop, failed-write preserves record; cache-before-fresh ordering, single-refresh, overwrite-on-success, miss-doesn't-block, total/partial network-failure preservation, offline boot with/without cache, repeated offline launch, reauth read-but-no-write, reconnect single refresh + cache rewrite, isolation, sync-key exclusion.
- `npm test`: 875 tests, **837 pass**, 2 fail, 36 skipped. Both failures (`src/screens/map.test.js` leaflet CSS import; `supabase/functions/admin-ops/adminActions.test.ts` Deno) re-verified against the unmodified base via `git stash` — pre-existing, unrelated.
- `npm run build`: succeeds; main chunk 991.83 kB (269.09 kB gzip), +~11 kB over B1's 980.9 kB (cache module + orchestration).
- `git diff --check`: clean. ESLint on changed files: 0 errors (3 pre-existing B1 warnings in main.js).

### Manual Android acceptance (NOT yet executed — required before B2a → merged)

1. Populate: launch online, Home loads, wait for `home-cache-write-completed` in `window.__sporelyBoot`, force-stop.
2. Airplane mode + reopen ⇒ correct account shell, Offline pill, cached recent finds/comments/stats visible, no Login, no error spam, thumbnails may be placeholders (protected) / cached (public).
3. Force-stop offline + reopen ⇒ same cached Home.
4. Reconnect while cached Home visible ⇒ content stays (no blocker/skeleton flash), state → COMPLETE, exactly one refresh (`home-network-refresh-started` once), cache rewritten.
5. Queue observations offline ⇒ sync/pending UI reflects live queue (Home cache holds no sync state by design).
6. A→B switch ⇒ never flash A's Home; B cache or B skeleton/empty.
7. Logout + offline relaunch ⇒ no cached-account access (snapshot, owner and Home cache all cleared).

Boot timing observations: not measured on device this stage; the cached render path adds one local IDB read before the (unchanged) single network refresh and nothing before reveal.

### B2b / B3 refinements suggested by B2a

- B2b should reuse the `AUTHENTICATED_CACHED`/`REAUTH_REQUIRED` gate now applied inside `refreshHomeSafe` as the pattern for gating other online-only actions (friend accept/decline taps on cached rows currently still attempt the network and surface an error toast — acceptable for B2a, first candidate for B2b).
- B3: resolve persisted `key`s through a user-scoped blob store in `image-helpers`' render path (single choke point: `imageHtml`/`wireImageFallback`); also cache the header avatar blob so the B1 "public URL only" policy can go away.
- Consider surfacing `ageMs` ("Saved 2 days ago") near the Offline pill in B2b if field feedback asks for it — the data is already in the read result.
- The `_HOME_SECTIONS` registry in home.js is the extension point for caching My Finds/detail/map later — same fetch/render/persist triple per section.


---

## Stage B2b — capability gating for online-only actions

Status: **implementation complete, uncommitted** on branch `startup-perf-and-offline`. Base commit `d3638cf` (B2a). Awaiting review + Android manual verification.

Roadmap unchanged: B2b = capability gating (this stage); B3 = persistent media/avatar/thumbnail blob cache; later = broader cached Finds/detail/map/taxonomy.

### Capability architecture

New module `src/capabilities.js` centralizes the "is this action allowed right now?" decision so no call site has to re-encode the auth-state → allowed rules. The capability is derived exclusively from `getAuthState()` — `navigator.onLine` remains banned as an authorization signal (Stage B1 invariant preserved).

Public API:

- `canUseAuthenticatedNetwork(overrideState?) → { allowed, reason?, message? }`
- `canPerformCloudMutation(overrideState?)` — same predicate, exposed under a name that documents intent at Supabase INSERT/UPDATE/DELETE/RPC/Edge/Storage sites.
- `canUseOAuthLink(overrideState?)` — Google / iNaturalist "connect this authenticated account" linking. Same gate as `canPerformCloudMutation`.
- `canBeginLoginOAuth(overrideState?)` — the unauthenticated Login pipeline. Allowed only in `UNAUTHENTICATED` (and denied elsewhere so a cached shell never accidentally re-starts the Login OAuth flow — the Reconnect surface handles that instead). Stage A's lazy SocialLogin loader is left intact.
- `isOfflineCachedMode(overrideState?)` — CACHED-only truth for inline UI hints.
- `requiresReauthentication(overrideState?)` — REAUTH_REQUIRED-only.
- `requireCloudMutation({ showToast, silent, overrideState })` — helper that dispatches the standard denial toast (or stays quiet with `{ silent: true }`) and returns the capability object so the caller can `if (!... .allowed) return`.
- `canPerformLocalOperation()` — always `{ allowed: true }`; exists so call sites can be explicit about intent for drafts / queued observations / cache reads.
- `CAPABILITY_REASON` — stable string constants (`offline`, `reauth_required`, `unauthenticated`, `setup_incomplete`, `resolving`).

Denial result shape: `{ allowed: false, reason: <CAPABILITY_REASON>, message: <localized string> }`. Localized copy lives in `src/i18n.js` under `common.internetRequired`, `common.signInToReconnect`, `common.finishSetup` in all four supported locales (en, nb_NO, sv_SE, de_DE).

Gate matrix by state:

| Auth state | Cloud mutation | OAuth link | Login OAuth |
| --- | --- | --- | --- |
| `AUTHENTICATED_COMPLETE` | ALLOWED | ALLOWED | denied |
| `AUTHENTICATED_CACHED` | denied — reason `offline` | denied — reason `offline` | denied |
| `AUTHENTICATED_REAUTH_REQUIRED` | denied — reason `reauth_required` | denied — reason `reauth_required` | denied |
| `AUTHENTICATED_INCOMPLETE` | denied — `setup_incomplete` | denied | denied |
| `UNAUTHENTICATED` | denied — `unauthenticated` | denied | ALLOWED |
| `RESOLVING` | denied — `resolving` | denied | denied |

### Network-action audit summary

Every user-triggered Supabase call site under `src/` was inventoried and classified:

1. **Local-only / always allowed** — Capture, Import, Review draft flows, `enqueueObservation`, `getQueuedObservations`, `deleteQueuedObservation*`, local avatar preview, offline settings (theme, locale, camera preference), Home cache reads, review-draft persistence, iNat "Forget" (local-only), any read-model rendering from cache. NOT gated.
2. **Queued for background sync (unchanged by this stage)** — observation persistence flows through the existing sync queue; capability gates only refuse *manual/foreground* triggers so queued items are neither consumed nor failed while in CACHED / REAUTH_REQUIRED.
3. **Requires authenticated live network (gated at call site)** — comment INSERT, friend accept/decline/remove, avatar upload + `profiles.update`, profile edit save, `delete-account` Edge Function, user_blocks INSERT, reports INSERT, iNaturalist connect, taxonomy `search_taxa_v2` RPC (and its legacy fallback), AI provider operations (`runIdentifyProviderOperation` — the chokepoint shared by Artsorakel and iNat identify).
4. **Requires reauth-specific handling (surfaced via `reason: reauth_required`)** — same set as (3); the message differs so REAUTH_REQUIRED users see "Sign in to reconnect." instead of "Internet connection required."
5. **Read-only with graceful handling (already handled in Stage B2a)** — Home section fetches; `refreshHomeSafe` short-circuits to the cache in CACHED / REAUTH_REQUIRED. Not modified in this stage.
6. **Ambiguous / cross-cutting** — auth-session refresh, cloud-plan snapshot writes, and Home cache write are driven by the Stage B1 revalidation pipeline, not user taps; the state machine itself is the guard. Not user-triggered → not gated at this stage.

### Actions gated in this stage

Explicit `requireCloudMutation({ showToast })` / capability check placed **before any Supabase dispatch** at:

- `src/screens/profile.js`:
  - `_acceptRequest` (friend accept)
  - `_declineRequest` (friend decline)
  - `_removeFriend` (friend remove)
  - `_uploadAvatar` (Supabase storage upload + profiles.update)
  - `_deleteAccount` (delete-account Edge Function invoke)
  - Profile setup/edit save (`saveProfileSetup`/`saveProfileEdit` call)
- `src/screens/find_detail.js`:
  - `_sendComment` (comments INSERT)
  - `_blockObservationAuthor` (user_blocks INSERT)
  - `_reportObservation` (reports INSERT)
  - Per-comment report / block click handlers
- `src/main.js`: `.inat-connect-btn` click handler — refuses BEFORE calling `connectInaturalist` so the lazy SocialLogin plugin is not initialized for a doomed request. `.inat-forget-btn` (local session forget) is intentionally NOT gated.
- `src/taxonomy-v2.js`: `searchTaxaV2` short-circuits to `[]` when `canPerformCloudMutation` denies — the debounced typing input therefore fires ZERO RPCs and never surfaces auth-error toasts. Callers may pass `bypassCapabilityGate: true` for internal orchestration; test suite uses this flag where it stubs the client directly.
- `src/ai-identification.js`: `runIdentifyProviderOperation` throws an `IdentifyProviderCapabilityError` (`code: 'capability_denied'`, `capabilityReason: 'offline' | 'reauth_required'`) BEFORE invoking the provider operation. Local image prep / crop / review remain unaffected — the gate is at the network chokepoint only.
- `src/sync-queue.js`: `triggerSync()` returns `null` without consuming or failing queued work when capability denies. Queued items keep their per-item retry state; when the auth state transitions to COMPLETE the existing reconnect triggers (`online` / `focus` / `visibilitychange:visible`) call `triggerSync()` again and pick up where we left off.

### Actions explicitly NOT gated (preserved offline)

- Capture flows (Sporely Cam, native camera, web camera, import).
- Import Review local edits and draft persistence.
- `enqueueObservation` — the existing sync queue is the offline write path and remains unchanged. The plan's "do not redesign the sync queue" rail is preserved.
- Home cache read / render (B2a).
- Local settings (theme, locale, camera preferences).
- The Login screen's Google / password / signup / reset flows (`canBeginLoginOAuth` allows them in `UNAUTHENTICATED`).
- iNat "Forget" — removes local tokens only.

### UX / message strategy

- Least intrusive per action:
  - Friend accept/decline/remove: click intercepted BEFORE the request; standard denial toast; cached row stays visible so the user can retry on reconnect. The cache is NOT destroyed on denial (Stage B1 invariant).
  - Comment send / block / report: click intercepted; input text preserved.
  - Avatar upload: upload refused; the pre-upload preview is reverted on next profile refresh.
  - Taxonomy search: input remains typable, offline state simply returns no live results (existing search UI treats `[]` as "no matches"). Already-selected taxonomy values persist as observation state and are unaffected.
  - AI identification: refusal is a clean thrown error (`IdentifyProviderCapabilityError`) with the localized message — callers already surface provider errors as toasts.
  - Manual sync trigger: silent no-op (returns `null`); the persistent Offline pill and queue-pending UI already tell the user what's happening.
- Two-message split (per plan): CACHED → "Internet connection required."; REAUTH_REQUIRED → "Sign in to reconnect." Localized in en / nb_NO / sv_SE / de_DE.

### CACHED UX

- Persistent Offline pill (B1) remains the primary status surface.
- Every gated tap surfaces "Internet connection required." via `showToast` — one message per tap, no cascading errors.
- No blanket-disable: buttons remain visible + tappable so field feedback is intuitive (tapping tells you why). Cached content stays visible; no destructive UI transitions.

### REAUTH_REQUIRED UX

- Distinguishes from offline via the reason code + message ("Sign in to reconnect."). The Offline pill is intentionally NOT shown (backend IS reachable — B1 semantics).
- The user is not routed to Login on tap; they are informed and can reach the Reconnect path through the existing Profile / sign-out surface. The cached shell remains fully usable for reads and local drafts.
- Same reconnect pipeline as B1 — no additional plumbing here.

### State-transition behavior

- `CACHED → COMPLETE` and `REAUTH_REQUIRED → COMPLETE`: capability results immediately return `{ allowed: true }`; no reload needed. Every gated site consults `getAuthState()` on each tap. Verified by `capability-gates.test.js` transitions block.
- `COMPLETE → CACHED`: subsequent taps deny; in-flight requests are not aborted (they either complete normally or fail with a real network error already handled per-site).
- Home refresh count invariants (from B2a) are unchanged.

### Tests / results

New:

- `src/capabilities.test.js` — **12 tests**: COMPLETE allows; CACHED denies with `offline`; REAUTH_REQUIRED denies with `reauth_required`; UNAUTHENTICATED denies mutations but allows Login OAuth; COMPLETE forbids re-starting Login OAuth; stable reason codes; local ops always allowed; `overrideState` bypass; `requireCloudMutation` toast + silent variants + allowed path; CACHED vs REAUTH messages distinguishable.
- `src/capability-gates.test.js` — **18 tests**: taxonomy zero-RPC in CACHED/REAUTH + one-RPC in COMPLETE + bypass; AI zero-invocation with correct reason in CACHED/REAUTH + normal path in COMPLETE; manual sync no-op in CACHED/REAUTH; static verification that every DOM-bound handler (profile, find_detail, main, sync-queue) still contains its `requireCloudMutation` / capability check; i18n coverage in all four locales; state transitions.

Existing tests updated:

- `src/taxonomy-v2.test.js` — three call sites now pass `bypassCapabilityGate: true` (they directly test RPC-level behavior with a stubbed client and are not the app path).
- `src/ai-identification.test.js`, `src/artsorakel.test.js`, `src/import-review.test.js`, `src/screens/review.test.js` — seed `AUTHENTICATED_COMPLETE` at module load so the AI-orchestration tests exercise the provider pipeline (not the gate, which has its own tests).

Results:

- `npm test` → 908 tests, **870 pass**, **2 fail**, 36 skipped. The two remaining failures are the pre-existing map (`src/screens/map.test.js` — leaflet CSS import in Node) and admin-ops (`supabase/functions/admin-ops/adminActions.test.ts` — Deno) failures verified as unchanged and unrelated to this stage.
- `npm run build` → succeeds. Main chunk `dist/assets/main-f30tTCCp.js` = 994.62 kB (269.87 kB gzipped), +~2.8 kB over B2a's 991.83 kB baseline (capabilities.js + gate call sites).
- `git diff --check` → clean.
- ESLint on changed files → 0 errors. 7 pre-existing warnings in `ai-identification.js`, `main.js`, `find_detail.js` (none introduced by this stage).

### Android manual QA checklist (required before B2b → merged)

Executed only in Node so far. Device verification needed for the nine scenarios below:

1. Sign in online → wait for `AUTHENTICATED_COMPLETE` → tap "Identify" on a Capture image; provider run completes normally. Force-close and re-open in airplane mode → tap "Identify" → the provider run is refused with "Internet connection required."; no network attempt fired (verify via `chrome://inspect` DevTools network panel).
2. Tap a pending friend request Accept/Decline in cached mode → toast shows "Internet connection required." and the request row stays visible (not deleted from cache). Restore connectivity → transition to COMPLETE → tap Accept again → the request is accepted normally.
3. In REAUTH_REQUIRED (e.g. force an invalidated session with backend reachable) tap Accept → toast reads "Sign in to reconnect."; user stays in cached shell.
4. Open Find detail on a cached observation → type a comment → tap Send in CACHED → toast fires; input text preserved. Same in REAUTH_REQUIRED.
5. Open Review → in the taxonomy search box type 3+ letters in CACHED mode → verify DevTools shows zero `search_taxa_v2` RPC calls; UI shows empty results; no toasts spam. Confirm already-selected taxa on prior observations still render.
6. Profile → tap "Connect iNaturalist" in CACHED / REAUTH → toast fires; SocialLogin plugin is NOT initialized (verify via Android logcat — no `capacitor-social-login` init log). Confirm same button works normally in COMPLETE.
7. Profile → edit username / bio → tap Save in CACHED → toast; overlay stays open (button re-enabled). Same in REAUTH.
8. Queue 3 observations offline → in CACHED tap pull-to-refresh on Finds (which calls `triggerSync`) → items are NOT consumed / failed / retried; queue-pending UI still shows 3 waiting. Restore connectivity → transition to COMPLETE → next `online` / `focus` / `visibilitychange` event drains the queue.
9. Sign in on Login screen → verify unauthenticated Google/password flows still work (Stage A lazy SocialLogin behavior preserved).

Scenarios covered by Node tests today: 2 (partial — the click handler code path is statically asserted + the capability module verifies denial), 5 (taxonomy zero-RPC), 6 (main.js iNat gating is statically asserted; the plugin non-init behavior is design-guaranteed by the gate order), 8 (triggerSync no-op verified).

### `bypassCapabilityGate` — narrow-usage rule (hard constraint)

The `bypassCapabilityGate: true` option on `searchTaxaV2` and `runIdentifyProviderOperation` is an escape hatch around the offline guarantee. It is deliberately narrow and MUST remain so.

Rules:

1. Allowed callers: (a) the module's own definition site, and (b) `*.test.js` files. That's it.
2. It MUST NOT appear anywhere under `src/screens/**` or any other user-triggered click / input / navigation handler.
3. Test suite enforces the rule via two invariants in `src/capability-gates.test.js`:
   - `no screen/user-triggered file passes bypassCapabilityGate` (grep-style scan of `src/screens/**`, ignoring `.test.js`).
   - `bypassCapabilityGate is only referenced by (a) module definitions and (b) test files` (repo-wide scan of `src/` with an explicit allowlist of definition sites: `src/taxonomy-v2.js`, `src/ai-identification.js`).

Current audit (verified by the invariants above):

- `src/taxonomy-v2.js` — definition site (allowed).
- `src/ai-identification.js` — definition site (allowed).
- `src/taxonomy-v2.test.js` — internal test fixtures with a stubbed Supabase client (allowed).
- `src/capability-gates.test.js` — asserts the bypass path works (allowed).
- No screen or other production file references the flag. Any future PR that introduces one will fail the invariant tests.

### Findings that should shape B3

- **Media loader rule (revised):** `ProtectedMediaLoader` MUST NOT be a general bypass. The rule is: read local blob (from the B3 user-scoped IndexedDB blob store) regardless of network capability — that read is a local operation and always allowed. Only attempt the authenticated remote fetch when `canUseAuthenticatedNetwork()` (or `canPerformCloudMutation()`) returns `{ allowed: true }`. In CACHED / REAUTH_REQUIRED the loader silently falls back to the placeholder if the blob is missing, rather than firing a doomed authenticated request. This removes the last "signed URL → 401 → placeholder" round-trip observed in B2a on cached avatars WITHOUT introducing a per-caller escape hatch.
- Do NOT introduce a `bypassCapabilityGate`-shaped option to the media loader. Local read is a plain local op and needs no bypass; remote fetch is capability-gated exactly like every other authenticated network op. The narrow-usage invariants in `capability-gates.test.js` remain the source of truth.
- No schema changes to the auth state model were needed for B2b — B3 does not need to introduce new states either.

### Post-review changes (reviewer concerns 1 + 2)

1. **Concern 1 — narrow-usage rule for `bypassCapabilityGate`.** Two invariant tests added to `src/capability-gates.test.js` enforcing (a) no screen leak and (b) an allowlist of definition sites for the flag. The B3 media-cache recommendation was rewritten (see "Findings that should shape B3" above) so it does NOT propagate the bypass pattern — instead the loader reads local blobs unconditionally and only gates the remote fetch.
2. **Concern 2 — taxonomy search UI must not look like "no results".** The three taxonomy-search callers (`src/screens/review.js`, `src/screens/import_review.js`, `src/screens/find_detail.js`) now check `canPerformCloudMutation()` BEFORE dispatching `searchTaxa` and render a non-selectable `<li class="taxon-dropdown-offline">` with the localized capability message (`"Internet connection required."` / `"Sign in to reconnect."`) in the dropdown. Existing selected taxa on the observation/session remain untouched. A functional test simulates the offline branch and confirms the offline row renders (not an empty dropdown), and static invariants ensure every `searchTaxa` call is preceded by a `canPerformCloudMutation()` check in the same file.

---

## Stage B — final completion (persistent media cache + FINAL corrections)

Status: **code complete, uncommitted** on `main` at base `aaaabca` / package `0.7.1`. Device verification (all 10 Android scenarios) is DEVICE-QA-REQUIRED and pending. Stage C not begun.

Historical predecessor notes above (Stage A / B1 / B2a / B2b) remain accurate for their base commits. The B1 statement "Home cache render on cached boot performs ZERO Supabase hydration" is preserved; the B3 recommendation section is superseded by the concrete implementation described here (it is no longer a suggestion — it is code).

### Base and merge status

- Merged on `main` prior to this stage: Stage A cold-start work, Stage B1 last-validated-account + cached auth states, Stage B2a Home read-model cache, Stage B2b centralized capability gating, hotfix/artsorakel-identify-api. HEAD = `aaaabca` (`Merge branch 'startup-perf-and-offline'`); package version = `0.7.1`.
- Not yet on `main`: the persistent media blob cache, the FINAL corrections to the offline indicator matrix, and the FINAL cloud-plan-FALLBACK guard everywhere it is assigned. This section covers those.

### Persistent media cache (`src/media-cache.js`)

- IndexedDB DB `sporely-media-cache`, version 1, object store `media_blobs`, keyPath `cacheKey`.
- Record: `{ version, cacheKey, userId, mediaKind, privacyScope, mediaKey, variant, contentType, sizeBytes, createdAt, updatedAt, lastAccessedAt, blob }`.
- Cache identity: `v1|<userId>|<mediaKind>|<privacyScope>|<mediaKey>|<variant>`. Derived STRICTLY from durable data — never from signed URLs, worker tokens, bearer headers, or the media worker origin. `mediaKey` for observation media is the canonical storage key (`normalizeMediaKey` upstream); for the avatar it is the sentinel `self:<userId>`.
- Variant normalization: any of `thumb`/`small`/`medium`/`cards` collapse to canonical `thumb`. Avatar always canonicalizes to `original`.
- Scopes: `public` (observation thumbnails from `resolveMediaSources` non-protected path), `protected` (authorized worker fetch path), `self` (the current user's own avatar). Public and protected records for the same observation live under DIFFERENT cache keys and never alias each other.
- Fail-closed: missing userId, schema version mismatch, mismatched userId on a stored record, missing/non-image blob, IDB open failure, quota errors all resolve to `null` / `false`. Storage errors never bubble to callers.
- Never persists: Supabase access/refresh tokens, signed URLs (`?token=…` / `/object/sign/…`), the media-worker origin, Bearer headers.

### Limits and eviction

- `MEDIA_CACHE_MAX_TOTAL_BYTES = 64 MiB`.
- `MEDIA_CACHE_MAX_ENTRY_BYTES = 5 MiB`. Any single blob larger than this is refused (write returns false, remote path does not persist).
- LRU by `lastAccessedAt`. Reads touch the access time on hit; a touch failure never fails the read.
- Pre-emptive eviction on write: sum the projected total, drop oldest entries (excluding the record currently being written) until the projected total fits under the cap.
- `QuotaExceededError` is caught; the module then evicts the oldest quarter of entries and retries `put(...)` once.
- Never deletes a newer / currently-used entry to satisfy a stale LRU update. All constants are exported so tests can assert them.

### Loader (`src/protected-media.js`) — cache-first for keyed media

- `bindCacheableMedia(element, identity, { publicUrl, protectedUrl })` is the new entry point. Every keyed thumbnail (public or protected) plus the avatar routes through this method. The legacy `bindProtectedMedia(element, urlOrSource)` continues to work for call sites that only have a `protectedUrl` (no durable key).
- Load order:
  1. LOCAL cache read via `readCachedMedia(identity)` — no capability gate (local ops are always allowed).
  2. On hit: paint `URL.createObjectURL(blob)`; set `data-protected-media-state="ready"`; done.
  3. On miss: consult `canUseAuthenticatedNetwork()`. If denied (CACHED / REAUTH_REQUIRED / UNAUTHENTICATED / RESOLVING / INCOMPLETE), mark `data-protected-media-state="unavailable"` and STOP. Zero remote traffic.
  4. On COMPLETE miss: fetch (Bearer header for `protectedUrl`, plain `cache: 'no-store'` GET for `publicUrl`); validate content-type starts with `image/`; enforce `MEDIA_CACHE_MAX_ENTRY_BYTES`; persist to cache as a background best-effort; paint the blob.
- In-flight deduplication: `_InFlightRegistry` keyed by `cacheKey`. Multiple DOM elements bound to the same identity share ONE round-trip; stale bindings (released or superseded by a session change) never paint.
- Session change: `handleSessionChange({ session })` bumps the internal `sessionGeneration`, revokes every current object URL, and either disposes (sign-out or A→B) or requeues (same-user token refresh). A's URL cannot be reused for B.
- Protected `401`/`403`/`404` → `deleteCachedMedia(identity)` before painting placeholder, so a subsequent load cannot resurrect the stale blob.
- Cache misses never break existing online display fallback: if a keyed identity cannot be resolved (e.g., no `state.user.id` is available at wire time), `wireImageFallback` falls back to setting `src=<publicUrl>` on the element so the online display still works.

### Image helper (`src/image-helpers.js`) — no raw `src` for keyed images

- `imageHtml(source, className, placeholder)` now emits `data-media-cache="1"` + `data-media-kind` / `data-media-scope` / `data-media-key` / `data-media-variant` / `data-media-public-url` / `data-media-protected-url` (as applicable) instead of a raw `src="…"` when the source carries a stable `key`. The previous behavior emitted `<img src=<remoteUrl>>` for public thumbnails, which triggered a network request from a cached-Home render BEFORE the loader could evaluate the capability gate. The Stage B fix eliminates that pre-JS network burst.
- `wireImageFallback(root)` picks up the data-attrs and binds each element via `bindCacheableMedia(...)`. Legacy paths (`data-protected-media-url`, `data-fallback-src`) are preserved unchanged for non-keyed sources.
- `imageHtml` for sources WITHOUT a durable key retains the legacy direct-src emit (blob:/data: previews, local pending-sync photos) — those have no durable identity and are not cacheable.

### Public thumbnails — acquisition path

- Public thumbnails are cached from a same-origin `fetch(publicUrl, { cache: 'no-store' })` when the app is in `AUTHENTICATED_COMPLETE`. Sporely media is served from `media.sporely.no`, which is same-origin from the web app's perspective; from the Capacitor Android WebView it uses `https://` with CORS. If a specific target proves unreliable in device QA, the loader can be extended to fall through to the authenticated worker path for the same key without any schema change (the identity does not include the transport URL). No changes were made to the Artsorakel path (identify secret stays server-side on the Sporely Worker).
- Cache failure preserves online display: if `fetch` succeeds but content-type/size guards refuse the blob, the loader still paints the response object URL for THIS render — only the persist step is skipped.

### Protected thumbnails — acquisition path

- Existing `ProtectedMediaLoader` bearer-authenticated worker fetch is unchanged. The change is: the response blob is persisted to the media cache on success, keyed under the durable observation key + `privacyScope: 'protected'` + `variant: 'thumb'`. No bearer token or Worker URL is ever persisted.
- Subsequent loads (across process death) render from the persisted blob in CACHED / REAUTH_REQUIRED with ZERO authenticated network attempts.

### Avatar caching

- Cached-boot path (`renderCachedHeaderProfileButtons`): still synchronously paints initials / public URL. Additionally, an async best-effort `readCachedMedia(_avatarIdentity(userId))` may replace the initials with a persisted blob object URL. NO HTTP avatar request is dispatched in CACHED / REAUTH — that path is guarded by the loader's capability gate anyway.
- Online path (`refreshHeaderProfileButtons`): existing signed-URL / public-URL resolution unchanged. After a successful paint, the same URL is re-fetched (`cache: 'no-store'`, `credentials: 'omit'`) as a blob and written to the cache under `self:<userId>`. Best-effort; failure to persist does not affect the immediate paint.
- Upload path (`_uploadAvatar`): the cropped blob is persisted directly to the media cache immediately after the profile row update succeeds, so the next cold boot can render it without any refetch.
- Different-user isolation: identity is `self:<userId>`; A's blob is unreadable for B by construction. Test-enforced in `media-avatar.test.js`.

### CACHED / REAUTH / COMPLETE behavior

- **CACHED**: user-scoped identity → local blob → hit paints objectURL, miss paints placeholder. ZERO remote attempts. Offline indicator visible.
- **REAUTH_REQUIRED**: same. ZERO remote attempts. Offline indicator HIDDEN (backend is reachable — the pill would misinform the user).
- **COMPLETE**: local first; hit paints; miss runs remote via the authenticated media delivery, validates image + enforces the size guard, persists, paints. All remote gated by `canUseAuthenticatedNetwork()`.
- **UNAUTHENTICATED / RESOLVING / INCOMPLETE**: capability gate denies remote; no cache read is attempted for a user whose id does not match the loader's stored `_knownUserId`.

### Reconnect

- No new scheduler. Reused seams:
  - `notifyProtectedMediaSessionChange(session)` fires from the direct Supabase `onAuthStateChange` listener. When a same-user token refresh materializes, existing bindings are revoked and requeued through the cache-first path — an image that missed cache in CACHED can now fetch remotely because the capability gate returns `{ allowed: true }` under COMPLETE.
  - `_attemptCachedRevalidation` (B1 unchanged) transitions state to COMPLETE, which flips the capability gate.
  - Different-user session materializing goes through the full `_resolveAndRouteForUser` account-transition boundary. The loader's `handleSessionChange` disposes every current binding so B never reads A's object URLs.

### Offline indicator correction (L1)

- The pill is driven by an `auth-state` subscription bound at boot: it shows for `AUTHENTICATED_CACHED` and hides for every other state. `_syncCachedStateWithReachability` (which already toggles CACHED ↔ REAUTH_REQUIRED on the fly) causes the subscription to update the pill automatically.
- `navigator.onLine` is not consulted anywhere in this decision.

### Cloud-plan FALLBACK correction (L2)

- New helper `mergeCloudPlanForOfflineFallback(current, next)` in `src/cloud-plan.js` is the sole assignment rule:
  - `NETWORK` next → replaces current.
  - `CACHED` next → accepted only if current is not `NETWORK`.
  - `FALLBACK` next → accepted only if nothing better is currently known (never over `NETWORK` / `CACHED`).
- Callers routed through the helper: `_refreshSettingsCloudPlan` (settings overlay), `_resolveAndRouteForUser` (COMPLETE branch background write), `_revalidateCachedRevealInPlace` (in-place revalidation background write), `_loadProfileData` (profile screen). Regression tests in `cloud-plan.test.js`.

### Lifecycle / account isolation

- Explicit SIGNED_OUT: `clearLastValidatedAccount()` at the top of the handler (B1 refined, unchanged). Home cache clear for the signed-out user is unconditional (B2a). Persistent media clear for the signed-out user is unconditional (new); a failed delete is only logged. The store is userId-keyed so remnants cannot leak into a different user's session anyway.
- Account switch (A→B) in `_ensureAppReadyForUser`: A's Home cache is cleared (existing); A's persistent media is cleared (new).
- Account deletion: routes through `supabase.auth.signOut()` → same SIGNED_OUT cleanup path.
- Settings → Clear local cache: additionally clears every persistent media entry via `clearAllCachedMedia()`.
- Transient network loss NEVER triggers any of these. Only an explicit sign-out / account switch / user-driven "Clear local cache".

### Migration / back-compat

- Fresh installs boot normally; the media DB is created on first write. First online view warms the cache; first offline before warming shows placeholders.
- Records with `record.version !== 1` fail soft as a cache miss. Online re-warms overwrites them.
- No migration from signed URLs — the identity was never derived from them.
- No Home cache schema bump was required.

### Tests added (new files)

- `src/media-cache.js` (new).
- `src/media-cache.test.js` — 19 tests: variant normalization; key composition (no tokens/URLs); write/read roundtrip; missing userId; malformed records; schema mismatch; cross-user refusal; public/protected scope separation; non-image refusal; oversized refusal; LRU touch on read; oldest-eviction on cap; QuotaExceeded evict-and-retry; storage exception is swallowed; per-user clear; global clear; single delete; avatar scope; exported constants.
- `src/media-loader.test.js` — 15 tests: CACHED miss zero remote; CACHED local hit renders zero remote; REAUTH miss zero remote; COMPLETE miss fetch-validate-persist-paint; non-image not cached; oversized not cached; in-flight dedup; release before completion prevents late paint; protected 401 evicts; protected 403 evicts; session change invalidates prior binding; `imageHtml` emits data-attrs and NEVER a raw src for keyed images; legacy protected-URL-only path preserved; legacy direct-src path preserved for data: URIs.
- `src/media-avatar.test.js` — 4 tests: avatar identity is user-scoped self:<uid>; roundtrip; A cannot resolve B's avatar; per-user clear.
- `src/cloud-plan.test.js` — 6 tests added: NETWORK replaces everything; FALLBACK cannot clobber CACHED; FALLBACK cannot clobber NETWORK; FALLBACK accepted when nothing known; CACHED accepted when current is null; CACHED does not downgrade NETWORK.
- Existing `src/protected-media.test.js` unchanged in intent; the harness explicitly opts into the "allowed" capability gate so it exercises the raw fetch path (the Stage B gate is covered separately in `media-loader.test.js`).

### Non-goals (Stage C explicitly not started)

- No My Finds / detail / map cached reads.
- No taxonomy cache.
- No offline Capture/Import/Review redesign.
- No new mutation queues.
- No service worker.
- No full-resolution media cache.
- No new auth states.
- No Artsorakel redesign (server-side identify stays on the Sporely Worker).

---

## Stage B — post-review corrections (audit round)

Status: **code complete, uncommitted** on `main`. Extends the Stage B completion section above. Applies four invariant corrections and one architectural cleanup on top of the code described in "Stage B — final completion". Stage C is still not started; the Artsorakel identify routing is untouched.

### Correction 1 — CACHED / REAUTH avatar: absolute no-network invariant

Previously `renderCachedHeaderProfileButtons` synchronously assigned `img.src = profileSummary.avatar_url` when the URL matched `_looksLikeInlineOrPublicAvatar(...)` (a public http(s) URL without `?token=` / `/object/sign/`). A plain `<img src="…">` triggers a browser-level GET, so this violated the "zero avatar network in CACHED / REAUTH" invariant.

Fix (`src/screens/profile.js`):

- `renderCachedHeaderProfileButtons(profileSummary, options)` now paints initials only, synchronously, on every header target. The `profileSummary.avatar_url` field is ignored for synchronous paint. The async `_paintCachedAvatarInto(targets, uid, initials)` still runs and swaps in a `blob:` object URL from the persisted media cache on hit; a miss retains initials. Zero avatar network requests in any state.
- `refreshHeaderProfileButtons(profile)` is defensively guarded: at the top it consults `canUseAuthenticatedNetwork()` and — if denied — delegates to `renderCachedHeaderProfileButtons(profile || {}, { email: state.user?.email || '' })` and returns. The online path (Supabase storage signed URL + `_canLoadImage` probe) only runs under `AUTHENTICATED_COMPLETE`. Every call site in the codebase (`_loadProfileData`, `_saveProfile`, `_uploadAvatar`, `main.js` in-place revalidation, `main.js` post-setup, `main.js` sign-in) is already an online path, but the gate is now enforced structurally rather than by convention.
- Removed the now-unused helper `_looksLikeInlineOrPublicAvatar()` — the "safe public URL" concept no longer applies to synchronous cached-boot paint.

Behavior matrix:

| State | Sync paint | Async paint | Network |
| --- | --- | --- | --- |
| CACHED | initials | `blob:` from cache on hit; initials on miss | zero |
| REAUTH_REQUIRED | initials | `blob:` from cache on hit; initials on miss | zero |
| COMPLETE | initials, then online refresh may repaint | `blob:` from cache on hit, otherwise overwritten by refreshHeaderProfileButtons | authorized fetch + persist |

### Correction 2 — Public-thumbnail unresolved-identity fallback

Previously `wireImageFallback()` unconditionally assigned `img.src = publicUrl` when a keyed public thumbnail had no resolvable identity (e.g. `state.user.id` not yet bound). Any subsequent browser-level GET would still fire under CACHED / REAUTH.

Fix (`src/image-helpers.js`):

- Added `import { canUseAuthenticatedNetwork } from './capabilities.js'`.
- The unresolved-identity branch now returns without assigning `img.src` unless the capability gate is `allowed`. The behavior is:
  - CACHED / REAUTH_REQUIRED / UNAUTHENTICATED / RESOLVING / INCOMPLETE → no `src` assignment, no fetch — the placeholder stays visible.
  - COMPLETE → the previous behavior is preserved (assign `publicUrl` so the online display still works when the cache cannot own the render, e.g. before `state.user.id` is set).
- Regression tests in `src/image-helpers.test.js` cover both denied states and the allowed COMPLETE path with a `globalThis.fetch` trap that fails the test on any network call.

### Correction 3 — Non-image vs oversized response separation

Previously `_extractImageBlob()` returned `null` for both non-image responses AND for VALID images exceeding `MEDIA_CACHE_MAX_ENTRY_BYTES`. That collapsed two very different failure modes into a single "placeholder" outcome and broke online display for legitimate but too-big-to-cache images.

Fix (`src/protected-media.js`):

- Non-image response (`content-type` does not start with `image/`): return `null` → no paint, no persist, element degrades to `data-protected-media-state="unavailable"`. Unchanged from before.
- Oversized VALID image (`content-type` starts with `image/`, `size > _maxEntryBytes`): SKIP the cache persist step and return the blob so the loader paints via `URL.createObjectURL(...)`. The element still gets `data-protected-media-state="ready"`. On the next cold boot the cache will miss again and — if COMPLETE — refetch; if CACHED / REAUTH the element degrades to placeholder.
- Protected `401 / 403 / 404` behavior is unchanged: `_doAuthorizedFetch` still evicts the cache entry before painting placeholder.

Tests in `src/media-loader.test.js` were updated in place:

- `COMPLETE non-image response is NOT cached AND NOT rendered (placeholder retained)` — asserts no `blob:` created, `img.src === ''`, `data-protected-media-state === 'unavailable'`, and the cache map is empty.
- `COMPLETE oversized valid image RENDERS (object URL) but is NOT persisted` — asserts a `blob:sim-*` was created and bound to `img.src`, `data-protected-media-state === 'ready'`, and the cache map is empty.

### Correction 4 — Global state exposure audit (architectural)

Previous Stage B code exposed the full application state as `globalThis.__sporelyState` and a helper `globalThis.__sporelyCurrentUserId()` from `src/state.js`. The stated rationale was "avoid a hard dependency cycle with state.js at module-load time" in `src/image-helpers.js`.

Audit finding: the cycle is not real. The import graph is

- `image-helpers.js → protected-media.js → { auth-session.js, capabilities.js → { auth-state.js, i18n.js }, media-cache.js }`
- `image-helpers.js → media-cache.js` (leaf)
- `state.js → { observation-defaults.js → settings.js → visibility.js, settings.js }`

`state.js` and its transitive deps do NOT import `image-helpers.js`, so a normal ESM import from `image-helpers.js` into `state.js` is safe. The "DOM-lite tests" concern was unfounded — the test files that exercise `image-helpers.js` already tolerate a small state module load (e.g. `cached-header.test.js` already imports `state` directly).

Fix (option 1 — normal module dependency):

- `src/state.js`: removed `_publishSporelyState()` and its call. `state.js` no longer touches `globalThis`.
- `src/image-helpers.js`: replaced the `globalThis.__sporelyCurrentUserId?.() || __sporelyState?.user?.id` late-bind with a direct `import { state } from './state.js'` and `String(state?.user?.id || '').trim()` inside `_currentUserId()`. No cycle materializes at runtime or in the module graph.

Regression tests added in `src/startup-invariants.test.js`:

- `state.js does NOT publish app state on globalThis` — imports `./state.js` and asserts no property matching `^__sporely` exists on `globalThis`, plus explicit spot-checks for the two prior names (`__sporelyState`, `__sporelyCurrentUserId`).
- `state.js source contains no _publishSporelyState-style globalThis publisher` — grep-guard against reintroduction.

### Tests added / updated in this audit round

- `src/media-avatar.test.js` — added four new tests exercising `renderCachedHeaderProfileButtons` under `AUTHENTICATED_CACHED` and `AUTHENTICATED_REAUTH_REQUIRED` with a stubbed DOM + a `globalThis.fetch` trap + an `img.src` spy that throws on any http/https/signed URL assignment. Verifies initials-only paint on miss and blob-URL-only paint on hit. Total avatar tests: 8.
- `src/image-helpers.test.js` — added three tests covering the unresolved-identity fallback: CACHED denies, REAUTH_REQUIRED denies, COMPLETE preserves the online publicUrl fallback. Total tests: 5.
- `src/media-loader.test.js` — updated the two "not cached" tests to reflect the split: non-image = no render + no persist; oversized valid image = render + no persist.
- `src/cached-header.test.js` — updated three tests to reflect that `renderCachedHeaderProfileButtons` never assigns an http(s) URL to `img.src` synchronously. The previously-existing "uses a public URL avatar synchronously" test was inverted to assert the opposite (initials-only paint).
- `src/startup-invariants.test.js` — added two tests locking down the removal of the `__sporely*` globals (per-object-name check + source grep).

### Files changed in this audit round

- `src/state.js` — removed `_publishSporelyState` and its call.
- `src/image-helpers.js` — normal import of `{ state }` and `{ canUseAuthenticatedNetwork }`; unresolved-identity fallback is now capability-gated.
- `src/protected-media.js` — `_extractImageBlob` split so oversized valid images paint but do not persist; non-image responses still return null.
- `src/screens/profile.js` — `renderCachedHeaderProfileButtons` no longer paints http(s) URLs; `refreshHeaderProfileButtons` gated by `canUseAuthenticatedNetwork()`.
- `src/cached-header.test.js`, `src/image-helpers.test.js`, `src/media-avatar.test.js`, `src/media-loader.test.js`, `src/startup-invariants.test.js` — coverage described above.
- `PLAN-startup.md` — this section.

### Verification results (this round)

- Targeted: `node --test src/media-cache.test.js src/media-loader.test.js src/media-avatar.test.js src/cloud-plan.test.js src/protected-media.test.js` → **65 tests pass, 0 fail**.
- Full: `npm test` → **987 tests, 949 pass, 2 fail, 36 skipped**. Both failures are the pre-existing Leaflet-CSS map test (`src/screens/map.test.js`) and the Deno admin-ops test (`supabase/functions/admin-ops/adminActions.test.ts`) — unchanged and unrelated to this audit. Test count increased by 79 (908 → 987) — includes new avatar / helper / global-exposure invariants.
- `npm run build` → succeeds. Main chunk `dist/assets/main-CZ-c_ZnJ.js` = 1,007.70 kB (273.71 kB gzipped). Bundle size delta is negligible — the changes remove code paths (a helper + globals) and add a capability import.
- `git diff --check` → clean.
- `npx eslint <changed files>` → 0 errors, 0 warnings.

### Invariant answers (post-fix)

1. Can any CACHED / REAUTH path assign an HTTP media URL to `img.src`? **No.** `renderCachedHeaderProfileButtons` paints initials only; `refreshHeaderProfileButtons` delegates back to it when the capability gate denies; `wireImageFallback` skips the publicUrl fallback under denied capability; `ProtectedMediaLoader._loadCacheable` short-circuits at the capability gate; `_paintFromBlob` only ever assigns `blob:` object URLs.
2. Can any CACHED / REAUTH path call `fetch` for media / avatar? **No.** Every remote branch is behind either `canUseAuthenticatedNetwork()` (loader `_loadCacheable`, loader `_loadLegacyProtected`, `wireImageFallback` unresolved-identity branch) or is called only from paths already gated by that check (`refreshHeaderProfileButtons`, `_uploadAvatar`, `_setProfileAvatarSource` via its online-only callers).
3. What happens for oversized valid images? **Render, no persist.** The loader paints via `URL.createObjectURL(blob)` and skips `cacheWrite`. On the next cold boot the cache misses again and — if COMPLETE — refetches; if CACHED / REAUTH the element degrades to the placeholder.
4. What happens for non-image responses? **No render, no persist, placeholder.** `_extractImageBlob` returns null; `_loadCacheable` calls `_markUnavailable(binding)` which removes `src` and sets `data-protected-media-state="unavailable"`.
5. Was the global state exposure removed, narrowed, or retained? **Removed.** `state.js` no longer touches `globalThis`; `image-helpers.js` reads the current user id via a normal ESM import. The design choice was option 1 (normal module dependency) after verifying the previously-cited "hard dependency cycle" did not exist in the module graph.

---

## Stage B — B3 regression correction (public thumbnails broken in the Capacitor WebView)

Status: **code complete, uncommitted** on `main`. Extends the two Stage B sections above. Stage C is still not started; the Artsorakel identify routing is untouched.

### The regression

Observed on-device in the Capacitor Android WebView (app origin `https://localhost`):

```
Access to fetch at https://media.sporely.no/<key>/thumb_....webp
from origin https://localhost has been blocked by CORS:
No Access-Control-Allow-Origin header.
```

Root cause: before Stage B, public thumbnails rendered via a plain `<img src="https://media.sporely.no/...">`. Cross-origin `<img>` rendering does not require fetch CORS. Stage B routed keyed public thumbnails through the cache-first loader (`bindCacheableMedia` → `_loadCacheable`), which calls `fetch(publicUrl)` from JS to acquire a Blob for IndexedDB. That JS fetch IS subject to CORS, and the `sporely-media` R2 bucket behind `media.sporely.no` did not permit the app origins. Consequence: cache warming failed AND the element fell through to the unavailable placeholder — images that were previously displayable online went blank. The "same-origin from the web app's perspective" assumption recorded in "Public thumbnails — acquisition path" above was wrong for every real deployment target (`app.sporely.no` is also a different origin from `media.sporely.no`).

### Correction 1 — client fails OPEN for PUBLIC online display (`src/protected-media.js`)

`_fetchAndCache` now returns an outcome `{ blob, publicSrcFallbackEligible }`. `publicSrcFallbackEligible` is `true` ONLY when a PUBLIC acquisition failed for a **non-authoritative** reason: fetch threw (CORS `TypeError`, transport error), non-OK status, or a non-image body. The public CDN never issues a ruling we trust over the browser's own `<img>` resolution — including 404 and non-image responses, which pre-Stage-B were resolved by the browser itself. On such a failure `_loadCacheable` falls back to a direct `img.src = publicUrl` assignment (`data-protected-media-state="direct"`) instead of the placeholder.

Guard rails on the fallback (`_canFallBackToDirectPublicSrc`):

- `identity.privacyScope === 'public'` only. Protected media stays fail-closed in EVERY failure mode (401/403/404 still evict + placeholder; transport failures paint placeholder; the `publicUrl` option is ignored for protected identities). The `self` avatar scope is also excluded.
- Account-isolation refusals (session user ≠ identity user, `_knownUserId` mismatch) are NOT fallback-eligible — they return `publicSrcFallbackEligible: false`.
- `canUseAuthenticatedNetwork().allowed === true` is **re-checked at assignment time**, because the state may flip to CACHED / REAUTH_REQUIRED while the warming fetch is in flight (a network drop is a likely cause of the failure itself). An http(s) `src` assignment is a browser-level GET and must never happen in those states.
- A `getSession()` exception no longer aborts PUBLIC acquisition (pre-Stage-B the public `<img>` path never consulted the session); protected acquisition still requires token + userId and fails closed.

Resulting behavior matrix for keyed PUBLIC thumbnails:

| State | Cache hit | Miss + warm succeeds | Miss + warm fails (CORS/transport/non-OK/non-image) |
| --- | --- | --- | --- |
| COMPLETE | `blob:` object URL | validate → persist (≤ 5 MiB) → `blob:` object URL | direct `img.src = publicUrl` (browser renders; nothing persisted) |
| CACHED | `blob:` object URL | — (no fetch) | placeholder, zero fetch, zero http(s) src |
| REAUTH_REQUIRED | `blob:` object URL | — (no fetch) | placeholder, zero fetch, zero http(s) src |

`src/image-helpers.js` needed no change: its unresolved-identity fallback already assigns `publicUrl` only when the capability gate allows (audit-round Correction 2) — now consistent with the loader-level fallback.

Supersedes audit-round invariant answer 4 for PUBLIC media only: a public non-image response now falls back to the direct public src under COMPLETE (it is not a tombstone); protected non-image responses still degrade to the placeholder with no render and no persist.

### Correction 2 — public-media CORS deployment (`cloudflare/r2-upload-worker/cors.json`)

`media.sporely.no` is the `sporely-media` R2 bucket exposed via a Cloudflare custom domain; its CORS policy is the repo file `cloudflare/r2-upload-worker/cors.json` (applied to the bucket out-of-band, not by `wrangler deploy`). The stale policy allowed only `https://app.sporely.no`, `https://sporely.no`, `http://localhost:5173`, `http://localhost:3000` — missing `https://localhost` (Capacitor Android), `capacitor://localhost` (Capacitor iOS), `https://www.sporely.no`, and `https://localhost:5173`.

The file now mirrors the canonical app-origin allowlist (`ALLOWED_ORIGINS` in `cloudflare/r2-upload-worker/wrangler.toml` — the single source of truth; no second allowlist invented): `https://app.sporely.no`, `https://sporely.no`, `https://www.sporely.no`, `https://localhost:5173`, `http://localhost:5173`, `https://localhost`, `capacitor://localhost`. Methods narrowed to `GET`/`HEAD` (smallest policy for JS reads; the browser never writes to the bucket directly — all uploads go through the Worker). `http://localhost:3000` was dropped (not in the canonical allowlist; no fetch consumer exists). No `Authorization` was added to public media URLs; protected media authorization semantics are unchanged.

**Deployment required (NOT performed — no deploys from this task):**

```bash
npx wrangler r2 bucket cors set sporely-media --file cloudflare/r2-upload-worker/cors.json
```

(or paste the JSON in Cloudflare dashboard → R2 → `sporely-media` → Settings → CORS policy), then purge the Cloudflare cache for `media.sporely.no` so previously-cached objects pick up the CORS headers.

**Until that bucket policy is deployed, persistent public-thumbnail caching does NOT work from the app origins** — every COMPLETE render uses the direct-src fallback (exactly the pre-Stage-B behavior) and offline boots show placeholders for public thumbnails. Protected-thumbnail and avatar caching are unaffected (worker + Supabase URLs, not bucket CORS). LAN-dev origins (`https://192.168.x.x:5173`) can never be listed in R2 CORS (exact origins only); the fail-open fallback keeps images displayable there permanently.

### Tests (extended `src/media-loader.test.js`; suite 15 → 26 tests)

- COMPLETE public miss + fetch throws (transport error) → `img.src === publicUrl`, `data-protected-media-state="direct"`, nothing persisted, no object URL.
- COMPLETE public miss + CORS-like `TypeError('Failed to fetch')` → publicUrl assigned (exact Android failure shape, `https://media.sporely.no/<key>/thumb_....webp`).
- COMPLETE public miss + non-OK status → direct publicUrl fallback (not a tombstone).
- COMPLETE public non-image response → NOT cached, NOT blob-rendered, direct publicUrl fallback (test updated from the audit round).
- COMPLETE successful warm still renders the `blob:` object URL, never the publicUrl (assertions added to the existing warm test).
- CACHED and REAUTH_REQUIRED with a CORS-failing CDN → zero fetch, zero http(s) src, placeholder.
- Capability flip to denied while the warming fetch is in flight → fallback suppressed, placeholder.
- Protected transport failure with a `publicUrl` option supplied → placeholder, the public URL is never assigned.
- Protected 401/403/404 → placeholder + eviction, never a public URL.
- Protected non-image → placeholder, no render, no persist, no public fallback.

### Verification (this round)

- Targeted: `node --test src/media-loader.test.js src/media-avatar.test.js src/media-cache.test.js src/protected-media.test.js src/image-helpers.test.js` → **67 tests pass, 0 fail**.
- Full `npm test`, `npm run build`, `git diff --check`, `npx eslint` — see the run log in the task report; pre-existing Leaflet-CSS map test and Deno admin-ops test failures remain unrelated.
- On-device Android verification of the rendered fallback and (post-CORS-deploy) of successful cache warming is **DEVICE-QA-REQUIRED** and pending, along with the 10 Stage B scenarios above.

### Files changed in this round

- `src/protected-media.js` — outcome-based `_fetchAndCache`, `_canFallBackToDirectPublicSrc`, `_paintDirectPublicUrl`, session-read hardening for public acquisition.
- `src/media-loader.test.js` — coverage described above.
- `cloudflare/r2-upload-worker/cors.json` — origin allowlist mirrored from `wrangler.toml` `ALLOWED_ORIGINS`; methods narrowed to GET/HEAD.
- `cloudflare/r2-upload-worker/README.md` — documents what `cors.json` governs, the apply command, the keep-in-sync rule, and the cache-purge note.
- `PLAN-startup.md` — this section.

---

## Stage B — device-QA regression fix (persisted-local-session offline cold start)

Status: **code complete, uncommitted** on `main`. Extends the Stage B sections above. Stage C is still not started.

### The regression (observed on Android device)

Sequence: sign in online → warm Home/media cache → force-stop → airplane mode → relaunch. Expected: AUTHENTICATED_CACHED + cached Home. Observed: blocking error **"Could not load your profile. TypeError: Failed to fetch"** with Try again / Sign out — the MOST COMMON offline case never entered AUTHENTICATED_CACHED.

Root cause (confirmed in code):

1. `src/auth-session.js` — `getSharedAuthSession({ refresh: true })` bypasses Sporely's 1-second cache but ultimately calls `supabase.auth.getSession()`, which returns the **locally persisted** session while offline (no network needed when the stored access token is still valid).
2. `src/main.js` `init()` — `initialSession?.user` is therefore truthy, so the initial boot takes the ONLINE path (`resolveAuthenticatedSessionOnce(initialSession, 'initial_boot')`) and **skips `_tryCachedAuthenticatedBoot` entirely**. The B1 cached boot only ever ran for the *no-local-session* / *getSession-threw* cases.
3. `_resolveAndRouteForUser` — `fetchProfileWithSignupRetry(user.id)` fails offline; postgrest-js wraps the thrown fetch as `{ message: 'TypeError: Failed to fetch' }`; the error branch called `_showProfileResolutionError` → the blocking overlay.

### The fix — narrow post-failure fallback, single shared reveal

NO unconditional reachability probe was added to the healthy startup path (Stage A cold-start performance preserved — structurally test-enforced: `_resolveAndRouteForUser` and `_revalidateCachedRevealInPlace` contain no probe reference). Instead:

- **`_revealTrustedCachedShell({ snapshot, targetState, reachability, reason })`** (main.js) — the cached-shell reveal logic was extracted from `_tryCachedAuthenticatedBoot` into ONE trusted implementation: transition boundary (begin/blank/blocker), minimal `state.user`, cloud-plan revive, `_ensureAppReadyForUser`, STALE recheck at every await, cached header paint, target-state set, reveal, Offline pill from `_shouldShowOfflineIndicatorForState(targetState)` (CACHED shows, REAUTH hides — matching the L1 matrix; the previous unconditional `_setOfflineIndicator(true)` was corrected here), local-only `renderHomeFromCache`, `_scheduleCachedRevalidation` (the EXISTING listeners/deferred-re-probe — no new reconnect mechanism). Returns `'revealed' | 'stale'`.
- **`_tryCachedAuthenticatedBoot`** keeps only the B1 no-session gates (snapshot / owner / explicit-rejection / probe → target state) and delegates the reveal.
- **`_tryCachedFallbackAfterProfileFetchFailure({ user, error, generation })`** (main.js) — invoked ONLY from `_resolveAndRouteForUser`'s profile-fetch error branch, BEFORE `_showProfileResolutionError`. Gate order (all must pass):
  1. error is NOT `_isExplicitAuthRejection` (explicit rejection keeps the existing rejection semantics) AND IS `_isTransportSessionError` (a well-formed RLS/schema/server failure never probes — backend reachable by definition);
  2. `readLastValidatedAccount()` valid;
  3. `snapshot.userId === session.user.id` (explicit SAME-user invariant — the fallback never calls into the reveal for a user other than the initialSession's user);
  4. `getLocalDataOwner() === session.user.id`;
  5. `probeBackendReachability()` — run only NOW, after the failure — classifies UNREACHABLE.
  Then it re-verifies `isCurrentAccountTransition(generation, …)` (the probe awaited; a newer transition suppresses the reveal → `'stale'`) and reveals via `_revealTrustedCachedShell` with `targetState: AUTHENTICATED_CACHED` (never REAUTH — that state means reachable-without-session, which cannot be this branch).
- New `RESOLUTION_STATUS.CACHED_OFFLINE_FALLBACK` is deliberately NOT a success status: `resolveAuthenticatedSessionOnce` does not add the user to `_resolvedUsers`, so a reconnect re-enters the pipeline and (state CACHED + same user) takes the existing `_revalidateCachedRevealInPlace` path — in-place COMPLETE, no blocker, exactly one Home refresh, snapshot rewrite.
- The error branch re-checks the transition generation after a denied fallback before painting the blocking error, so a superseded resolution paints nothing.

Behavior matrix (final):

| Case | Outcome |
| --- | --- |
| A. Local session + profile fetch succeeds | unchanged AUTHENTICATED_COMPLETE path (zero probes) |
| B. Local session + transport-failed profile fetch + probe UNREACHABLE + valid same-user snapshot/owner | trusted cached shell: AUTHENTICATED_CACHED, cached header/plan, cached Home, Offline pill, ZERO Home network hydration, existing revalidation triggers |
| C. Local session + profile fetch fails but backend REACHABLE (or error not transport-shaped) | existing blocking profile-resolution error (server failures are never disguised as offline) |
| D. Session user ≠ snapshot user or ≠ local data owner | fail closed → blocking error; another user's cache never revealed; identity gates run BEFORE the probe |
| E. Explicit server-confirmed auth rejection | existing rejection behavior; fallback denied without probing |

Pre-resolution network side effects audited: `_fireClientActivity` → `recordClientActivity` catches all fetch/RPC failures internally (returns `{ called, error }`, never throws) and main.js adds a `.catch` → it fails silently offline, cannot block the fallback, and surfaces no user-visible error. No change required.

### Tests (this round)

- New `src/profile-fetch-offline-fallback.test.js` — **12 tests** mirroring the production gate order with the REAL last-validated-account / local-data-owner / auth-classification (classifiers + probe with injected fetch) / account-transition / auth-state / capabilities modules: (1) offline cold start with persisted session → CACHED revealed; (2) cached Home path, no error overlay, zero Home network hydration, pill shown, capability denied; (3) probe reachable → existing error surface (one probe, post-failure); (3b) non-transport server error → error surface with ZERO probes; (4) snapshot user mismatch → denied pre-probe; (5) owner mismatch → denied pre-probe; (6) explicit rejections (`session_not_found`, `user_not_found`, `invalid_refresh_token`, `invalid_grant`) → denied without probing; (7) healthy path → zero probes, exactly one Home refresh, COMPLETE; (8) reconnect after fallback → in-place COMPLETE, exactly one Home refresh, pill clears, `canUseAuthenticatedNetwork()` flips allowed (media misses become network-capable); (9) sign-out clears snapshot/owner and the fallback fails closed afterwards; plus stale-async suppression mid-probe and real-probe classification of the exact device error shape.
- `src/startup-invariants.test.js` — **7 new structural invariants** pinning production code: fallback attempted inside the error branch before the error surface; all five gates present with local gates before the probe and probe before the reveal (and REAUTH never selectable by the fallback); healthy path probe-free; stale-async rechecks after the probe and before the error surface; single shared reveal (both entry points delegate; one cached-header paint site; one revalidation-scheduling site); `CACHED_OFFLINE_FALLBACK` excluded from `_resolvedUsers` success statuses; pill driven by target state. Three existing invariants were repointed at `_revealTrustedCachedShell` (zero-Home-hydration, transition-boundary, cached-Home-render) — same invariants, now enforced on the shared implementation.

### Verification (this round)

- Focused: `node --test` across offline-boot / startup-invariants / home-cache(+orchestration) / auth-classification / auth-state / cached-header / last-validated-account / cloud-plan / capabilities / capability-gates / media-cache / media-loader / media-avatar / protected-media / image-helpers / profile-fetch-offline-fallback → **260 pass, 0 fail**.
- Full `npm test` → **1017 tests, 979 pass, 2 fail, 36 skipped**. Both failures are the documented pre-existing ones (`src/screens/map.test.js` Leaflet CSS import in Node; `supabase/functions/admin-ops/adminActions.test.ts` Deno) — unrelated and unchanged.
- `npm run build` → succeeds; main chunk `main-*.js` = 1,010.86 kB (274.44 kB gzip), +~3 kB over the audit round.
- `git diff --check` → clean. `npx eslint` on changed files → 0 errors; only the 3 pre-existing main.js warnings remain.

### Device acceptance sequence (DEVICE-QA-REQUIRED before this fix is merged)

1. Sign in online on Android; let Home load fully and media warm (`home-cache-write-completed` mark present; thumbnails/avatar visible). Force-stop the app. Enable airplane mode. Relaunch:
   ⇒ **cached shell revealed (NOT the profile-resolution error)**, Offline pill visible, cached Home content (recent finds / comments / stats), warmed thumbnails and avatar render from the persistent media cache, cached cloud plan correct (Pro stays Pro), and **zero Home/media network attempts after the cached state is established** (verify via `chrome://inspect` network panel: only the single post-failure `/auth/v1/health` probe fires, nothing else).
2. Restore connectivity (airplane mode off) while the cached shell is visible:
   ⇒ the SAME shell revalidates **in place** (no blocker, no skeleton flash), state transitions to AUTHENTICATED_COMPLETE, the Offline pill clears, and **exactly one** Home refresh runs (`home-network-refresh-started` fires once); cached-media misses now fetch and persist normally.

### Files changed in this round

- `src/main.js` — `_tryCachedFallbackAfterProfileFetchFailure`, `_revealTrustedCachedShell` extraction, `RESOLUTION_STATUS.CACHED_OFFLINE_FALLBACK`, error-branch fallback + post-fallback staleness guard.
- `src/profile-fetch-offline-fallback.test.js` — new (12 tests).
- `src/startup-invariants.test.js` — 7 new invariants; 3 repointed at the shared reveal.
- `PLAN-startup.md` — this section.
