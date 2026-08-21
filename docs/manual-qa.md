# Outstanding manual device QA (as of v0.7.2, audited 2026-08-20)

Consolidated from the DEVICE-QA-REQUIRED checklists in `PLAN-startup.md`
(startup/offline work shipped in v0.7.2) and the location/crash-recovery
list in `PLAN.md`. Ordered by risk; designed to run in one Android session.

Audit basis: commit messages `12b7586..46c9f6a`, HISTORY.md, and docs/ contain
no recorded QA passes. Verdicts below distinguish scenarios implicitly covered
by later QA rounds (2–5 were themselves device sessions) from genuinely
untested ones. Cross off items here as they pass; then prune the verbatim
checklists in `PLAN-startup.md`.

## Headline risk

The QA round 5 fix (`862af60` — cached reconnect no-op regression) shipped in
v0.7.2 **without any device verification**. The exact failure mode the release
exists to fix (live same-user reconnect from CACHED) has never been observed
fixed on a device. Item 1 below is the mandatory first check.

## Setup

- Install v0.7.2 on the test device.
- Open `chrome://inspect` DevTools (network + console) and `adb logcat`.
- Boot instrumentation: `window.__sporelyBoot` marks.
- Prerequisite for item 6b: deploy the R2 CORS policy (recorded as NOT yet done):
  `npx wrangler r2 bucket cors set sporely-media --file cloudflare/r2-upload-worker/cors.json`,
  then purge the `media.sporely.no` cache.

## Checklist

1. **Live reconnect end-to-end (round-5 acceptance — unverified headline fix).**
   Start online → airplane ON → Offline pill (CACHED) → queue 2 observations →
   airplane OFF → touch nothing. Within ~15–20 s expect the full log chain:
   `[network] cached watchdog tick` → `[auth] reconnect probe reachable=true` →
   `[auth] reconnect session same-user=true` → `session_resolution_started` →
   `in_place_revalidation_started` → `in_place_revalidation_completed` →
   `[sync] reconnect trigger` → `[sync] queue pass started`.
   Offline pill clears; cached Home revalidates **in place** (no blocker, no
   skeleton flash); `home-network-refresh-started` fires exactly once; both
   observations become **two distinct** remote observations; Finds
   auto-refreshes — no force-close, navigation, or pull-refresh.

2. **Reconnect while backgrounded.** Repeat item 1 with the app backgrounded in
   CACHED when airplane goes off; on return, resume/visibility
   `Network.getStatus()` must trigger the same single recovery.

3. **Pull-to-refresh forced recovery.** While CACHED after connectivity is
   restored, pull Finds immediately → immediate probe (`force: true`) rather
   than waiting for the watchdog tick.

4. **Account isolation A→B.** Sign in as A with cached Home + a queued item;
   switch to B: no A Home content, queued cards, thumbnails, or avatar ever
   flash; B gets its own cache or empty states; B's snapshot replaces A's.

5. **Sign-out / revocation lockout.** Sign out → force-stop → airplane →
   relaunch: the account must NOT boot offline (snapshot, owner marker, Home
   cache all cleared). Separately, revoke the session server-side while
   reachable → reconnect fires SIGNED_OUT → login screen.

6. **Offline cold-start content fidelity.**
   a. Online, wait for `home-cache-write-completed` and visible
      thumbnails/avatar → force-stop → airplane → relaunch: cached shell
      (never the profile error), Offline pill, cached recent
      finds/comments/stats, warmed protected thumbnails + avatar rendered from
      the persistent media cache across process death, Pro plan retained
      (`state.cloudPlan.hasProAccess === true`), and zero network except the
      single post-failure `/auth/v1/health` probe. Repeat once with an expired
      access token if arrangeable.
   b. Online after the CORS deploy: public thumbnails warm the cache
      (`blob:` URLs, entries persisted). Pre-deploy, confirm the direct-src
      fallback keeps public thumbnails displayable online.

7. **B2b capability gates — CACHED pass, then REAUTH pass.** In CACHED:
   Identify → "Internet connection required.", zero network in DevTools;
   friend Accept/Decline → toast, row retained, works after reconnect; comment
   Send → toast, text preserved; taxonomy 3+ letters → zero `search_taxa_v2`
   RPCs, non-selectable offline dropdown row; iNat Connect → toast, no
   `capacitor-social-login` init in logcat; profile Save → toast, overlay
   stays. Then force REAUTH_REQUIRED (reachable backend, invalidated session)
   and confirm the "Sign in to reconnect." variants and that the Offline pill
   is hidden in that state. Note: REAUTH_REQUIRED has never been entered on a
   device in any round.

8. **GPS.**
   a. Two consecutive offline captures: the second must clear
      "Finding location…" at ~30 s if no fix (round-3 supervisor fix,
      unverified).
   b. Outdoor airplane-mode field capture: GNSS fix within the 30 s window;
      on timeout the standard GPS-unavailable UX shows and the save still
      completes locally.

9. **Reconnect on a non-Finds screen.** Restore connectivity while on Home/Map
   with items queued → silent upload; Finds shows the fresh remote
   observations next open.

10. **Fresh/no-cache offline boots.** Launch offline with no Home cache →
    offline empty states, Capture still fully works. Airplane enabled during a
    first-ever launch (before any snapshot) → falls through to
    unauthenticated, no cached reveal.

11. **UI placement.** Offline/Sync chip precedence at narrow widths (never
    both); Offline pill safe-area placement across all screen headers; final
    Finds offline-note layout (contained note above queued cards, correct
    wording per state); scope/status/sort dropdowns disabled offline and
    re-enabled after COMPLETE.

12. **PLAN.md location/crash-recovery list (6 items).** Location slow/off →
    save from review → location sheet immediately above all overlays, all
    three actions respond; explicit retry acquires a fix, continue-without
    saves null coordinates; capture, wait >90 s, save → stored coordinates
    remain capture-time; force-quit from live review → photos/draft restore,
    and no restore after save/cancel; viewfinder appears immediately with
    location off/slow; deny OS location → pill "No location · Tap to fix" →
    settings → reacquire on return.

13. **Login sanity.** Unauthenticated Google and email/password sign-in both
    still work (lazy SocialLogin path).

## Scenarios already covered (do not need re-running)

Confirmed on device during QA rounds 2–5: airplane-mode Finds offline text;
durable local-first offline saves; first offline GNSS fix (~100 m); offline
cold-start recovery post-fix; queue drain on reconnect via force-close;
multi-item queue dedup (round-3 finding: "lost" observations had actually
uploaded); watchdog/probe/session-refresh mechanics (round-5 device run, up to
the resolver). B1's seven scenarios were recorded as Android-verified before
merge, except the persisted-valid-token airplane relaunch variant (later found
broken and fixed — covered by item 6a) and the Offline-pill placement (covered
by item 11).
