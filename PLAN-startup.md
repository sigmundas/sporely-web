# Startup performance and offline work — open items

Stages A, B1, B2a, B2b, Stage B final completion (persistent media cache),
the post-review audit round, the B3 CORS regression fix, the persisted-local
-session cold-start regression fix, the field-offline UX pass, the native
reconnect follow-up, and QA rounds 2 through 5 all shipped in `v0.7.2`
(commit `46c9f6a`; see `HISTORY.md` under **2026-08 — Startup performance
and offline foundation** for the archived implementation detail, commit map,
and invariants to preserve). This plan file now retains only genuinely open
work.

## Stage C — not started

Stage C makes the app feel useful in the field beyond capture/queue. It has
NOT begun. Non-goals for Stage C stated in prior planning still apply: no
service worker in this stage, no taxonomy cache pass, no full-resolution
media cache, no new auth states, no Artsorakel redesign.

Work items:

- **Persisted remote My Finds dataset.** Extend the user-scoped read cache
  beyond Home so prior remote observations are browsable offline. Namespace
  by user id (same rule as `home-cache`), persist the normalized objects
  already returned by the online Finds loader, and treat writes as
  merge-preserve per section (a partial refresh must not destroy a good
  cache — the Home cache invariant).
- **Observation-detail read cache.** Persist the last successfully assembled
  detail model per observation so opening a Find offline renders content
  instead of a spinner. Reuse the media-cache identity for images already
  keyed by media key; do NOT persist signed URLs.
- **Offline maps.** Render cached observations on the map screen from the
  Finds cache; decide separately whether tile-layer offline caching is in
  scope (probably not for this stage — the map today assumes an online tile
  provider).
- **Broader field cache beyond queued items.** Audit the remaining Finds /
  detail / social read paths for anything that still forces a network round
  trip on cached mode and either cache-first them or gate them with the
  existing capability layer so they degrade cleanly.

The Stage B2a `_HOME_SECTIONS` registry in `src/screens/home.js` is the
extension point; each new cached surface follows the same fetch / render /
persist triple.

## Findings that should shape Stage C

Forward-looking notes carried over from prior stage work:

- **Reuse the capability gate applied inside `refreshHomeSafe`** as the
  pattern for other online-only actions in Finds / detail. Friend
  accept/decline taps on cached rows still attempt the network today and
  surface a toast — acceptable for Home, first candidate for Stage C on
  detail. `canPerformCloudMutation()` in `src/capabilities.js` is the
  canonical predicate. The `bypassCapabilityGate` narrow-usage rule
  (`src/capability-gates.test.js`) MUST be preserved — no screen code may
  introduce a bypass.
- **Media loader rule.** The B3 loader rule applies to Stage C surfaces
  too: read local blob (from the user-scoped IndexedDB media store)
  regardless of capability; only attempt the authenticated remote fetch
  when `canUseAuthenticatedNetwork()` allows. In CACHED / REAUTH the loader
  silently falls back to placeholder if the blob is missing. Do NOT
  introduce a media-loader `bypassCapabilityGate` option.
- **Surface `ageMs` near the Offline pill** ("Saved 2 days ago") if field
  feedback asks for it. The Home cache read result already carries `ageMs`
  metadata; the media / Finds caches should return the same shape.
- **Persist the Home / Finds model in the same background task as the
  snapshot writer** so the next cold start renders from cache before
  revalidation. Keep the "only write on NETWORK-sourced data" rule.
- **Cached avatars.** The B1 "public URL only" policy for the header
  avatar can be dropped once the media cache covers `self:<userId>` on
  every path that renders the current user's own image. Stage B already
  wired the avatar cache; verify no residual public-URL fallback survives
  on Stage C surfaces (profile detail, comment authors).

## Outstanding manual device-QA

None of the checklists below are recorded as executed on-device in commit
messages, PLAN.md, or HISTORY.md. Kept verbatim so nothing is silently
dropped; if a QA pass is performed, tick the item and move confirmed
scenarios into HISTORY.md.

### Stage B — final completion (persistent media cache + FINAL corrections)

Ten Android scenarios (originally listed as "DEVICE-QA-REQUIRED"): sign-in
online + media/Home warm + force-stop + airplane mode + relaunch → cached
shell + Offline pill + cached Home + warmed thumbnails/avatar; reconnect
in-place revalidation (no blocker, no skeleton flash, exactly one Home
refresh); Pro user offline retains cached plan; A→B account switch never
leaks A's Home or media into B; logout offline; Clear local cache clears
media entries; explicit sign-out clears snapshot unconditionally.

### Stage B — persisted-local-session offline cold start regression

1. Sign in online → let Home load fully and media warm
   (`home-cache-write-completed` mark present; thumbnails/avatar visible).
   Force-stop the app. Enable airplane mode. Relaunch:
   ⇒ cached shell revealed (NOT the profile-resolution error), Offline pill
   visible, cached Home content (recent finds / comments / stats), warmed
   thumbnails and avatar render from the persistent media cache, cached
   cloud plan correct (Pro stays Pro), and zero Home/media network attempts
   after the cached state is established (only the single post-failure
   `/auth/v1/health` probe fires — verify via `chrome://inspect` network
   panel).
2. Restore connectivity (airplane mode off) while the cached shell is
   visible:
   ⇒ the SAME shell revalidates in place (no blocker, no skeleton flash),
   state transitions to AUTHENTICATED_COMPLETE, the Offline pill clears,
   and exactly one Home refresh runs (`home-network-refresh-started` fires
   once); cached-media misses now fetch and persist normally.

### Field-offline UX + reconnect polish

1. Online → toggle airplane mode → open Finds ⇒ intentional offline text;
   no "Loading…" hang.
2. Airplane-mode capture ⇒ GPS acquires within ≤30 s or times out cleanly;
   observation save proceeds either way.
3. Force-stop / reopen offline ⇒ cached shell + Finds offline text + any
   queued items visible immediately.
4. Restore connectivity while on Finds ⇒ auth transitions to COMPLETE,
   `triggerSync()` fires once, Finds refreshes; completed queue items
   disappear as their remote observation appears.
5. Restore connectivity on another screen (Home / Map) ⇒ upload proceeds
   silently; Finds shows the fresh remote observation next time it opens.
6. A → B account switch while B has no snapshot ⇒ A's queued cards must
   NOT render for B; sign-out clears rendered queue UI immediately.

### Native reconnect + offline Finds layout (device-QA follow-up)

- **A — airplane off while app foregrounded (hands-free recovery):** boot
  offline → AUTHENTICATED_CACHED with queued item → leave the app visible
  on Finds → disable airplane mode. Expected: `networkStatusChange` (or
  the 15 s cached watchdog at worst) triggers ONE revalidation → COMPLETE
  → `triggerSync()` → card progresses (Waiting to upload → Saving
  observation… → Uploading image…) → card disappears → server observation
  appears WITHOUT pull-to-refresh or backgrounding.
- **B — airplane off while backgrounded:** background the app in CACHED
  state → disable airplane mode → return to the app. Expected:
  resume/visibility `Network.getStatus()` (or the watchdog) discovers
  connectivity → same single revalidation path → COMPLETE → sync + Finds
  refresh as in A.
- **C — outdoor GPS in airplane mode:** field capture with no
  connectivity. Expected: GNSS fix accepted within the 30 s window
  (`enableHighAccuracy`); on timeout the existing GPS-unavailable UX shows
  and the observation still saves locally.

### QA round 2 — connectivity loss, local-first Save, multi-item queue

Required device scenarios: online→airplane (Offline pill + Finds offline
note within seconds); airplane capture with GPS wait; force-stop/reopen
offline; restore connectivity on Finds (cards progress, remote Finds
refresh, ≥3 queued observations produce ≥3 distinct remote observations);
restore connectivity on another screen; A→B account switch (A's queue
never renders for B).

### QA round 3 — live reconnect, onLine gates, watchdog poll, chips, GPS stuck

Required device scenarios: live airplane-off recovery while the app stays
foregrounded (expect `[network]` / `[auth]` / `[sync]` log chain, Offline
pill clears, queue drains, Finds auto-refreshes, both queued observations
become two distinct remote observations); pull-to-refresh recovery on
Finds while CACHED; chip precedence at narrow widths; second consecutive
offline capture leaving "Finding location…" at ~30 s; outdoor airplane-mode
GNSS.

### QA round 4 — backend probe as authority

- **A** Start online → airplane ON → CACHED → queue two observations →
  airplane OFF → DO NOTHING → within ≤~15–20 s: `[network] cached watchdog
  tick` → probe succeeds → Offline pill disappears → queue starts → both
  observations sync (two distinct remote observations) → Finds refreshes —
  with no force-close, navigation, or pull-refresh.
- **B** Repeat assuming Capacitor never sends `connected=true` — the
  watchdog alone must still recover on the same timeline.
- **C** While CACHED after restore, pull Finds immediately → immediate
  recovery attempt (force) rather than waiting for the next watchdog tick.

### QA round 5 — cached reconnect no-op fix

Repeat round-4 acceptance (A) with an emphasis on the log chain:
`session_resolution_started` and `in_place_revalidation_started` MUST
appear after a same-user reconnect from CACHED (their absence was the
specific pre-fix failure signature).
