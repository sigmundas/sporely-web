# Stage 2: consent and visibility for shared reference data

Status: decided 2026-10-01. Revised after independent security review and
general review of `ebb9416` (both "needs changes"; incorporated). Not
started. Order: re-review of this revision, then 2a (implement, review,
security review, deploy, verify fail-closed), then 2b as a separately
reviewed step.

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
  - `status <> 'shared' OR consented_at IS NOT NULL`;
  - `consented_at`, `consent_version` and `consent_first_revision` are all set
    or all NULL.
- **Withdrawal** clears all four. History lives in the event log.
- **Event log:** `private.shared_reference_consent_events`, append-only,
  postgres-only. It records the contribution id, event (`granted`,
  `withdrawn_by_owner`, `withdrawn_by_system`), reason, consent version and
  time. **No `owner_id`**, so account deletion leaves nothing to scrub. The
  anonymise trigger (`:516-540`) records a system event.
- **Consent texts:** `private.reference_share_consent_texts` (`version`,
  `locale`, `text`, `text_sha256`, `active`). The text lists:
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
- **Observation references:** they return a use's reference data only when
  that use's set has a consented, shared contribution under the observation's
  exact effective taxon. They serve that contribution's current revision, not
  the private `snapshot_json`. Otherwise the reference data is omitted
  (decision E).
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
  if the snapshot's data kinds stay within what `consent_version` disclosed:
  the same snapshot schema version, and no new raw-point or free-text fields.
  Otherwise the row is withdrawn with reason `consent_scope_exceeded`, and the
  owner must opt in again. This covers the pending v2 snapshots in
  `20260914090000`.
- **Withdrawal on losing the qualifying use**, whoever makes the change:
  - A new `private.withdraw_unqualified_contributions(owner, set)` withdraws
    a shared row that has no qualifying use left and records a system event.
  - Called from the use trigger (all callers, including service role and
    cascade deletes), and from new triggers: `AFTER UPDATE OF is_draft,
    visibility` and `AFTER DELETE` on `public.observations`.
  - Moderation hide (`admin-ops/adminActions.ts:444-451`) sets
    `visibility = 'private'`. Under decision B a private observation doesn't
    qualify, so the visibility trigger withdraws what it backs. The event
    reason is `observation_not_public` whoever made the change. A test covers
    the service-role update the admin action performs.
  - Never rate-limited, never inside an error-swallowing block.
- **Locking:** every path that grants, refreshes or withdraws takes the same
  advisory lock on `(owner_id, source_measurement_set_id)` first, then
  re-reads uses and observations with `FOR SHARE`, then decides. This covers
  the use, observation, source and taxon triggers, Stage 1B, grant and
  withdraw. The withdraw RPC gains the advisory lock too; today it only locks
  the row (`:450-451`).

### Visibility (decision B)

A qualifying use is a live use of the set on an observation with `visibility =
'public'`, not a draft, not deleted, whose exact effective taxon is the
contribution's taxon.
- **Ineligible:** private, `friends` and draft observations, even with
  explicit opt-in.
- **Losing eligibility:** an observation leaving `public` or becoming a draft
  withdraws the contributions it alone backed.
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

**Recommendation: withdraw both** (decision A). In the Stage 2a migration, in
one transaction:
1. `LOCK TABLE`;
2. replace the functions;
3. `UPDATE … SET status = 'withdrawn', withdrawn_at = now() WHERE status =
   'shared' AND consented_at IS NULL`, with system events reason
   `consent_missing`;
4. add the CHECKs.

The migration is count-agnostic, so local and CI resets work. The production
preflight asserts exactly 2 before the push. This withdraws; it publishes
nothing. With the revision rule above, re-sharing later never re-exposes
revision 1. The deploy is a production data write and needs explicit
authorization at deploy time.

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
features and keeps 2a, so sharing is off. Rolling back 2a means a new
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
- Concurrency: detach, draft flip and taxon change, each racing a refresh,
  following the pattern of `taxon_identity_repair_concurrency_test.sh`.
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
| Grant races detach, draft or taxon change | One advisory lock per owner+set, then re-check with `FOR SHARE` |
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
