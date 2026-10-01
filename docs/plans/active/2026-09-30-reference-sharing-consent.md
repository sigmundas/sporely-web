# Stage 2: consent and visibility for shared reference data

> **Superseded in part (2026-10-01):** the owner replaced opt-in sharing with default-on sharing and a sticky per-reference Stop sharing. See `docs/plans/active/2026-10-01-reference-sharing-default-on.md`. The consent texts, the consent dialog, the activation gate and the content proof described here no longer apply. Roles, labels and the `_v2` version gate (Stage 2c) remain.


Status: decided 2026-10-01. Revised after independent security review and
general review of `ebb9416` (both "needs changes"; incorporated). Not
started. Order: re-review of this revision, then 2a (implement, review,
security review, deploy, verify fail-closed), then 2b as a separately
reviewed step.

**2a candidate (2026-10-01, not accepted, not deployed):** branch
`feature/reference-sharing-consent-2a`, migration
`20260930224506_fail_closed_reference_sharing_consent.sql`. Awaiting
general and security review; the production preflight (exactly 2
unconsented shared rows) and deploy need explicit authorization. Landing
null-contributor test on sporely-landing `feature/reference-sharing-consent-2a`.

**2b server+web candidate (2026-10-01, not accepted, not deployed):** branch
`feature/reference-sharing-consent-2b-server`, migration
`20260930232633_add_reference_sharing_consent_grant.sql`: grant, owner list
and consent-text RPCs; consent text v1 en/nb shipped **inactive** (owner must
approve the wording, then activate in a separate step); the 2a review lows;
web "My shared references" in the profile overlay. Decisions recorded here:
- `consent_scope` is taken from the **granted snapshot** (within the text's
  scope), so a later revision with a new data kind or schema version
  withdraws with `consent_scope_exceeded`;
- the observation `AFTER DELETE` trigger from 2a is **dropped**: deleting an
  observation cascades to its uses, and the use trigger withdraws
  (`use_detached`);
- rows record `consent_locale`; the postgres-only
  `private.revoke_reference_share_consent_text(version, locale)` revokes a
  text and withdraws its rows (`consent_text_revoked`), and refresh withdraws
  rows whose text is revoked.
Desktop (sporely-py) is a separate
later candidate, including the allowlist and
`test_stage6l_cross_repository_contract.py`.

## Owner decisions (2026-10-01)

- **A.** Withdraw both existing unconsented contributions in Stage 2a.
- **B.** Only **public, non-draft** observations may back a public reference
  share. Private, friends-only and draft observations are ineligible, even
  with explicit opt-in. Revisit separately later if needed.
- **C.** Once shared, later revisions may publish automatically during the
  same consent period, while they stay within the scope the consent text
  described. A materially changed scope requires new consent.
- **D.** Web gets "My shared references" and Stop sharing only. No reference
  creation or editing on web in this stage.
- **E.** Public observation reference data is shown only when backed by a
  currently consented contribution. Withdrawal removes that exposure too.
- **F.** Remove raw account ids from new public envelopes. Account linkage
  stays private and server-side. Stage 2 of
`docs/plans/active/2026-09-30-reference-share-eligibility.md`. Stage 3
(widening eligibility) is out of scope.

## Goal

Reference data (citation, measurement points, attribution) becomes public
only after its owner explicitly opts in, and stops being public when they
stop sharing.
- **Enforced everywhere:** the server enforces this on every path, including
  old clients.
- **No automatic sharing from private or drafts:** private and draft
  observations never publish reference data automatically.
- **Observation visibility is not consent:** a public observation is not
  consent either.
- **Eligibility unchanged:** it stays at the current registry species. 617026
  and 55368 stay private.

## Two public surfaces, both without consent today

**1. Shared contributions**
(`supabase/migrations/20260830183210_add_shared_reference_contributions.sql`,
cited as `:N`).
- **How they're read:** by anyone, signed in or not, through
  `search_public_reference_contributions` and
  `get_public_reference_contribution`, now `*_unthrottled` behind rate-limit
  wrappers (`20260830193144_configure_shared_reference_production_policy.sql:170-176`).
- **Consumers:** the landing site's species pages
  (`sporely-landing/src/lib/publicApi.ts:1214,1232`) and the desktop catalogue
  and fork dialog (`sporely-py/database/curated_reference_forks.py:445`).
- **Envelope contents:**
  - `contributor.id`, the **raw auth user id** (`:173-176`), plus the
    username label;
  - the full citation and exports;
  - the measurement set, with projected raw points;
  - the species.
- **Every revision number is served while the row is `shared`**
  (`:622-652`).

**2. Observation references**
(`20260828172243_…:118-202`). `search_public_observation_references` and
`get_public_observation_references` return each use's `snapshot_json`
(citation and measurement data) for every **public, non-draft observation**.
No contribution and no consent is involved. This is "public observation
equals consent", which the owner ruled out.

### Paths that create, re-share or expose

| Path | Where | Owner action today? |
|---|---|---|
| Reference-use sync trigger | `:937-940` → `:892-935` → `refresh_shared_reference_for_use_row` `:782-823` → `share_reference_contribution_for_owner` `:190-411` | no |
| Source-edit triggers (set `:726`, treatment and work `:751`) | revision bump publishes a new revision | no |
| Taxon trigger | `:825-889`, `:954-956` | no |
| Stage 1B reconcile | `20260930213813:74-147` (raises on unknown statuses) | operator |
| Historical backfill | `20260831150330` (ran once; function dropped) | no |
| Explicit RPC | `share_reference_contribution_unthrottled`; desktop wrapper `cloud_sync.py:16461`, called by no UI | none exists |
| Observation references | `20260828172243:118-202` | no (public observation) |
| Curation submission | separate workflow with its own explicit rights confirmation (`20260829145939:1057-1059`) | yes, unchanged |

More gaps in today's code:
- **Reactivation:** re-sharing clears `withdrawn_at` (`:382-387`), so
  withdrawal is undone by the next sync or edit.
- **Owner-only withdrawal:** the use trigger returns early unless
  `auth.uid()` is the owner (`:908-910`), so service-role detaches and
  cascade deletes never withdraw.
- **Draft changes:** no trigger watches `observations.is_draft`, `visibility`
  or observation deletion.
- **Locking:** no path but the share core takes the advisory lock
  (`:229-232`), and the qualifying-use read (`:249-260`) doesn't lock uses or
  observations.
- **Moderation:** hiding an observation (`supabase/functions/admin-ops/adminActions.ts:444-451`)
  doesn't hide the contributions it backs.
- **No owner UI:** withdrawal exists but no client calls it. The web app has
  no reference features; only the desktop creates reference uses.

## Design

### Consent record

- **Unit:** consent covers one key, `(owner_id, source_measurement_set_id,
  sporely_taxon_id)`, the key contributions already use.
- **New columns** on `private.shared_reference_contributions`:
  - `consented_at`, `consent_version`, `consent_client` (the client is
    informational and not trusted);
  - `consent_first_revision`, the first revision of the current consent
    period.
- **CHECKs:**
  - `(status = 'shared') = (consented_at IS NOT NULL)`, both directions: a
    withdrawn row can't keep consent, and a shared row can't lack it;
  - `consented_at`, `consent_version`, `consent_first_revision` and
    `consent_scope` are all set or all NULL.
- **`consent_scope`** (jsonb): recorded at grant from the granted snapshot (2b). It holds the snapshot schema
  version and data kinds the consent covered, and must fit within the consent
  text version's `scope`.
- **Withdrawal** clears all five, and only through the single withdrawal
  helper (see "2a specification"). History lives in the event log.
- **Event log:** `private.shared_reference_consent_events`, append-only,
  postgres-only. It records the contribution id, event (`granted`,
  `withdrawn_by_owner`, `withdrawn_by_system`), reason, consent version and
  time, and for `granted` also locale and `text_sha256`. **No `owner_id`**, so
  account deletion leaves nothing to scrub. The anonymise trigger
  (`:516-540`) records a system event.
- **Consent texts:** `private.reference_share_consent_texts` (`version`,
  `locale`, `text`, `text_sha256`, `active`, `revoked`, and `scope` jsonb: the
  snapshot schema versions and data kinds that version discloses). The text
  lists:
  - what becomes public;
  - that edits publish new revisions within the limits below;
  - what stopping sharing cannot undo;
  - the private-observation warning;
  - a rights confirmation, as in curation;
  - that copies other users make become their own sets, which they can share
    under their own name.

### Public reads serve only consented data

- **Contributions:** both reads serve only rows with `status = 'shared' AND
  consented_at IS NOT NULL`, and only revisions `>= consent_first_revision`.
  Revisions from before a withdrawal, including revision 1 of today's two
  unconsented rows, are never served again, even after the owner shares
  again.
  - **Stub, unchanged:** for a withdrawn row asked for an explicit existing
    revision, `get_public_reference_contribution` keeps returning today's
    `{contribution_id, revision, status: 'withdrawn', withdrawn_at}` stub
    (`:628-640`). The landing site and desktop depend on it
    (`sporely-landing/src/lib/publicCuratedReferences.ts:329-348,385`). It
    carries no account data.
  - **Pre-consent revision of a shared row:** returns no row, as for an
    unknown revision.
- **Observation references (decision E):** `search_public_observation_references`
  keeps its output shape exactly (`use_id`, `role`, `reference_revision`,
  `snapshot`, with `snapshot.reference_revision = reference_revision`). The
  landing site requires this (`sporely-landing/src/lib/publicApi.ts:181-201`,
  `publicReferenceSnapshot.ts:116`). It keeps serving the use's **frozen**
  snapshot, which is the evidence recorded at use time. A use is included
  only when all of these hold:
  - **the use itself qualifies:** it passes the per-use conditions of
    `reference_set_has_qualifying_use`. Its observation is public, not a
    draft, has public `spore_data_visibility`, and has the contribution's
    exact effective taxon. It is not enough that some other observation keeps
    the contribution backed;
  - a contribution for `(owner, set, that taxon)` has `status = 'shared'`,
    consent set and `hidden_at IS NULL`;
  - the owner isn't banned or in `reference_account_deletions`, and isn't
    blocked with the caller (the same filter as the contribution reads);
  - **content proof:** the use's publicly projected snapshot
    (`public_reference_snapshot` of its `snapshot_json`) equals the snapshot
    inside some revision of that contribution numbered
    `>= consent_first_revision`, after removing the four identity keys that
    the envelope rewrites from **both** sides: `reference_work_id`,
    `reference_treatment_id`, `reference_measurement_set_id` and
    `reference_revision`. The envelope replaces the first three with
    contribution-derived v5 ids and the last with the contribution revision
    (`20260830183210:145-157`). The comparison uses jsonb `=`, the same rule
    as the `current`-mode check (`20260828143513:784`), never text or a hash,
    so `5.5` and `5.50` compare equal. The removed ids are implied by the
    (owner, set) join. Strip the keys **after** projecting:
    `public_reference_snapshot(u.snapshot_json, u.reference_measurement_set_id,
    u.reference_revision)` returns NULL unless the embedded set id and revision
    match the use's own columns (`reference_snapshot_valid`), which is what
    binds the proof to that set.

  The revision number alone proves nothing. `reference_revision` is only the
  measurement set's revision (`20260828143513:378`), so citation and
  treatment edits don't move it. And the desktop's historical-import push
  accepts any valid snapshot without comparing it with the source
  (`20260828143513:785`). Content equality proves that exactly this content
  was consented. That also means it lies within `consent_scope`, since every
  consented revision passed the scope check.

  Everything else is omitted, and withdrawal therefore removes it.
  `get_public_observation_references` is a wrapper and needs no change.
- **Contributor:** new revisions set `contributor.id` to NULL and keep only
  the label. Both clients already accept a NULL id
  (`curated_reference_forks.py:328-332`,
  `sporely-landing/src/lib/publicCuratedReferences.ts:87`). See decision F.

### Granting

- **Structure:** a private core function takes a mode (`grant`/`refresh`).
  The existing 6-argument `share_reference_contribution_for_owner` stays as a
  wrapper that calls it in `refresh` mode, so every existing caller (listed
  below) keeps its signature. Only `grant` may create a row, set consent, or
  move a withdrawn row back to `shared` (which starts a new consent period).
- **New owner RPC:** `public.share_reference_contribution_with_consent(set_id,
  taxon_id, expected revisions…, consent_version, locale)`, rate-limited via
  `consume_shared_reference_request`, granted to `authenticated`, owner from
  `auth.uid()`. Checks, all under the locks below:
  - the source revisions match what the client displayed;
  - the consent version is active;
  - the species is in the registry;
  - there is at least one live use on a **qualifying** observation of that
    exact taxon (decision B);
  - the account isn't banned or deleted;
  - `hidden_at` is never cleared.
- **The old RPC:** `share_reference_contribution_unthrottled` returns
  `consent_required` and changes nothing.
- **Read RPCs:**
  - `public.list_my_shared_reference_contributions()`, owner-only,
    rate-limited, with status, species, current revision and dates;
  - `public.get_reference_share_consent_text(locale)`, which returns the
    active text.

  Add all new RPCs to the desktop allowlist (`cloud_sync.py:2236-2240`) and to
  `test_stage6l_cross_repository_contract.py`.

### Automatic paths: refresh or withdraw, never publish anew

- **Use, source and taxon triggers, and Stage 1B:** call `refresh` only. It
  may add a revision to a row that is `shared` and consented, within the
  revision limits below. Otherwise it does nothing or withdraws.
- **Stage 1B reconcile:** changes in the same migration to record
  `consent_required` rather than raising.
- **Revision limits (decision C):** an automatic revision is published only
  within the row's stored `consent_scope` (see "Consent-scope check").
  Otherwise the row is withdrawn with `consent_scope_exceeded`, and the owner
  must opt in again. This covers the pending v2 snapshots in
  `20260914090000`.
- **Withdrawal on losing the qualifying use**, whoever makes the change:
  - A new `private.withdraw_unqualified_contributions(owner, set)` withdraws
    a shared row that has no qualifying use left and records a system event.
  - Called from the use trigger (all callers, including service role and
    cascade deletes, so an observation delete is covered by its cascaded use
    deletes), from a new trigger `AFTER UPDATE OF is_draft, visibility,
    spore_data_visibility` on `public.observations` (2a also added an
    `AFTER DELETE` trigger; 2b dropped it as redundant), and from the source triggers on a `deleted_at`
    change of the set, treatment or work (see "Source deletion").
  - Moderation hide (`admin-ops/adminActions.ts:444-451`) sets
    `visibility = 'private'`. Under decision B a private observation doesn't
    qualify, so the visibility trigger withdraws what it backs. The event
    reason is `observation_not_public` whoever made the change. A test covers
    the service-role update the admin action performs.
  - Never rate-limited, never inside an error-swallowing block. Today
    `refresh_shared_reference_for_use_row` wraps the share call in `EXCEPTION
    WHEN OTHERS` (`:811-818`). In 2a only the **publish** part (adding a
    revision) may stay best-effort. Withdrawal decisions and the helper run
    outside that block, so a failure there aborts the transaction instead of
    leaving a share public.
- **Locking:**
  - **The key:** every path that grants, refreshes or withdraws takes one
    transaction advisory lock per `(owner_id, source_measurement_set_id)`.
    This changes today's owner+set+taxon key (`:229-232`). When a path covers
    several sets, it locks them in sorted set-id order.
  - **Order in AFTER triggers:** there, the row locks are already held, so
    the advisory lock comes after them.
  - **Deciding:** each path decides by re-reading uses and observations under
    READ COMMITTED **after** taking the advisory lock, with no `FOR SHARE`.
    `FOR SHARE` would deadlock against concurrent use and visibility updates.
  - **No source row locks after the advisory lock.** Today the core takes
    `FOR SHARE` on the set, treatment and work rows after its advisory lock
    (`20260830183210:266-283`). A source edit already holds that row when its
    trigger waits for the advisory lock, so they deadlock. The 2a core reads
    source rows without row locks.
    - In **refresh** mode it ignores caller-supplied revisions. It reads the
      current revisions itself **after** taking the advisory lock and
      publishes those, so concurrent edits of a treatment, work or shared
      treatment can't lose a revision.
    - Only **grant** mode (2b) compares with the revisions the client
      displayed, and returns `revision_mismatch` on a difference.
    - The snapshot, the recorded source revisions and the bounds come from
      **one read**, since edits can still commit between unlocked
      statements. The scope check runs on the **final** snapshot, after
      `raw_points` is projected into it.
  - **Multiple sets:** deleting or editing a treatment or work that several
    sets use takes their advisory locks in sorted set-id order.
  - **Withdraw RPC order:** read the contribution's owner and set without a
    lock, check ownership, take the advisory lock, then lock the row and check
    again. That fixes today's row-lock-first order (`:450-451`).
  - **Coverage:** the use, observation, source and taxon triggers, Stage 1B,
    grant, the owner withdraw RPC and anonymise.

### Visibility (decision B)

A qualifying use is a live use of a **live** source set (set, treatment and
work not deleted) on an observation with `visibility = 'public'` and
`spore_data_visibility = 'public'`, not a draft, not deleted, whose exact
effective taxon is the contribution's taxon.
- **Ineligible:** private, `friends` and draft observations, even with
  explicit opt-in.
- **Losing eligibility:** an observation leaving `public`, its spore data
  leaving `public`, or it becoming a draft withdraws the contributions it
  alone backed.
- **Source deletion:** deleting the source set, treatment or work
  withdraws, for **every caller**. Today two things prevent that:
  - The source triggers fire only on `AFTER UPDATE OF revision`
    (`:942-952`), so a service-role update that sets only `deleted_at` never
    fires them. The owner's upsert RPCs always set `revision`, but service
    role has `GRANT ALL` (`20260828143513:219-221`). 2a recreates the three
    triggers as `AFTER UPDATE OF revision, deleted_at`.
  - Their early return (`:736-740`, `:760-761`) is one `IF` with three
    conditions: no signed-in user, a signed-in user who isn't the owner, and
    `deleted_at` set. The deletion branch is gated by none of them.
- **The consent text still says** that the share shows, under the owner's
  label, that they identified this species. The observation is public, so
  this adds little.

### Owner UI

- **Desktop (`sporely-py`):**
  - "Share publicly…" on an attached reference set, with the consent dialog
    showing the server text;
  - "My shared references" with Stop sharing.

  Sync is unchanged: it never calls share.
- **Web (`src/`):** "My shared references" with Stop sharing (decision D).
- **Stop sharing:** calls `withdraw_reference_contribution`. The UI and
  consent text say what stopping cannot undo:
  - copies other users already made (`curated_reference_forks.py:540-620`);
  - retained private revision rows;
  - anything cached by third parties.

## Existing data

Production, read-only, 2026-09-30:
- **Contributions:** 2 shared contributions from 1 owner under taxon 34615,
  shared 2026-09-06, 1 revision each, not hidden.
- **Carrying observations:** one public and one **public but draft**.
- **Copies:** no other user's use or set mentions either id.

**Decided: withdraw both** (decision A). In the Stage 2a migration, in
one transaction:
1. `LOCK TABLE`;
2. replace the functions;
3. call `withdraw_shared_reference_contribution(id, 'consent_missing')` for
   every row `WHERE status = 'shared' AND consented_at IS NULL`;
4. add the CHECKs.

The migration is count-agnostic, so local and CI resets work. The production
preflight asserts exactly 2 before the push. This withdraws; it publishes
nothing. With the revision rule above, re-sharing later never re-exposes
revision 1. The deploy is a production data write and needs explicit
authorization at deploy time.

## 2a specification

### One qualifying-use predicate

`private.reference_set_has_qualifying_use(owner, set, taxon)` is true when all
of these hold for some use:
- the use is live (`deleted_at IS NULL`);
- it is the owner's own use of that set, and the set, its treatment and its
  work are not deleted;
- its observation is `visibility = 'public'`, not a draft, and has
  `spore_data_visibility = 'public'` (see below);
- the observation's effective taxon equals `taxon`.

Every place that decides "is this contribution still backed?" calls it,
including the existing "kept by another use" checks in the taxon trigger
(`:854-866`) and in Stage 1B's old-taxon branch (`20260930213813:65-74`).
Today those checks ignore visibility and drafts.

The `spore_data_visibility` rule is a conservative addition to decision B. The
owner may relax it. Moderation sets it to private (`adminActions.ts:444-447`),
and reference measurements sit next to the observation's spore data.

### One withdrawal helper

`private.withdraw_shared_reference_contribution(contribution_id, reason)` is
the only statement that sets `status = 'withdrawn'`. It clears the consent
columns, sets `withdrawn_at` and writes the event. The migration routes every
existing withdrawal through it:
- the use trigger (`:916`; the older body at `:697` is replaced later in the
  same file and is dead);
- the taxon trigger (`:874`);
- Stage 1B's old-taxon branch (`20260930213813:77-83`);
- anonymise (`:533`);
- the owner withdraw RPC;
- the data step;
- `private.withdraw_unqualified_contributions(owner, set)`.

Reasons: `owner`, `consent_missing`, `observation_not_public`,
`use_detached`, `source_deleted`, `taxon_changed`, `consent_scope_exceeded`,
`consent_text_revoked`, `account_deleted`.

The helper does nothing, and writes no event, when the row is already
withdrawn. `consent_text_revoked` withdrawals are a reviewed operator step
belonging to 2b, where consent texts first become active.

### Refresh result statuses

These are returned by the core in `refresh` mode, and Stage 1B maps each one:
- `updated`, `no_change`: a consented shared row was refreshed. Stage 1B
  records `shared`.
- `consent_required`: no consented shared row for the key. Stage 1B records
  `consent_required`.
- `consent_scope_exceeded`: the new snapshot falls outside `consent_scope`,
  and the row was withdrawn. Stage 1B records it.
- `withdrawn_unqualified`: no qualifying use remains, and the row was
  withdrawn. Stage 1B records it.
- `revision_mismatch`: grant mode only (2b). Refresh mode never returns it,
  because it reads revisions after the lock.
- `source_not_found_or_stale`: the source set, treatment or work is missing
  or deleted when refresh runs. The core withdraws with `source_deleted`
  first. Stage 1B records its own `source_deleted` label.
- `invalid_taxon`, `account_unavailable`, `source_out_of_bounds`: unchanged
  meanings. Stage 1B keeps today's labels: `not_registry_species` or
  `not_species` for `invalid_taxon` (Stage 1), and
  `not_shareable:<status>` for the other two (`20260930213813:141-143`).
  `source_deleted` stays a Stage 1B label for a deleted source, found before
  it calls the core; the core never returns it.
- Anything else raises, as today (`20260930213813:136-146`).

### Consent-scope check (decision C)

An automatic revision is compared with the row's `consent_scope`: the
snapshot's schema version, and the set of data kinds present (raw points,
free-text fields, measurement details). If either is outside that scope, the
row is withdrawn with `consent_scope_exceeded`. Before 2b, no row can be
consented, so in 2a this is reachable only through test fixtures that insert
a consented row. The test lives in 2a.

### What the 2a migration creates and replaces

**Creates:**
- the consent columns and CHECKs, `consent_scope`, the events table and the
  texts table (no active version yet);
- the grant/refresh core (grant mode not exposed until 2b);
- `reference_set_has_qualifying_use`, `withdraw_shared_reference_contribution`
  and `withdraw_unqualified_contributions`;
- the observation trigger function, with an `AFTER UPDATE OF is_draft,
  visibility, spore_data_visibility` trigger on `public.observations` (2a's
  `AFTER DELETE` trigger was dropped in 2b; the cascaded use delete covers
  it).

**Replaces:**
- the 6-argument `share_reference_contribution_for_owner`, as a refresh
  wrapper;
- `share_reference_contribution_unthrottled`, which returns
  `consent_required`;
- `withdraw_reference_contribution_unthrottled`;
- `search_public_reference_contributions_unthrottled` and
  `get_public_reference_contribution_unthrottled`;
- `shared_reference_contribution_envelope`, to set `contributor.id` NULL;
- `search_public_observation_references`;
- `refresh_shared_reference_for_use` and `refresh_shared_reference_for_use_row`;
- `refresh_shared_references_for_observation_taxon`;
- the two source-edit trigger functions: the lock key, a deletion branch
  that withdraws for every caller, and no early return before that branch.
  The three triggers are recreated as `AFTER UPDATE OF revision, deleted_at`;
- `_taxon_identity_repair_reconcile_references`;
- `anonymize_shared_reference_contributions_for_profile`.

**Must not replace:** the functions the hash-pinned deferred migration
`20260914090000` redefines, or its later release would silently overwrite
them:
- `reference_measurement_details_valid`;
- `reference_snapshot_valid`;
- `reference_canonical_snapshot`;
- `public_reference_snapshot`;
- `reference_curated_public_envelope`;
- `reference_curation_capture_candidate`.

2a calls them, never redefines them. `moderate_shared_reference_contribution`
is unchanged. Every new private function gets `REVOKE ALL … FROM PUBLIC, anon,
authenticated, service_role`, `search_path = ''`, and is owned by postgres.

## Implementation stages

**2a: fail closed (server only).** Everything above except granting:
- the consent columns, CHECKs, event log and texts table;
- the reads restricted to consented data;
- observation references gated;
- contributor id NULL in new revisions;
- all automatic paths refresh-only or withdraw;
- withdrawal triggers and locking;
- the old RPC returns `consent_required`;
- the existing rows withdrawn.

After 2a nothing becomes public, and old clients keep syncing.

**2b: opt-in.** The grant RPC, the list and consent-text RPCs, the desktop
dialog and list, and the web list. Ships after 2a is deployed and verified.
The desktop release that calls the new RPCs must not ship before the server
has them.

Each is its own candidate, reviewed and security-reviewed, deployed via
`scripts/supabase-deploy-tree.mjs`.

**Rollback:** never revert to the pre-2a bodies, since they re-share on the
next sync. Rolling back 2b drops or disables the grant RPC and the client
features and keeps 2a, so sharing is off. If a consent text version proves
faulty, mark it `revoked`: every row consented under it is withdrawn with
`consent_text_revoked`. Rolling back 2a means a new
migration that keeps the consent gate and the reads restricted. Columns and
tables are inert and stay. Withdrawn rows stay withdrawn.

## Tests

**2a**
- In `supabase/tests/shared_reference_contributions_test.sql`:
  - use sync, source edit, taxon change and the old RPC create nothing;
  - a withdrawn row stays withdrawn through sync and edits;
  - draft flip, visibility change, observation delete, service-role detach and
    moderation hide each withdraw, with exact events;
  - public reads serve only consented rows and revisions
    `>= consent_first_revision`;
  - `contributor.id` is NULL in new revisions;
  - the CHECKs hold;
  - the execution surface.
- Observation references: public reads omit reference data without a
  consented contribution (extend the existing observation-reference test, or
  add one).
- Data step: withdraws exactly the unconsented shared rows; a second run
  changes nothing.
- Update fixtures that expect automatic sharing:
  - `taxon_identity_repair_test.sql:146-148,204`;
  - `taxon_identity_repair_concurrency_test.sh:99-100`;
  - `identification_v2_rpc_regression_test.sql:94-110`;
  - `retired_resolution_repair_test.sql`;
  - `taxon_identity_repair_label_test.sql` (records `consent_required`).
- `shared_reference_backfill_test.sql`: backfill semantics create nothing.
- Concurrency: detach, visibility or draft flip, and taxon change, each
  racing a refresh, following the pattern of
  `taxon_identity_repair_concurrency_test.sh`. The test fails on a deadlock
  (40P01) or on a share that survives without a qualifying use.
- Consent-scope check: a fixture-consented row withdraws with
  `consent_scope_exceeded` on an out-of-scope revision.
- Concurrency: a source edit racing a use sync, and an owner withdraw racing
  a refresh; no deadlock, no surviving unqualified share.
- Observation references: a frozen snapshot whose citation or treatment
  differs from every consented revision is omitted, even at the same set
  revision. A historical-import snapshot that isn't equal to a consented
  revision is omitted. A use on a public observation with private spore data
  is omitted even when another use keeps the contribution backed.
- Source deletion (set, treatment or work) withdraws, including a
  service-role update that sets only `deleted_at` with no user signed in.
- Execution surface: no role has EXECUTE on the grant-mode core or any new
  private helper.
- Observation references: a use backed by a consented contribution is served
  in landing's exact shape; hidden, banned, deleted and blocked owners, and
  pre-consent revisions, are omitted. Add a landing test that a consented
  reference renders.
- Every withdrawal path leaves the consent columns NULL and exactly one event
  (the bidirectional CHECK enforces the first).
- Landing: withdrawn rows and omitted observation references render
  correctly (`CuratedReferencesSection.test.tsx`,
  `publicApi.curatedReferences.test.ts`).

**2b**
- Grant succeeds only with:
  - the active version and locale;
  - matching revisions;
  - a registry species;
  - a qualifying use per decision B.
- Grant never clears `hidden_at`.
- Re-grant after withdrawal starts a new consent period, and the old
  revisions stay unserved.
- A revision beyond the consent scope withdraws.
- Rate limits apply to the new RPCs
  (`shared_reference_production_policy_test.sql`).
- The list is owner-only.
- Grant/withdraw and grant/draft races.
- Desktop:
  - the dialog shows the server text;
  - the share call passes displayed revisions, version and locale;
  - the list withdraws;
  - sync never calls share;
  - the allowlist contract test passes.
- Web: the list and Stop sharing.

## Threats

| Threat | Mitigation |
|---|---|
| Old or buggy client publishes | Only `grant` publishes; every other path is refresh-only or withdraws; consent version checked server-side |
| A client grants without showing the text | The RPC is the proof (active version, displayed revisions, the owner's own session). A modified client can skip the dialog only for its own owner's data. Accepted |
| Reactivation or old revisions re-exposed | Only `grant` re-shares, and the reads start at `consent_first_revision` |
| Grant races detach, draft, taxon change or a source edit | One advisory lock per owner+set, then a READ COMMITTED re-check with no `FOR SHARE`; source revisions compared, not row-locked |
| Non-owner or cascade changes leave a share public | Withdrawal is caller-independent and not swallowed |
| Edits publish more than was disclosed | The revision scope limit withdraws |
| Public observation leaks reference data | Observation references gated on consent (decision E) |
| Linking a share to the owner's other data | `contributor.id` NULL (F); linkage stays server-side. The label is still public, and the backing observation is public by B |
| Draft, private or friends observations | Never qualify, even with opt-in (B) |
| Moderation hide of the backing observation | Sets visibility private, so the visibility trigger withdraws |
| Account deletion | Existing anonymisation; the event log holds no owner id |
| Copies by other users | Cannot be recalled; disclosed, including re-sharing under their name |
| Consent-text drift | Versioned per locale; old consent never covers new text |

## Owner decisions

All six are decided; see "Owner decisions (2026-10-01)" at the top.
