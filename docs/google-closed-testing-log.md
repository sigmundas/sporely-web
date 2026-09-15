# Google Closed Testing Track Log

Short-form log of the Google Play closed-testing track status, and any
issues/fixes discovered specifically during that testing period. This file
is plain human-authored project history — not machine-parsed — kept only so
the Sparring workflow tooling can allowlist edits to it as harmless
same-stage follow-up documentation.

## Google's requirement

Google requires at least 12 testers opted in continuously for at least 14
days before a closed testing track can graduate.

## Status

**As of 2026-09-09:** 12/12 testers opted in continuously, day 5 of 14. No
start or eligibility date is recorded here — none was confirmed — so none is
projected; status is tracked in terms of days elapsed against the 14-day
window instead.

**As of 2026-09-11:** day 7 of 14 by the count above. The Finds smooth-
pagination plan's three stages are all accepted on `feature/sparring-v2-pilot`
and device-verified by the developer; the track is reported as all good. Tester
opt-in count was not re-checked for this entry.

## Changes Applied

### Day 11 (September 15, 2026)

**Editable Find location on the existing map — candidate on branch, release and device QA not yet recorded**

- Closed-testing context: a Find's coordinates normally come from photo GPS, which is wrong whenever the specimen was photographed later at home rather than where it was collected. Testers had no way to correct the point.
- Find detail's Location data box gained a final action row: **Map**, **Edit location** (**Set location** when the Find has no coordinates at all), and one compact **Open** menu for Google Maps, Mapy.com and OpenStreetMap — deliberately one menu rather than three permanent service buttons. Editing is owner-only; the read-only actions appear for any viewer of a Find that has coordinates.
- No second mapping UI: the existing observations map gained two modes on the same Leaflet instance. *Focus* opens zoomed to the find with its marker un-clustered and its popup open, widens the time filter to `all` (the default "past month" hides exactly the find being looked up), and walks scope candidates — friends, then public, then feed — until one actually loads it, moving the map's own scope pill with it. A "Back to find" pill returns to the detail screen; it survives map filter changes but is dropped on a later plain visit to the map. *Pick* fixes a crosshair at the viewport centre and pans the map underneath it, starting at the Find's current point and drawing that point as a subdued reference marker. Nothing is written until Save location; Cancel reports nothing, and other markers go non-interactive while picking so a stray tap cannot strand the edit behind another screen.
- Confirming the picker persists `gps_latitude`/`gps_longitude` immediately, the way photos added in this screen already do, and clears `gps_accuracy` and `gps_altitude`. Both described the old position and neither can be recovered for the new one: OpenStreetMap's reverse geocoder carries no elevation, so filling altitude back in would mean sending coordinates to a further third-party elevation service. No schema or migration change.
- Privacy: external-map links are built only from the coordinates the viewer already sees, and carry nothing else — no species, no observation id. An obscured find stays obscured for anyone but its owner: the link is clamped to the same 2-decimal grid the database views fuzz to, and opens centred at a coarse zoom with no pin, so ~1 km of uncertainty is not presented as an exact spot. Owners keep a precise pin on their own find, which is what makes the feature usable for navigating back to a site.
- Tests: 48 focused tests pass across `src/map-links.test.js` (new), `src/screens/map-modes.test.js` (new), `src/screens/map.test.js` and `src/screens/find_detail.test.js`, verified against the frozen candidate in a clean worktree. Full `npm test` on the working tree: **1,328 passed, 36 skipped, 6 failed** — the same six Deno test files Node cannot load, as on Day 8. Production build succeeds and Leaflet stays in its own lazily-loaded chunk.
- Branch `feature/find-location-editing`, commits `92b239a`, `7cde5cf`. Files changed: `index.html`, `src/map-links.js` (new), `src/map-loader.js`, `src/screens/map.js`, `src/screens/find_detail.js`, `src/i18n.js`, `src/style.css`, plus the tests above. Not merged, released, or device-verified.

### Day 9 (September 13, 2026)

**Cross-client logout no longer revokes Android sessions — implemented locally; release and device QA not yet recorded**

- Closed-testing investigation: logging out of `app.sporely.no` also caused the Android app to request sign-in after its access token next refreshed. The supplied Android console showed a transient DNS outage but no `SIGNED_OUT` event; the causal action was the web logout.
- Cause: Sporely's shared explicit-sign-out seam called `supabase.auth.signOut()` without a scope. Supabase defaults that call to global scope, revoking the user's sessions on every device/browser.
- Fix: ordinary in-app logout now passes `{ scope: 'local' }`, so it only ends the session in the current browser or native WebView. An explicit caller can still request `{ scope: 'global' }` for a deliberate account-wide security action. Account deletion already deletes the Auth user server-side and therefore revokes all sessions.
- Regression coverage: the auth recovery suite now asserts the ordinary local scope and preserves the intentional-global escape hatch. Focused auth tests, ESLint, `git diff --check`, and full `npm test` passed.
- Files changed: `src/auth-signout.js`, `src/auth-reauth-recovery.test.js`. No release identifier or device QA recorded yet.

### Day 8 (September 12, 2026)

**Durable upload queue media-loss fix — implemented locally; release and device QA not yet recorded**

- Confirmed production evidence: observation **1253, Hebeloma crustuliniforme**, has image rows at sort orders 0 and 1; observation **1260, Amanita rubescens**, has rows at 0, 1 and 2. Observation media keys are populated, but the corresponding `media.sporely.no` objects return 404. Both users saw local thumbnails, successfully ran AI Photo ID, and pressed Save. 1253 had poor reception; 1260 had good reception but the app was closed shortly after Save.
- Source diagnosis: Save awaits the durable IndexedDB queue write before clearing captured photos. The upload loop reserves an `observation_images` row before uploading bytes. Reconciliation incorrectly treated each reservation's sort order as completed media, and finalization repeated that row-count assumption before deleting the local queue. An interruption after reservation commits and before all expected variants exist—including between full and thumbnail uploads—could therefore discard the only durable image bytes on retry.
- Fix: reconciliation and finalization now use the existing authenticated `verifyWorkerObjectExists()` HEAD primitive. A database row alone cannot complete an image. Full and thumbnail must exist when both are expected; prepared full-only images remain supported, while unprepared legacy entries are safely prepared and re-uploaded. Old local completion hints are ignored. Retries reuse existing reservation IDs and paths, including when the reservation ID was not persisted locally before interruption. No UI timing or media-pipeline redesign.
- Regression coverage: nine tests exercise reservation-only restart with and without a saved reservation ID, preservation of queued bytes through failed upload and retry, full present/thumbnail absent, genuinely complete remote media, partial multi-image recovery, full-only images, legacy preparation, ambiguous HEAD failures, and refusal to finalize when expected media remains absent. Seven fail against the original implementation; all nine pass with the fix. No existing test explicitly asserted that reservation rows imply completion.
- Validation: **201 relevant sync/media/connectivity tests passed**. Full `npm test`: **1,269 passed, 36 skipped, 6 failed** because Node could not load six Deno test files correctly. Running those six files under Deno produced **112 passed**. `git diff --check` passed. These are automated results; relaunch/kill/connectivity device QA and closed-track deployment are not yet recorded.
- Other metadata-before-bytes paths inspected but left outside this queue fix: direct Add Photos reserves rows before upload; gallery deletion repairs primary media keys from remaining rows without HEAD verification; SQL media projections generate URLs from database metadata.
- Compatibility/recovery: surviving local queue bytes can repair already-stranded reservations such as 1253 and 1260. If an older client already deleted those bytes, recovery requires another retained copy; database metadata cannot reconstruct the photos. **No production data was modified.**
- Files changed: `src/sync-queue.js`, `src/sync-queue-recovery.test.js`. No commit or release identifier recorded for this fix yet.

**R2 upload worker: expose `X-Sporely-Error-Code` via CORS — deployed, verified on device**
- Device regression from the HEAD-based reconciliation above: `HEAD …/1261/0_….webp → 404` surfaced as `Worker HEAD returned unexpected 404: unknown` and the background sync failed. The worker already set `X-Sporely-Error-Code: media_not_found` on missing objects, but `corsHeaders()` never emitted `Access-Control-Expose-Headers`, so the Capacitor WebView hid the header from JavaScript and the client's deliberately conservative 404 classification threw.
- Fix: `Access-Control-Expose-Headers: X-Sporely-Error-Code` set centrally in `corsHeaders()` (no prior expose configuration existed). Client `_headViaWorker()` unchanged: only `404 + media_not_found` means "object absent"; any other 404 still throws.
- Tests: worker suite 92 passed (two new: missing-object HEAD returns 404 + `media_not_found` and exposes the header for an allowed Origin; success responses carry the expose header). Client `images.test.js` HEAD tri-state tests 29 passed.
- Deployed with `npx wrangler deploy` from `cloudflare/r2-upload-worker`; the previously stuck queue item retried successfully on the device without a new Android build. Branch `fix/r2-worker-expose-error-code-header`, commit `b5107aa`. Files changed: `cloudflare/r2-upload-worker/src/index.js`, `cloudflare/r2-upload-worker/src/index.test.js`.

**Android: "Save originals to phone" setting and Sporely Cam cache lifecycle — candidate on branch, device QA pending**
- Sporely Cam captures in `cache/native-camera/sporely-native-*.jpg` were never removed after Save (~200 MB accumulated in a week on one device). New lifecycle: `enqueueObservation()` succeeds → optional MediaStore copy of the original JPEG (EXIF/GPS intact) to `Pictures/Sporely` when the new Android-only setting is ON (default OFF) → private cache source deleted. Enqueue failure retains the source; gallery-export failure keeps the save, shows a toast, and still frees the source.
- Startup prune removes `sporely-native-*` files older than 48 h, but captures referenced by the persisted review draft are passed as protected paths and re-validated natively; if the draft cannot be read the prune is skipped. Cancelled-session cleanup unchanged; no upgrade wipe.
- Tests: 1,285 Node tests passed (the same 6 Deno files fail under Node as above); 6 JUnit tests for the native guards. Design, uncovered paths and the device QA checklist: `docs/native-camera-storage-lifecycle.md`.
- Branch `feature/native-camera-originals-lifecycle`, commits `975c623`, `42e6977`; version bump `5d3e26b` (**v0.7.7, versionCode 284**). Not yet merged, released, or device-verified.

### Day 7 (September 11, 2026)

**Finds prefetch and incremental hydration (Stage 3)** — see `docs/plans/completed/2026-09-09-finds-smooth-pagination.md`, sections 3.0–3.8
- The next Finds page is now requested about one viewport ahead through an `IntersectionObserver` on a stable bottom sentinel, instead of 240 px from the bottom, so fast scrolling normally never reaches an unloaded boundary. A viewport-derived scroll fallback covers WebViews without the observer.
- Red-list badges and author profiles no longer block a page from rendering; they arrive in the background and are patched into existing cards. Profile hydration now merges instead of rebuilding, so earlier pages keep their authors.
- The Finds empty state can no longer flash before the first authoritative page has returned (transient observed during Stage 2 device QA).
- If the user does out-run prefetch, a subtle inline "Loading more finds…" line appears in the list footer while waiting. Not a toast or popup.
- Independent review (agent-sparring, codex-cli) sent the first candidate back for stale observer reports bypassing the geometry gate and a latched indicator; both fixed in the second commit. Device QA passed on `8d3276f`.
- Commits: `c149c86`, `8d3276f`. Files changed: `src/screens/finds.js`, `src/screens/finds.test.js`, `src/i18n.js`, `src/style.css`.

**Finds incremental load-more rendering and thumbnail preservation (Stage 2)** — see the same plan, sections 2.1–2.11
- Load-more now appends the new page in place instead of rebuilding the whole list, so existing cards, `<img>` nodes and media bindings survive and thumbnails stop flashing white on pagination. Image-metadata lookup runs only for the newly added ids.
- Returning from an observation's detail view re-renders from the already-loaded pages instead of refetching page 1, so scroll position is restored correctly past page 1.
- Device QA on the first frozen candidate found a double thumbnail flicker per typed search character; the keystroke narrowing render and the debounced authoritative reload now reconcile in place as well, with a survivor-order gate that compares against display order (species grouping) rather than cache order. Device QA passed on `683e843`.
- Commits: `b609404`, `654502f`, `d20aef3`, `d8461fc`, `683e843`. Files changed: `src/screens/finds.js`, `src/screens/finds.test.js`, `src/screens/find_detail.js`.

**Test-anchor hardening** — `4c0caac`, `5786136`: source-contract test anchors now fail loudly on anchor rot instead of passing silently. Tests only, no product change.

### Day 5 (September 9, 2026)

**Finds search pagination correction (Stage 1)** — see `docs/plans/completed/2026-09-09-finds-smooth-pagination.md`
- Fixed two search-input defects found by independent code review: the render-guard/paging invalidation ran after the local narrowing render started (discarding that render once its async image lookup resolved), and the debounce timer armed unconditionally even for a normalized-equivalent edit (letting it silently reset paging to page one).
- Files changed: `src/screens/finds.js`, `src/screens/finds.test.js`.
