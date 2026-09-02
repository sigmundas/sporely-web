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

## Troubleshooting appendix — diagnosing the "Session expired" banner

The "Session expired" / "Sign in again" copy on Home, the Profile sheet, and the Finds
note appears **only** in `AUTHENTICATED_REAUTH_REQUIRED` (backend reachable, session
unrecoverable). Plain-offline `AUTHENTICATED_CACHED` does not show it. If a user
reports the banner, the only credential-free trace is the structured `_authLog(...)`
output in `src/main.js` and the auth-classification log lines in `src/auth-classification.js`
(logger is `[auth] ${phase} { extra }`; never emits tokens, session objects, or auth
payloads — enforced by `src/auth-reauth-recovery.test.js:259-267`).

The relevant reason codes, in priority order for triage:

| Log line | What it means | Typical user-visible cause |
|---|---|---|
| `cached_boot_auth_reject_reauth` | Boot hit a server-confirmed refresh-side rejection → REAUTH_REQUIRED | Server-side refresh-token revocation (password change, admin action, 60-day idle hard-expire, PKCE rotation race), or the boot-time `_recoverAndRefresh()` removed the session and the early-boot capture buffer saw the SIGNED_OUT (`reason: 'session-removed-at-init'`) |
| `cached_revalidation_auth_rejected` | Runtime revalidation hit the same → REAUTH_REQUIRED | Same as above, but happened *during* a CACHED/REAUTH→COMPLETE attempt; pinned instead of purging so queued work is preserved |
| `signed_out_internal_session_loss` | Deferred `SIGNED_OUT` for a trusted same-user → REAUTH_REQUIRED (no purge) | auth-js self-purged a non-retryable refresh rejection for a user we already trusted via snapshot + owner marker |
| `reachability_probe` reachable=`true` | Reachability probe at boot returned reachable | Backend is up; the device has a prior online resolution; the session layer is what failed. Almost always the first three rows above. |
| `reachability_probe` reachable=`false` | Reachability probe at boot returned unreachable | The app landed in `AUTHENTICATED_CACHED` instead — the user should see the Offline pill, not the REAUTH banner. If the user reports seeing the REAUTH banner with this log, the cached-revalidation pipeline flipped state on a later probe. |
| `cached_state_synced_with_reachability` | State flipped between CACHED and REAUTH_REQUIRED after a probe | The "back-and-forth" diagnostic — useful to see if a flaky network is making the user oscillate between the two cached-shell states |
| `cached_revalidation_no_user` | `getSession({ refresh: true })` returned null but no explicit error | Server reachable, no session — usually a sign-out from another device |
| `cached_revalidation_transport_failed` | `getSession({ refresh: true })` threw a transport error | Intermittent network during the probe; `_syncCachedStateWithReachability` reflects the probe result either way |

For always-online users who report the banner "out of nowhere", the most common
sequence in the v0.7.2 release is: PKCE refresh-token rotation — the auth-js `initialize()`
on a tab/window focus or a forced supabase-js refresh replaces the old refresh token
with a new one, and the old one becomes `refresh_token_already_used` on the server
(included in `EXPLICIT_AUTH_REJECT_TAGS` deliberately). On a real device this is rare
because the in-app supabase client and the persisted localStorage share the same
rotation, but cross-tab / cross-device concurrency can produce it. The fix is the
"Sign in again" recovery path — the local data is preserved.

`docs/manual-qa.md:81` already notes that **`AUTHENTICATED_REAUTH_REQUIRED` has never
been entered on a device in any round**. This is the most important open QA item for
the offline/auth layer; it is the only state in the v0.7.2 release whose end-to-end
behaviour has not been device-verified.
