# Reference measurement content v2 rollout

Status: approved direction (owner decisions 2026-10-01). Stage A candidate
on `feature/reference-v2-stage-a` awaiting review. Nothing deployed.

Driving case: `"Sp. 7–9.5(–10.5) × 4–5.5 µm, Qav = 1.6–2"`. `Qav 1.6–2` is a
reported **mean interval**: not Q extremes, not a typical Q range, never a
midpoint scalar. That distinction must survive on every surface (desktop, web,
landing, public API, species pages, compare tray, reference sharing).

## Owner decisions (2026-10-01)

1. **Public display: yes.** Mean intervals are shown publicly once readers
   support them, preserved exactly as a mean interval.
2. **Server-side minimum-client capability mechanism (Stage M) is mandatory**
   and must be implemented, reviewed and live before Stage D/E enable ordinary
   v2 writing/attachment. One v2 reference must never make an older client
   reject the owner's entire reference feed, and no older client may
   round-trip a v2 set into loss. It is also the foundation for later opening
   the desktop bundle-export gate. It does not block Stage A.
3. **Wording:** compact scientific display in plots/tables `Qav 1.6–2`;
   explanatory UI localized `Mean Q: 1.6–2` / `Gjennomsnittlig Q: 1,6–2`
   (sv/de equivalents), locale number formatting (decimal comma in nb/sv/de).
4. **Automatic-share version/scope gap is fixed in Stage A**, not as a
   separate emergency release. It is a hard prerequisite for Stage D.
5. The local-only/no-sync stopgap is rejected.

## Invariants

- Mean-interval semantics are fixed by the contract
  (`sporely-py` `docs/reference-data/measurement-content-contract.md` §1, §7).
  No reader re-derives or approximates them.
- **Fail closed.** A reader that cannot represent v2 rejects it or visibly
  marks it; it never silently drops it, renders it as a range/extremes, or
  invents a scalar mean.
- **Server authoritative** for what a client may write and what anon/public
  readers receive. A client-declared capability only ever *restricts* what
  the server sends or accepts for that client; it never unlocks a privilege
  the server does not independently enforce.
- No production deployment without separate explicit owner approval per stage
  (`AGENTS.md` migration safety). `20260914090000` stays deferred until Stage D.
- New migrations sort after `20261001195524` (deployed 2026-10-01).

## Verified facts

- Desktop `v0.9.23`/`v0.9.24` contain v2 snapshot reader code
  (`database/reference_citation.py` `SNAPSHOT_SCHEMA_VERSION_ENHANCED = 2`,
  `database/curated_reference_forks.py` `_SNAPSHOT_KEYS_BY_VERSION`), via
  release-branch cherry-picks. Desktops `< 0.9.23` are v1-only and reject the
  whole use-feed when one use is v2. Both desktop gates
  (`references/measurement_content_gates.py`) ship closed, so no released
  desktop writes or attaches v2.
- `20260914090000_extend_reference_snapshots_to_version_2.sql` is deferred
  (`supabase/deploy-exceptions.json`); production canonical snapshot and
  validators are v1-only.
- `private.reference_contribution_share_core` (`20261001113007`) checks scope
  (`reference_share_scope_within`) only for a `consented` refresh or a
  `grant`; a new **automatic** share (insert path) skips it. Once the
  canonical snapshot can emit v2, that path would publish v2 to anon readers
  unchecked.
- Public reads `search_public_reference_contributions(_v2)` /
  `get_public_reference_contribution(_v2)` return `envelope_json` verbatim,
  with no version awareness (finding of `8f88042`, still open).
- `sporely-landing` `src/lib/publicReferenceSnapshot.ts:116` rejects
  `schema_version !== 1` (fails closed; no v2 display).
- Sync RPCs (`sync_reference_measurement_set_unthrottled`,
  `stage_observation_reference_use_feed`, `reconcile_reference_library_feed`)
  take no client-version/capability parameter. `record_client_activity`
  (`20260723120000`) records client + app version, but desktop does not call
  it today.

## Reader/writer inventory

| Surface | Symbol | State | Change |
|---|---|---|---|
| Desktop codec/validation | `references/measurement_content.py` | v2-ready | none |
| Desktop gates | `references/measurement_content_gates.py` | both closed | Stage E (reader/attach); export gate later |
| Desktop snapshot/use-feed/curated/portable readers | `database/reference_citation.py`, `database/reference_use_sync_reconciliation.py`, `database/curated_reference_forks.py`, `utils/archive/portable_import.py` | v2-ready, released ≥ 0.9.23 | none |
| Desktop sync RPC calls | `utils/cloud_sync.py` | no capability declaration | Stage M |
| Desktop client activity | not called | missing | Stage M |
| Server canonical snapshot / validators / curated CHECK | `private.reference_canonical_snapshot`, `private.reference_snapshot_valid` | v2 only in deferred `20260914090000` | Stage D |
| Server automatic share | `private.reference_contribution_share_core` | scope gap on insert path | Stage A |
| Public anon reads | `search_public_reference_contributions(_v2)`, `get_public_reference_contribution(_v2)` | verbatim, version-unaware | Stage A |
| Sync/use-feed guard | `sync_reference_measurement_set_unthrottled`, use-feed RPCs | no client capability enforcement | Stage M |
| Web reference UI | `src/**` | not inventoried | inventory Stage A, implement Stage C |
| Landing species page / compare tray | `publicReferenceSnapshot.ts`, `sporeSummary.ts`, `compareTray.ts` | rejects v2 | Stage B |
| Landing relationship labels | PR #3 `feature/reference-relationship-labels` | unmerged, v1 | coordinate in Stage B |

## Old-client behavior

| Client | On v2 | Round-trip risk |
|---|---|---|
| Desktop `< 0.9.23` | rejects whole use-feed (visible error) | none (cannot write v2); Stage M must stop it seeing v2 at all |
| Desktop `≥ 0.9.23`, gates closed | reads v2 | cannot create/attach/export v2 |
| Desktop with reader code, never-upgraded local library | editing a set yields a legacy-only local row; push rejected (`invalid_payload`) | local copy loses the claim; Stage M must refuse non-capable writes server-side |
| Landing | rejects v2 | fails closed |
| Web | unverified | Stage A inventory |

## Public envelope policy

Public reads become version-aware. They take an explicit opt-in parameter
(e.g. `p_accept_snapshot_versions int[]`, default `{1}`). For a caller that
does not accept v2, a v2 snapshot is projected server-side to the v1 shape and
stamped `measurement_details_omitted: true`; nothing is silently dropped and
no scalar is invented. v1 snapshots are returned unchanged (no behavior change
for current production data). Landing opts in to v2 in Stage B.

## Stages

### Stage A — server: version-aware public reads and automatic-share scope gap

- Repo `sporely-web`; new additive migration.
- Scope:
  1. Version-aware `search_public_reference_contributions(_v2)` /
     `get_public_reference_contribution(_v2)` with the opt-in parameter and
     the v2→v1 projection + `measurement_details_omitted` marker. Signatures
     stay backward compatible for current callers (landing).
  2. Automatic-share insert path in `reference_contribution_share_core`
     enforces the same snapshot-version/scope check as `consented`/`grant`;
     until Stage D, automatic shares are limited to v1.
  3. Read-only inventory of web `src/` readers of reference snapshots /
     measurement content, recorded in this plan for Stage C.
- Tests: SQL tests for both read families (v1 unchanged, v2 projected +
  marker, v2 returned to opt-in caller) and for the automatic-share check,
  with an enhanced fixture forced through the new-share path. Prove each test
  fails on the pre-stage definitions.
- Review: general + security.
- Prod approval: yes (no visible v1 behavior change).
- Rollback: rollback script restoring prior definitions.
- Exit: no public read returns an unmarked v2 envelope to a non-opted-in
  caller; automatic shares are version/scope checked.

### Stage M — server-side minimum-client capability

- Repos `sporely-web` (migration + web calls) and `sporely-py` (declaration).
- Declaration: explicit `p_client_capabilities jsonb` (e.g.
  `{"reference_snapshot_versions":[1,2]}`) on the reference sync and
  use-feed/reconcile RPCs. Omitted ⇒ v1-only (how every existing client calls
  them today). Added as overloads/defaults so old clients keep working.
- Feeds for non-capable clients: v2 items are never sent. Whether they appear
  as a placeholder (`requires_newer_sporely`) or are omitted is decided by
  testing the actual `< 0.9.23` and `0.9.23/0.9.24` feed parsers; the feed as
  a whole must never fail. The server returns a count of withheld items so a
  capable UI can explain them.
- Writes: a non-capable client's write/update to an enhanced set is refused
  with a distinct status (`requires_newer_client`); never downgraded for
  writeback.
- Creation guard: creating new v2 content is refused while the owner has
  another device active within a window (proposed 30 days) whose last
  reported version is not capable, using `record_client_activity`. Requires
  desktop to call `record_client_activity`; included in this stage.
- Desktop UI: notice "N references need a newer Sporely to view or edit",
  driven by the withheld count and `requires_newer_client`.
- Web declares `[1,2]` once Stage C ships. Landing uses Stage A public reads.
- Foundation for the bundle-export gate: the same capability model must later
  cover bundle import/export before `MINIMUM_SUPPORTED_DESKTOP_VERSION_GATE_OPEN`
  flips (separate stage).
- Tests: declared/undeclared capability, feed behavior against real old-parser
  fixtures, write refusal, creation guard.
- Review: general + security (trust boundary). Prod approval: yes.
- Dependencies: Stage A. Rollback: additive; rollback script.

### Stage B — landing: v2 display and wording

- Repo `sporely-landing`. Accept v2 and the omitted marker; render `Qav 1.6–2`
  (compact) and `Mean Q: 1.6–2` / locale equivalents (explanatory), never as a
  range/extremes; show the marker visibly. Coordinate with PR #3.
- Tests: normalization (v1, v2, v2+marker, malformed), locale formatting.
- Review: general. Prod approval: yes (landing deploy). Depends on Stage A.

### Stage C — web: reference UI readers

- Repo `sporely-web` (client). Implement v2 display on the surfaces from the
  Stage A inventory; declare capability per Stage M.
- Review: general. Prod approval: yes (web deploy). Depends on A, M.
- Stage A inventory (2026-10-01, read-only, `src/**` excluding tests, base
  `8afc74f`): web has **no reader of reference snapshots, measurement
  content or `envelope_json`**.
  - `src/shared-references.js` (rendered by `src/screens/profile.js`): owner
    list via `list_my_reference_sharing` and the owner RPCs
    `stop_sharing_reference_set` / `share_reference_set_again`. Renders
    status, revision, dates, `canonical_scientific_name`,
    `source_short_label`, `source_raw_text` and the public observation count;
    no snapshot, `measurements`, `measurement_details` or `schema_version`.
    v2-safe as is (raw text is the source's own text).
  - No call to `search_public_reference_contributions(_v2)`,
    `get_public_reference_contribution(_v2)`,
    `search/get_public_observation_references`, the reference sync RPCs, or
    any `reference_*` / `observation_reference_uses` table.
  - `src/screens/find_detail.js` spore summaries
    (`observation_spore_summaries`, `get_public_observation_spore_summaries`)
    are the observation's own measurements, not references.
  - Consequence: Stage C has no display surface to change today. It reduces
    to (a) the Stage M capability declaration, only if web ever calls a
    reference sync/use-feed RPC, and (b) any future web reference UI must
    call the public reads with `p_accept_snapshot_versions => '{1,2}'` only
    once it renders mean intervals per the wording decision.

### Stage D — deploy the deferred migration

- Apply `20260914090000` through `scripts/supabase-deploy-tree.mjs` and remove
  it from `supabase/deploy-exceptions.json` in the same commit, per
  `docs/deployments/2026-09-25-migration-order-exception.md`. Widen the
  automatic-share version allowance to v2 here (or in a companion migration).
- Tests: `reference_snapshot_v2_test.sql`,
  `reference_measurement_content_extension_test.sql`, replay dry run.
- Review: general + security. Prod approval: yes, explicit.
- Depends on: Stage A live, Stage M live, B and C deployed.
- Rollback: tested rollback in the deploy-tree flow (highest-risk stage).

### Stage E — desktop gate flip

- Repo `sporely-py`. Flip `MINIMUM_SUPPORTED_READER_VERSION_GATE_OPEN = True`
  in a new desktop release (which also carries the Stage M declaration).
  `MINIMUM_SUPPORTED_DESKTOP_VERSION_GATE_OPEN` stays closed until the
  capability model covers bundle import/export.
- Tests: activation-gate fixtures (contract §12 item 19); full manual test.
- Review: general. Depends on A, M, D live and B/C deployed.
- Rollback: revert the flag; no persisted content is rewritten.

## Gate-flip conditions

- Stage M live before Stage D (decision 2).
- Stage A scope fix live before Stage D (decision 4).
- Desktop reader/attach gate flips only after A, M, D are live and B/C deployed.
- Bundle-export gate: separate later stage on top of Stage M.

## End-to-end manual test (Qav)

1. Desktop (gate open): enter the source text; `metrics.q.mean_interval =
   {1.6, 2}`, `q_mean` NULL, no Q bounds set from it.
2. Attach to a public observation; sync to a second capable desktop and back;
   no loss.
3. Simulated non-capable client: v2 item withheld (feed still loads), write
   refused with `requires_newer_client`.
4. Before Stage D: automatic share does not publish v2.
5. After Stage D: anon read returns the mean interval to opted-in callers and
   the v1 projection + marker to others.
6. Landing species page and compare tray: `Qav 1.6–2` / `Mean Q: 1.6–2`
   (`Gjennomsnittlig Q: 1,6–2` in nb), never a Q range or extremes.

## Open questions

- Recently-active window (30 days proposed) and whether support can override it.
- Placeholder vs omission for withheld feed items (decided by parser tests in M).
- Whether any client outside these three repos calls the sync RPCs.
- Supported-desktop-version floor policy (contract §6).
- Timing of the bundle-export gate stage.

## Handoff

- 2026-10-01: plan written; Stage A started on `feature/reference-v2-stage-a`.
- 2026-10-01: Stage A candidate (implementation claim, not acceptance).
  Branch `feature/reference-v2-stage-a`, base `8afc74f` (origin/main), plan
  commit `422997a`, inventory `6d111c2`, migration `4bb24b5`.
  - Migration `supabase/migrations/20261001213000_version_aware_public_reference_reads.sql`;
    rollback `supabase/rollbacks/20261001213000_rollback.sql`. Not deployed;
    `20260914090000` untouched and still deferred.
  - Overloads: the four public reads (`search/get_public_reference_contribution_v2`,
    `search/get_public_observation_references`) are DROPped and recreated with
    a trailing `p_accept_snapshot_versions integer[] DEFAULT '{1}'`; one
    function per name, so landing's named-argument calls resolve unchanged.
    NULL = default; otherwise a subset of {1,2} containing 1, else 22023.
    Private `_unthrottled` reads, rate limit, page policy, byte cap, owner,
    SECURITY DEFINER, `search_path=''` and grants unchanged (fingerprint
    checked).
  - Projection (v2 -> v1, non-accepting caller): drop `measurement_details`
    and `measurements.q_core_min/q_core_max`; `schema_version` 1; every
    other value as stored (`q_mean` stays NULL for a mean interval; Q core
    never folded into `q_min/q_max`); a length/width core pair tagged
    `percentile_interval` is nulled. Item stamped
    `measurement_details_omitted: true` at envelope/item level (snapshot
    keeps the exact v1 key set). Unknown versions are not served to that
    caller. Note: landing's exact-key normalizers drop a marked item today
    (fails closed); Stage B must accept the marker.
  - Automatic share: `reference_contribution_share_core` binds every
    automatic outcome (new share, re-share, new revision of an automatic
    row) to `private.reference_automatic_share_scope()` (v1 only); out of
    scope it writes nothing and returns `snapshot_version_unsupported`.
    Triggers and Share again ignore it; Stage 1B records
    `not_shareable:snapshot_version_unsupported`; the 2d deploy refresh
    ignores statuses. Consented refresh and grant unchanged.
  - Tests (local `supabase db reset` only): new
    `supabase/tests/reference_snapshot_version_public_reads_test.sql` passes;
    on the pre-stage definitions (reset without `20261001213000`) all 9
    blocks fail (A1-A4, F on sharing v2; B, C1 cascade from the automatic
    share; C2, D, E undefined opt-in signature).
    `supabase/tests/reference_snapshot_version_rollback_test.sh` passes:
    rollback state fingerprint equals a pre-stage reset exactly, forward
    re-apply identical. Existing SQL tests pass (public_observation_references,
    reference_measurement_content_extension, reference_snapshot_v2,
    shared_reference_{backfill,consent_grant,consent_data_step,default_on,roles,contributions,production_policy},
    taxon_identity_repair{,_label}); `shared_reference_rollback_test.sh`,
    `shared_reference_consent_concurrency_test.sh`,
    `taxon_identity_repair_concurrency_test.sh` pass. Two tests' privilege
    checks updated to the new signatures.
    `shared_reference_backfill_migration_test.sh` fails ("migration not
    applied") independently of Stage A: it pins max version
    `20261001113007` after `migration up`, already false at base since
    `20261001195524`.
  - `supabase migration list` not run: the worktree is not linked (no
    production access attempted).
  - Open: (1) an automatic row whose source becomes v2 keeps serving its
    last v1 revision (stale) rather than being withdrawn; withdrawal would
    need a new reason. (2) Percentile-core nulling is a policy choice beyond
    the brief; confirm. (3) Curated public reads
    (`reference_curated_public_envelope`) not made version-aware: curation
    still publishes v1 only. (4) Rolling back 2d after A drops the new
    Stage 1B status (unreachable then).
