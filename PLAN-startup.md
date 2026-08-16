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

