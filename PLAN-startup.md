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
