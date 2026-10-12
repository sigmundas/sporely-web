# Cache-first startup and optimistic connectivity

Status: proposed 2026-10-04. Planning only; implementation and execution have not started.

## Outcome

When a returning user opens Sporely after several hours, show their trusted cached
content immediately and keep the normal appearance while checking the backend and
session. Show Offline only after a backend connectivity check fails. Refresh
content in place when validation succeeds, without blanking the screen or briefly
switching Finds to its offline layout.

“Assume online” is a presentation policy, not authentication authority. A trusted
cached identity does not authorize uploads, RPCs, or cloud mutations. Session
rejection must produce the existing reauthentication experience, separately from
backend unreachability.

## Verified starting point

Audited canonical `sporely-web` at `d38ede0` on 2026-10-04; the working tree was
clean before this plan. The user's particular device occurrence has not been
reproduced. These code paths can explain it:

- `src/main.js`: `handleConnectivityLost()` immediately downgrades COMPLETE to
  CACHED on a native/browser loss hint, after same-user ownership checks.
- `src/native-network.js`: `_checkStatusAndNotify()` reports loss when foreground
  `getStatus()` returns false. Native false events also report loss immediately.
- `src/main.js`: `_attemptCachedRevalidation()` sequentially probes the backend,
  calls `getSharedAuthSession({ refresh: true })`, and resolves the profile/header.
  `_revalidateCachedRevealInPlace()` clears Offline only after that pipeline.
- `src/auth-session.js`: `refresh: true` bypasses the application's short session
  cache; the implementation calls Supabase `auth.getSession()`, not
  `auth.refreshSession()`. Do not assume it forces a server refresh.
- Home is already cache-first after online account resolution. The cache read has
  a 300 ms budget, but runs after session/profile/header work and shell reveal.
  `_tryCachedAuthenticatedBoot()` also waits for a backend probe before reveal.
- CACHED both displays Offline and blocks cloud operations through
  `src/capabilities.js`; changing the badge alone would leave other offline UI and
  action denials behind.

On 2026-10-04, the following focused baseline passed: **157 tests, 0 failures**:

```sh
node --test src/connectivity-loss.test.js src/offline-boot.test.js src/home-cache-orchestration.test.js src/native-network.test.js src/auth-classification.test.js src/startup-invariants.test.js src/capabilities.test.js src/live-reconnect.test.js
```

The full `npm test` baseline also completed on 2026-10-04 under the current host's
Node v25.8.2: **1587 tests, 1544 pass, 6 fail, 37 skipped**, exit 1. The six failures
are the TypeScript suites below (module-loading/type-export errors):

- `supabase/functions/admin-ops/adminActions.test.ts`
- `supabase/functions/reference-curation/actions.test.ts`
- `supabase/functions/reference-curation/http.test.ts`
- `supabase/functions/reference-curation/lifecycle_actions.test.ts`
- `supabase/functions/reference-curation/reads.test.ts`
- `supabase/tests/adminActions.test.ts`

The older Offline-pill and Map failures listed in `.sparring/PROJECT.md` did not
occur in this run. Its failure counts are historical, not a current waiver.
Each implementation stage must establish and compare the baseline under its
actual runtime (the repository pins Node 22), recording exact failing names and
whether the command finishes. Do not treat this Node 25 result as Node 22 proof.

## Design decisions and limits

- Keep the existing auth/capability seam. Add an explicitly named trusted-cache
  validation state to `src/auth-state.js` (proposed name:
  `AUTHENTICATED_VALIDATING`); it permits cached-shell reveal and local work,
  denies authenticated network operations, and is not terminally resolved.
- Represent backend connectivity separately as unknown/checking, reachable, or
  unreachable in a small client module, proposed new `src/connectivity-state.js`.
  A device hint starts a check; it is not backend proof. Unknown/checking has no
  Offline badge. An already confirmed offline state stays offline during retries
  until backend reachability succeeds, avoiding repeated badge flicker.
- On resume from COMPLETE, retain visible content and the existing validated
  capability while checking a loss hint. Do not promote a cached or unvalidated
  session to COMPLETE. Normal session/error handling must still revoke the
  capability when session validation fails.
- On cold boot or same-user recovery from cached state, use the new validation
  state while authentication is pending. Backend success clears Offline before
  optional header hydration, but does not independently authorize cloud work.
- Use the existing backend probe's bounded timeout (currently 3000 ms). No
  artificial delay after a definitive failed check. A failing probe includes
  transport/timeout/5xx: Offline means Sporely's backend is unavailable, not a
  claim that the device has no internet. Auth rejection takes precedence.
- Preserve the existing ownership/snapshot/account-generation checks and the
  normal account-switch, explicit sign-out, deletion, recovery and OAuth paths.
  Cache-first reveal requires a valid completed-profile snapshot and matching
  local-data owner, with no known conflicting identity or callback/recovery flow.
- No new runtime dependency, cache schema migration, persistent online flag,
  production operation, backend/schema change, service-worker redesign, or
  persistent Feed/Map cache. Cold cache-first scope is the existing Home model
  and header; resume preserves existing screen content.

## Execution and records

This plan uses the current `agent-sparring` stage-heading format. Each stage is a
bounded candidate with a fresh independent top-level sparring review. Do not use
an implementation-session reviewer as its replacement or parallel implementation
writers. Run only through the repository's configured agent-sparring workflow
after the user chooses to execute the plan.

Managed agents must not edit this input plan or manufacture engine state.
Execution position and handoffs belong to engine-owned `.sparring/plans/` and
`.sparring/stages/` artifacts. For a manually invoked implementation pass, follow
`AGENTS.md`'s canonical-plan handoff rule and stop after the selected stage.

Human checks below are genuine Android/PWA and session-lapse proof. Leave the
behavior-changing candidate uncommitted at a human gate when required by the
project workflow; the engine handles exact-candidate finalization after evidence.
No deployment or release is part of this plan.

## Stage 1 — Separate connectivity presentation from auth authority

**Goal:** Introduce and test the state model needed to reveal a trusted cached
shell without describing an untested connection as offline. Keep runtime startup
and loss behavior unchanged until the next stages wire it in.

**Scope:** `src/auth-state.js`, `src/auth-state.test.js`, `src/capabilities.js`,
`src/capabilities.test.js`; new `src/connectivity-state.js` and
`src/connectivity-state.test.js`. Small predicate/test-seam extraction from
`src/main.js` is allowed only where necessary to test the model without importing
its entire side-effect graph.

**Depends on:** none.

**Acceptance criteria:**

- Add a trusted-cache validating auth state. Cached/local work is permitted;
  every authenticated network capability remains denied with a neutral
  “Please wait…” reason. Only COMPLETE grants ordinary authenticated operations.
  The new state is nonterminal, so same-user resolution cannot dedupe it away.
- Define separate connectivity states and pure transition/display policy. Unknown
  has no Offline badge; a loss hint alone is insufficient to establish offline;
  failed backend proof establishes offline; backend success clears it; retries
  retain a previously confirmed offline display until success.
- Define stale-result ownership by account generation and check attempt identity;
  reset connectivity knowledge on sign-out/account switch rather than persisting
  it across identities or launches. Reject contradictory late results.
- Preserve all existing capability exceptions, particularly profile completion
  and the reauthentication seam. Do not use navigator/plugin connectivity as
  auth authority or broaden OAuth linking permissions.
- Write behavioral tests for the state/transition matrix and out-of-order results.
  Existing tests that assert the old enum need accurate updates; do not merely
  weaken an assertion to accept any state.
- Run `node --test src/auth-state.test.js src/capabilities.test.js src/connectivity-state.test.js`,
  then `npm test`, `npm run build`, and `git diff --check`. Record current baseline
  differences precisely. No newly activated UI behavior in this stage.

**Non-goals:** Wiring optimistic resume/cold boot, changing screen loaders,
Supabase credential handling, migrations, deployment, or global polling.

## Stage 2 — Confirm connectivity loss and recover without an offline flash

**Goal:** Keep the current screen visible on resume and treat native/browser loss
hints as requests for a backend check. Clear a confirmed Offline state as soon as
backend reachability succeeds, while session validation retains its own gate.

**Scope:** `src/main.js`, `src/native-network.js`, `src/connectivity-state.js`,
`src/screens/home.js`, `src/screens/finds.js`, `src/screens/profile.js`,
`src/reauth.js`, and `src/router.js` only where their state predicates/rendering
need integration. Tests: `src/connectivity-loss.test.js`,
`src/native-network.test.js`, `src/live-reconnect.test.js`,
`src/field-offline-ux.test.js`, `src/reauth-ux.test.js`,
`src/auth-reauth-recovery.test.js`, and the state-model tests.

**Depends on:** Stage 1.

**Acceptance criteria:**

- Native false events, native false resume status, and browser offline events
  converge on one deduped, bounded backend check. A false/true burst with a
  successful backend response never displays Offline or rebuilds Finds as offline.
- Keep COMPLETE and visible screen contents while checking a loss hint for the
  same already validated user. A failed probe transitions to CACHED behind the
  existing snapshot/owner/user gates; a known session rejection instead enters
  REAUTH_REQUIRED. Local saves remain durable and available in every state.
- For recovery from confirmed offline, retain the offline display while the
  backend probe is pending. Backend success transitions to trusted validation,
  clears Offline, and retains cached data. Cloud dispatch stays denied until
  same-user session/profile resolution succeeds. Pending state uses neutral copy,
  not “Internet connection required” or a false reauthentication notice.
- Reuse the existing single-flight/throttle/revalidation machinery and cached-only
  watchdog. Ensure a new validated loss can trigger its check promptly rather
  than being silently dropped by an unrelated recovery throttle. No COMPLETE
  poller and no probe/session pipeline per event in a burst.
- Account changes, explicit sign-out, rejection and late probes invalidate pending
  transitions. Backend success alone can never promote to COMPLETE. Preserve
  durable queued observations, upload deduplication, active scope, scroll and
  screen position during successful revalidation.
- Add executable delayed-probe and event-burst tests around real extracted seams,
  covering success, timeout, 5xx, rejection, conflicting events and identity change.
  Structural regex assertions alone are insufficient proof of these races.
- Run `node --test src/connectivity-state.test.js src/connectivity-loss.test.js src/native-network.test.js src/live-reconnect.test.js src/field-offline-ux.test.js src/reauth-ux.test.js src/auth-reauth-recovery.test.js src/sync-queue.test.js src/sync-queue-recovery.test.js`,
  then `npm test`, `npm run build`, and `git diff --check` against the current baseline.

**Non-goals:** Earlier cold-start cache reveal, new persistent caches, backend
changes, granting cloud operations from the validating state, or release work.

**Human checks:** On an Android device and a browser/PWA, reopen an already
running app after backgrounding it on a working connection: content and active
Finds scope/scroll remain visible and Offline does not flash. Turn airplane mode
on: Offline appears after the failed backend check and a capture can still be
saved locally. Turn airplane mode off: the badge clears after backend success,
queued work syncs once after session validation, and the screen stays in place.
Record platform, candidate/build, elapsed timings and observed transitions.

## Stage 3 — Reveal trusted cached Home before network validation

**Goal:** On an ordinary cold launch by a previously validated user, reveal cached
Home and header before awaiting session/backend/profile work, then refresh in place.
Use a neutral validating appearance until backend or auth evidence establishes
the final state.

**Scope:** `src/main.js` (`init()`, `_tryCachedAuthenticatedBoot()`,
`_revealTrustedCachedShell()`, `_tryCachedFallbackAfterProfileFetchFailure()`,
`_revalidateCachedRevealInPlace()`, and resolver integration), `src/screens/home.js`,
`src/auth-session.js` only if application-cache coordination needs adjustment,
`src/account-transition.js`, `src/last-validated-account.js`, and
`src/local-data-owner.js` only for minimal trust/predicate changes. Tests:
`src/startup-invariants.test.js`, `src/offline-boot.test.js`,
`src/home-cache-orchestration.test.js`, `src/profile-fetch-offline-fallback.test.js`,
`src/account-transition.test.js`, `src/last-validated-account.test.js`,
`src/local-data-owner.test.js`, `src/auth-deadlock.regression.test.js`,
`src/cached-header.test.js`, plus new executable orchestration tests if needed.

**Depends on:** Stages 1 and 2.

**Acceptance criteria:**

- Ordinary returning-user boot starts from a valid completed-profile snapshot
  matching the local-data owner. Reveal the existing cached shell in the trusted
  validating state before awaiting `getSharedAuthSession()` and remote profile or
  header work. A delayed session promise must not prevent cached Home/header paint.
- Do not optimistically reveal when trust is missing, corrupt or mismatched, or
  when a known current session belongs to another user. Handle password recovery,
  Supabase/iNaturalist/native OAuth callbacks, callback errors and consent returns
  through their existing flows. Late callback/session identity changes must clear
  the prior user's UI before any new-user reveal.
- Cache reads remain bounded and generation-guarded. A cache miss shows neutral
  loading/empty content during validation, not an offline warning or permanent
  skeleton. Failed checks can then use existing offline empty states. A late
  cache result never overwrites fresh data or another account's content.
- Same-user validation refreshes in place, with one Home network hydration and no
  account blocker/skeleton flash. Backend reachability and session validity remain
  distinct; explicit rejection shows the existing reauth experience and retains
  trusted same-user queued work. Profile-incomplete results enter setup normally.
- Do not introduce an obligatory health probe ahead of healthy session/profile
  resolution. Use successful backend operations as positive evidence where sound;
  use the bounded probe to classify failures/ambiguous results. Cache reading and
  network validation may overlap, with deterministic rendering order and no duplicate
  session/profile/refresh pipelines from INITIAL_SESSION or SIGNED_IN events.
- Preserve the Supabase auth-lock deferral discipline. Snapshot/cache persistence
  still requires successful live validation; pending work does not write a
  fabricated validation record. Explicit logout/deletion revoke cached trust.
- Behavioral orchestration tests hold session/probe promises pending and prove
  cached paint happens first, then cover successful refresh, unreachable backend,
  missing cache, hung cache read, missing session, auth rejection, profile setup,
  sign-out/account switch and out-of-order completion. Update old “probe before
  reveal” structural tests to assert the new trust-before-reveal contract.
- Run `node --test src/startup-invariants.test.js src/offline-boot.test.js src/home-cache-orchestration.test.js src/profile-fetch-offline-fallback.test.js src/account-transition.test.js src/last-validated-account.test.js src/local-data-owner.test.js src/auth-deadlock.regression.test.js src/cached-header.test.js src/auth-reauth-recovery.test.js`,
  including any new tests, then `npm test`, `npm run build`, and `git diff --check`.

**Non-goals:** Persistent Feed/Map caching, Supabase library replacement,
credential copying into snapshots, cache schema migrations, backend changes,
permissive cloud gating, production testing or release work.

**Human checks:** Force-close and cold-launch a populated Android/PWA install
online: cached Home/header appear before fresh content and Offline never flashes.
Repeat in airplane mode: cache appears first and Offline follows the failed check;
capture/save works. Relaunch after explicit logout: the previous cached account
does not return. Verify password recovery and an existing native OAuth return flow
remain usable; do not claim callback safety solely from a normal login test.

## Stage 4 — Verify prolonged inactivity, failure recovery and final contracts

**Goal:** Verify the complete user experience after hours of inactivity and close
bounded integration defects. Document the final client state/transition contract
and device evidence before considering the feature complete.

**Scope:** New `docs/evidence/2026-10-04-cache-first-connectivity.md`,
`docs/manual-qa.md`, `.sparring/PROJECT.md` for factual client-state updates,
and bounded corrections/tests in Stage 1–3 files. Extend existing debug/boot marks
in `src/main.js` or `src/debug-dashboard.js` only if needed to observe cache paint,
probe outcome, session validation and refresh without recording credentials or
personal data. No architecture expansion in this stage.

**Depends on:** Stages 1, 2 and 3.

**Acceptance criteria:**

- Establish current full-suite results with `npm test`; run `npm run build`,
  `npx eslint .`, and `git diff --check`. Distinguish reproducible baseline failures
  from regressions by exact names/output; historical baseline counts are not proof.
- Rerun affected behavioral suites after any correction, including capability,
  ownership, account-switch, auth recovery and queue tests. The independent
  top-level reviewer verifies that COMPLETE remains the ordinary cloud-operation
  authority and that neither connectivity hints nor trusted cache broaden it.
- Evidence records candidate/build, platform, cache/session conditions, steps,
  observed cache-paint/check/refresh ordering, failures and outstanding checks.
  Observe ordinary slow connectivity and backend timeout/5xx using local request
  interception where available; do not change production networking or data.
- Update project knowledge to describe the new validating state and connectivity
  policy accurately. Reconcile affected source comments/invariants; change the
  sync contract only if inspection identifies an actual contract mismatch, and
  stop/report if that requires backend or sibling work outside this plan.
- No human scenario is marked passed without actual evidence. Unresolved real
  inactivity/session-lapse checks keep the feature's final acceptance pending.

**Non-goals:** Deployment, Google Play upload, production mutations, unrelated
test repairs, new persistence, or redesigning the sync/auth backend.

**Human checks:**

1. On Android, use the app online, background it for several hours spanning an
   access-token lapse, then reopen on a working connection. Pass: existing content
   is immediately usable, Offline never flashes, session recovers, fresh data
   replaces cached sections in place, and Finds scope/scroll remain stable.
2. Force-close after the same inactivity and cold-launch online. Pass: trusted
   cached Home/header appear before validation finishes, with no Offline flash.
3. Repeat resume and cold launch with airplane mode on; save several observations.
   Pass: cache/local capture work, Offline appears only after failed backend proof,
   and queued items survive restart. Reconnect: Offline clears after backend
   success, cloud work waits for valid auth, and each item syncs once.
4. Repeat on the supported browser/PWA, including a slow connection. Pass: cached
   content stays visible during checks and a cache miss does not claim offline
   before failure is established.
5. Exercise an actually expired/unrecoverable test-account session and same-user
   reauthentication. Pass: reachable backend leads to “Sign in again,” local work
   survives, and no uploads occur before validation. Use a test account/local
   environment; do not revoke a production user's session for this check.
6. Sign out and sign in as a different test account while a delayed check/cache
   read is pending. Pass: prior account content never reappears and late results
   cannot change the new account's status or trigger its queue.
