# Reliable offline startup for the iPhone home-screen app

Status: proposed, 2026-10-31. Audit and planning only; implementation has not started.

## Outcome

A returning user who has prepared Sporely online can fully close the iPhone
home-screen app, enable airplane mode, reopen it, and use the existing offline
Home, camera/review, photo-import and queued-observation paths. Reconnection uses
the existing authenticated sync machinery when the app is open.

Installing on the home screen alone is not an offline-readiness guarantee.
The app files must finish downloading, and the device must retain a trusted
account and local storage. First use, sign-in, AI identification, remote searches,
map tiles and uploads still require a connection where they do today.

## Audit evidence

Audited `sporely-web` at `13311ccad4138377a51000e7c2ea8c6148b14466`, on branch
`feature/admin-sync-health-detail`. Initial status: only untracked `.claude/`.
That unrelated work is outside this plan. The plan should be implemented on a
dedicated branch from the agreed integration base; recheck these symbols there.

| Finding | Evidence | Consequence |
| --- | --- | --- |
| Home-screen installation is configured. | `index.html` Apple web-app metadata; `public/manifest.json`, `display: standalone`, `start_url: /`. | Keep the existing installation path. |
| No service-worker registration or build integration was found. | Search of `src/`, `public/`, `scripts/`, `index.html`, `package.json`, `vite.config.js`; only an existing cache-purge comment mentions service workers. | Add app-file caching; browser HTTP caching alone is insufficient for reliable offline reopening. |
| Android bundles the web files locally. | `capacitor.config.json`, `webDir: dist`, no remote `server` configuration; `.github/workflows/release-android.yml`. | Register the worker only in the hosted browser app, excluding Capacitor. |
| Offline identity and startup already exist. | `main.js`: `_tryCachedAuthenticatedBoot()`, `_tryCachedFallbackAfterProfileFetchFailure()`, `_revealTrustedCachedShell()`; `last-validated-account.js`, `local-data-owner.js`. | Reuse these paths and their same-account checks. Do not create another offline authentication system. |
| Home and selected images are persistent. | `home-cache.js`; `media-cache.js` stores Home thumbnails/avatar blobs with account/privacy keys and a 64 MiB cap. | Offline startup can restore that existing subset; it does not provide a full downloaded observation library. |
| Offline Finds shows queued items. | `screens/finds.js`: `_renderFindsOfflineShell()` reads `getQueuedObservations()`; ordinary remote Finds caches are in memory. | Do not promise browsing all previously viewed or uploaded observations after restart. |
| New observations are saved locally first. | `sync-queue.js`: `_enqueueObservation()` stores bytes and stable sync keys in IndexedDB, resolves after transaction completion, then calls `triggerSync()`. | Preserve the queue, identities, retry logic and authenticated mutation gate. |
| Unsaved camera reviews and imports have recovery paths. | `review-draft-store.js`; `main.js` `bootApp()` pending-import restore; `screens/review.js` draft checkpoints; `import-store.js`. | Test recovery across an actual process close. Draft persistence is best effort and is not proof that every just-taken photo has reached disk. |
| Sign-out and cache clearing delete every Cache Storage cache. | `main.js`: `_clearInMemoryUserState()` and `settings-clear-cache-btn` handler. | They would erase a future offline shell. Separate static app files from the existing user-data cleanup. |
| Several dependencies load only on demand. | `map-loader.js`; `screens/import-helpers.js` imports EXIF and HEIC converters; `screens/review.js` imports image-crop helpers. | Caching only the initial JavaScript bundle is insufficient. Include required lazy chunks before declaring readiness. |
| External resources remain network-dependent. | Turnstile in `index.html`; remote AI/taxonomy/location services; OSM tiles in `screens/map.js`. Fonts are self-hosted under `public/fonts/`. | Cache local fonts/assets. Keep external requests and authentication challenges outside service-worker caching. |
| Hosting rules are partly documented in the repo. | `public/_headers` describes Cloudflare Pages and allows `worker-src 'self' blob:`; it has no worker-specific cache rule. No web deployment workflow was found in `.github/workflows/`. | Verify the actual Pages deployment settings and asset retention before rollout; do not assume GitHub pushes deploy a particular branch. |

Read-only live check on 2026-10-31: `https://app.sporely.no/` returned HTTP 200
from Cloudflare, with `Cache-Control: public, max-age=0, must-revalidate` and the
expected CSP. It loaded `/assets/main-B76_cIxC.js` (918,476 text characters),
which contained neither `serviceWorker` nor `registerSW`. Its HTTP cache policy
was `public, max-age=14400, must-revalidate`. This supports the source finding;
it does not establish which Git revision is deployed or inspect registrations
already stored on a particular iPhone.

Focused baseline, run without builds, installations or production writes:

```sh
node --test src/offline-boot.test.js src/startup-invariants.test.js src/home-cache-orchestration.test.js src/last-validated-account.test.js src/local-data-owner.test.js src/capabilities.test.js src/media-cache.test.js src/review-draft-store.test.js src/live-reconnect.test.js src/sync-queue-recovery.test.js
```

Result: **176 tests, 176 pass, 0 fail, 0 skip** on Node **v26.12.1**. The repo's
`.nvmrc` specifies Node 22; repeat the baseline on the implementation runtime.
Some suites model orchestration or inspect source. They do not exercise a real
service worker, WebKit storage, camera permissions or an iPhone restart.

## Design decisions

- Use a small worker and Vite build integration, initially without new production
  dependencies. If implementation shows that a maintained caching library is
  preferable, stop at that decision and obtain dependency approval first.
- Generate a release identity from the actual built shell and asset contents,
  including public files. Package version alone is insufficient: two builds can
  share a version but have different files.
- Produce an explicit precache list from build output, including static imports,
  required lazy chunks, CSS, local fonts and current manifest/icons. Never use a
  blanket runtime cache of all fetched URLs. Exclude source maps, worker files,
  hosting metadata, downloaded user media and authentication helper documents.
- Install a complete release into a namespaced static cache. Verify successful
  responses and expected content/integrity; a Pages SPA fallback returning HTML
  for a missing JavaScript URL must fail installation. Partial installation must
  not replace the previously working release.
- Bind the HTML to the same release as its assets. Emit a content-addressed copy
  of the built app HTML for installation, rather than fetching mutable `/` while
  deployment may be switching. Cache it under the canonical shell key. Do not
  combine newly fetched root HTML with an older worker's cached scripts.
- Serve normal root app navigation from the active release's shell, and known
  assets from its precache. Preserve the browser URL for the existing hash/query
  handlers, but never store a token-bearing URL or callback response as a key.
  Auth callback/consent/Turnstile helper routes stay network-only; an offline auth
  return must fail clearly rather than replaying cached authentication HTML.
- Keep all non-GET requests, API/auth/health calls, media, signed URLs, external
  requests and requests outside the explicit static allowlist on the network.
  The worker does not create API responses or determine authentication/reachability.
- Register on supported HTTPS browser origins only. Exclude Capacitor with the
  existing `isNativeApp()` predicate and disable registration during ordinary
  Vite development. Registration or installation failure must not block online
  startup or discard local user data.
- Preserve static app caches during existing sign-out/account-switch/data-cache
  cleanup. Continue existing user-data revocation and cleanup. Retaining static
  files must never restore a signed-out identity or expose another account's data.
- Let updates wait until all clients using the old worker have closed. Do not
  call unconditional `skipWaiting()`, automatically reload, or interrupt capture,
  review, import or uploads. Indicate that an update is downloaded and will apply
  after the app and other Sporely windows are closed. Do not add an immediate
  update button requiring a new multi-window coordination system in this slice.
- Clean up obsolete owned static caches only once normal activation establishes
  that no clients still need the old worker. Failed updates retain the old release.
  Check for updates on suitable online/foreground events without adding polling
  or backend probes; do not confuse update availability with cloud connectivity.
- Readiness must distinguish complete app-file installation from trusted offline
  account availability. A useful Settings status can report downloading, ready,
  unavailable and update waiting, using the existing UI/i18n patterns. Check the
  active release and cache contents, not just `navigator.serviceWorker.controller`.
  Do not show that the whole observation library has been downloaded.
- Browser storage can be cleared or evicted. Readiness is a current check, not a
  permanent guarantee. Reprepare when online; never report missing shell assets
  as safe for offline use. Preserve queue/draft stores during worker repair.

## Numbered implementation stages

### Stage 1 — Separate app-file caches from user-data cleanup

Scope: the two Cache Storage purge sites in `src/main.js`, a small shared cache
ownership helper, and focused tests. Reserve the static cache namespace used by
later stages. Preserve current Home/media/import cleanup and queue retention;
do not redesign what “Clear local cache” deletes in IndexedDB.

Validation: Node syntax checks; tests proving owned shell caches survive while
the existing other-cache purge still runs; existing account-transition,
last-validated-account, local-data-owner and offline-boot suites.

Human gate before commit: sign out and reopen offline (no previous account data),
switch accounts (no old thumbnails/drafts), and clear local cache (queued finds
remain). Stop after this stage and record evidence/deferred work here.

### Stage 2 — Install and serve a complete versioned offline shell

Scope: `vite.config.js`, proposed build helper under `scripts/`, worker source,
browser registration module, a small registration call in `src/main.js`,
`public/_headers`, and focused tests. Keep startup/auth/sync decisions unchanged.

Add the generated complete asset manifest and content-addressed shell, atomic
installation behavior, static request allowlist, browser/native guards and
nonblocking error handling. Add revalidation headers for the stable worker URL;
verify its MIME type and root scope without weakening existing CSP or helper
route policies. Retain normal waiting-worker activation from the start.

Validation: fixture tests for generated output and release changes; failed or
partial install, HTML masquerading as an asset, query/token exclusion, callback
bypass, non-GET/API bypass and Capacitor/dev guards. Run focused baseline suites.
With explicit build authorization, inspect a production build and verify every
manifest URL and required lazy chunk. No Capacitor sync or full Android build.
Exercise worker lifecycle and cache failure in a real browser, not solely mocks.

Human gate before commit: install on a trusted HTTPS test origin, complete online
preparation, fully close the iPhone home-screen app and other test-origin windows,
then reopen in airplane mode. Verify cached Home, camera capture, saved queued
finds, review recovery and photo import whose lazy code was never opened online.
Android's installed app must continue using its bundled files.

### Stage 3 — Show preparation and update status safely

Scope: the new worker registration/status module, bounded existing Settings UI
integration in `index.html`/`src/main.js`, `src/i18n.js`, minimal styles if needed,
and targeted tests. Reuse existing Settings, toasts and localization conventions.

Expose app-file preparation progress and failure/retry, trusted-account readiness
and waiting-update status. An update applies after all old clients close; no
automatic reload, cache purge or service-worker upload implementation. Handle
unavailable Cache Storage, quota failure and missing cached files honestly.

Validation: status/lifecycle tests, all existing locale checks relevant to new
strings, syntax checks, browser inspection and static layout screenshots where
available. Test two open browser windows plus the home-screen app: no old client
loses its assets while an update waits, and the next eligible launch uses a
complete new release. Simulate interrupted installation and confirm old release
still starts offline. Never describe screenshots as interactive proof.

Human gate before commit: verify status wording, initial download, update waiting,
ongoing capture/review during an update, and successful offline relaunch on the
new version with queued finds intact. Confirm signed-out readiness is distinct
from signed-in offline access.

### Stage 4 — Verify iPhone field use and prepare a guarded rollout

Scope: this plan's verification record, a compact testing/rollout guide and
`README.md` offline-use documentation. Fix only defects demonstrated by these
checks, returning to the relevant bounded stage where necessary.

Required device checklist:

1. Fresh install: open online, sign in and wait for readiness. Close the app and
   all same-origin Safari windows; enable airplane mode; reopen from the icon.
2. Existing install: prepare without removing/reinstalling it; repeat cold start.
   Repeat after several hours so an expired session takes the existing fallback.
3. Open the camera offline, obtain a device location if available, take photos,
   save finds, close, reopen and confirm queue/photos/coordinates survive.
   An offline GPS fix or reverse-geocoded location name is not guaranteed.
4. Close during review and restore the persisted draft. Import representative
   JPEG/HEIC photos offline without previously exercising that code online.
   Compare metadata and queue outcomes with existing behavior.
5. Restore internet and foreground the app. Have the user verify upload outcomes,
   image pairing, stable identity and absence of duplicate finds. Any agent-run
   production writes require separate specific approval; local/test fixtures are
   the default for automated verification.
6. Sign out, switch accounts, clear local data caches and relaunch offline.
   Check privacy boundaries and retained queue behavior. Explicit browser storage
   deletion removes offline preparation; online recovery must be understandable.
7. Install a newer release while another client and a camera/review session are
   open; interrupt its download. Existing work must survive. Close all clients,
   reopen, and verify a complete release and intact local finds.
8. Repeat supported browser/PWA checks and an Android native smoke test. Record
   iPhone model, iOS version, installed/Safari mode, build identity and outcomes.

Rollout gate: identify the actual Pages project, deployment branch/settings and
preview origin; validate HTTPS, worker MIME/scope, headers and missing-asset
behavior there. Obtain explicit approval before deploying production changes.
Prepare rollback before rollout: reverting app registration alone does not remove
an already installed worker. Document a replacement worker that relinquishes
control safely and clears only owned shell caches, preserves local data, and
works even when the old worker serves old HTML. Offline devices cannot receive a
rollback until they reconnect. Test this recovery on the preview origin first.

## Execution and completion rules

- Implement only one stage per task. Update this plan's current-stage record
  before stopping with changed symbols, test evidence, manual-check status and
  remaining work. No stage has started yet.
- Use focused `node --test ...` commands and syntax checks; do not run `npm test`
  after JavaScript edits. Do not install dependencies, run production builds,
  Capacitor sync or packaging without the required explicit authorization.
- These stages change interactive behavior or restart persistence and are human
  gated. Leave implementation uncommitted until the user confirms the listed
  checks; then commit and push each verified stage separately under Git policy.
  A future approved managed run can hold these checks in engine gates instead.
- Completing this plan requires the real iPhone checks and rollout decision;
  unit-test success alone is not proof of reliable offline field use.

## Deferred scope

Full offline observation/detail libraries, offline taxonomy search and AI,
downloaded map regions, changes to draft durability or sync architecture,
background uploads while the iPhone app is closed, SharePoint integration and
native iOS packaging each need a separate audit and plan. The proposed worker
supplies app-file availability for Sporely's existing offline features.
