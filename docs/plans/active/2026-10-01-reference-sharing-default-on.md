# Stage 2d: references shared by default, and a dismissible publish notice

Status: proposed, revised after general and security review of `fbd3da1`
(both "needs changes"; incorporated). Not started.
- **Supersedes:** the opt-in model of Stage 2
  (`2026-09-30-reference-sharing-consent.md`); and, from Stage 2c
  (`2026-10-01-reference-sharing-roles-and-publish-notice.md`), the content
  proof in the roles helper, the contradicts consent-dialog wording, and the
  activation gate.
- **Kept from Stage 2c:** roles, labels and the `_v2` version gate.

Desktop PR #7 (sporely-py) stays unmerged until the owner retests.

## Owner decisions (2026-10-01)

1. **Shared by default, everywhere.** A reference attached to a public,
   non-draft observation is public:
   - on the observation page and in its plots: citation, measurements and
     role;
   - on the species-page listing, under the owner's display name.

   No consent dialog. Drafts, private and friends-only observations, and
   observations with private spore data, never share.
2. **Stop sharing sticks** per reference, on both surfaces, until Share again.
3. **Contradicting references** stay shareable and labelled (Stage 2c).
4. **Informational publish notice.** It has a persistent "Don't show this
   again" checkbox. Once suppressed, transitions proceed without the modal,
   and Settings can turn the notice back on.

## Exposure at deploy (production, read-only, 2026-10-01; re-run in the preflight)

- **30** live uses on **21** public, non-draft, spore-public observations,
  **1** owner, all with role `compared`.
- **26** of them have no Sporely taxon, so they appear on observation pages
  only.
- **1** key qualifies for the species-page listing.
- **1** of the 2 contributions withdrawn by the system (`consent_missing`)
  qualifies again.
- **To add to the preflight:** withdrawn rows with no system-withdrawal event
  (pre-2a owner withdrawals). These become opt-outs, never re-shares.

## Design

### Share basis instead of special consent values

- **New column:** `private.shared_reference_contributions.share_basis text
  CHECK (share_basis IN ('automatic', 'consented'))`.
- **CHECKs replaced:**
  - shared rows: `status = 'shared'` ⇒ `share_basis IS NOT NULL`, with
    `consented` requiring the consent fields set and `automatic` requiring
    them NULL;
  - withdrawn rows: `share_basis IS NULL` and every consent field NULL.

  Existing rows satisfy this: 0 shared, and every withdrawn row has NULL
  consent fields.
- **Consent-only checks:** the consent-text revocation check
  (`reference_consent_text_revoked`) and the consent-scope check apply only
  to `consented` rows. Automatic rows are never withdrawn as
  `consent_text_revoked` or `consent_scope_exceeded`. The basis is decided by
  the server, never by client input: `p_consent_client` cannot produce
  `automatic`.
- **Event types:** the event table gains `shared_automatically`
  (per contribution, no locale or hash). Set-level stop and share-again are
  not logged in that table, because its `contribution_id` is `NOT NULL` and
  taxon-less sets have no contribution. The opt-out row's `opted_out_at` is
  the record, and deleting it is share-again. Contribution withdrawals caused
  by a stop are still logged per contribution through the helper. The CHECKs
  are updated, and the withdrawal reasons gain `rollback` (helper list,
  events CHECK, web `WITHDRAWAL_REASON_KEYS`).
- **One sharing period for both bases:** a new column,
  `shared_first_revision integer`, holds the first revision of the current
  sharing period. It is set for both bases whenever a row becomes `shared`,
  and cleared on withdrawal. A CHECK keeps `shared_first_revision <=
  current_revision`, like the existing `consent_period_bound`. `consent_first_revision` stays for `consented`
  rows only. Every check that today means "shared and consented" moves to
  "shared, with `share_basis`, and revision `>= shared_first_revision`":
  - `reference_contribution_is_served`;
  - `reference_contribution_public_roles`;
  - `search_public_reference_contributions_v2` and
    `get_public_reference_contribution_v2` (`20261001091940:51-52,89,107,217`);
  - `withdraw_contribution_if_unpublishable` (`20260930232633:570`);
  - the Stage 1B post-check (`:871`);
  - the `shared_iff_consented` CHECK.

  A re-shared row therefore never serves revisions from before its earlier
  withdrawal.
- **Consent texts and the grant RPC** stay inert.

### Opt-out: `private.reference_share_opt_outs(owner_id, source_measurement_set_id, opted_out_at)`

- **Keys and protection:** PK `(owner_id, set)`; `owner_id` references
  `profiles` `ON DELETE CASCADE`. RLS is enabled with no grants. Writes lock
  the owner's `profiles` row `FOR KEY SHARE` **first**, then
  `lock_shared_reference_key(owner, set)`. That is the grant's order from
  Stage 2b (`20260930232633:22-24`), so a profile delete can't deadlock with
  them.
- **New owner RPCs**, rate-limited, owner-checked, and returning the same
  response for an unknown or foreign set:
  - `public.stop_sharing_reference_set(set_id)` inserts the opt-out and
    withdraws every contribution of that set with reason `owner`;
  - `public.share_reference_set_again(set_id)` deletes the opt-out and
    refreshes now.

  The existing `withdraw_reference_contribution` becomes a wrapper:
  contribution id → its set → stop sharing. Its response contract stays the
  same (`updated`, `no_change`, `forbidden`, `not_found`, `rate_limited`), so
  released desktop and web keep working. One call now stops the whole set,
  which errs toward privacy. The stop confirmation text in both clients says
  so.
- **Owner list:** a new set-keyed RPC, `list_my_reference_sharing()`.
  `list_my_shared_reference_contributions` **stays** unchanged until web and
  desktop have moved, and is removed in a later cleanup. It returns each of the owner's
  sets that has a live use on a public, non-draft, spore-public observation,
  or an opt-out. For each:
  - status: shared, stopped, or hidden by moderation;
  - species-page contribution, if any;
  - the count of public observations using it;
  - the set's own labels.
- **Migration backfill:** every withdrawn contribution that has no
  system-withdrawal event (`withdrawn_by_system`) gets an opt-out for its
  (owner, set). Withdrawals made by owners before Stage 2a are therefore
  respected.
  - **Over-matches safely:** this also turns event-less system withdrawals
    from before Stage 2a into opt-outs: taxon change, detach, source deletion
    and Stage 1B (`20260830183210:697,874,916`; `20260930193000:331`). That
    errs toward less exposure.
  - **Repair withdrawals:** they are excluded when identifiable, through
    `taxon_identity_repair_reference_actions` rows with
    `old_contribution='withdrawn'`.
  - **Preflight** lists the affected sets. Production has 2 withdrawn rows
    today, both with `withdrawn_by_system` events, so the backfill is expected
    to touch none.
  - It runs **strictly before** the deploy refresh.

### Automatic sharing (species-page contributions)

- **When rows are created:** the share core's refresh mode may create a
  contribution, or re-share a system-withdrawn one, with basis `automatic`,
  when all of these hold:
  - there is a qualifying use (unchanged predicate);
  - the species is a registry species;
  - there is no opt-out;
  - no contribution of that (owner, set) is hidden by moderation.

  Re-sharing never clears `hidden_at`.
- **Every trigger can create:** the use, source, taxon and observation
  triggers create as well as withdraw. When an observation becomes public,
  non-draft and spore-public, its uses are refreshed, so publishing creates
  the species-page row.
- **Stage 1B** maps `created` to `shared`, and an opted-out set to
  `opted_out`. `consent_required` is retired.
- **At deploy:** after the backfill and after creating the functions, the
  migration runs refresh once for every currently qualifying key. It calls
  `share_reference_contribution_for_owner` or the core **directly**: the
  trigger path's owner/service gate (`20260930232633:623-625`) skips every row
  inside a migration, where `auth.uid()` is NULL.
  - **Honours opt-outs and hides,** because the core checks both.
  - **Count-agnostic:** the migration works on any count; the production
    preflight asserts the expected 1 created and 1 re-shared, and shows them
    to the owner.
  - Rows are logged as `shared_automatically`.

### Observation references (observation page and plots)

`search_public_observation_references` serves the frozen use snapshot for
every live use with all of these:
- a live source (set, treatment and work not deleted);
- an observation that is public, not a draft and has public spore data;
- an owner who isn't banned, deleted or blocked with the caller;
- a set with no opt-out;
- no hidden contribution for that (owner, set), so moderation still applies.

Taxon and registry membership don't matter. The role is kept, and the output
shape is unchanged. The content proof is dropped (owner decision 1).

### Roles helper

`reference_contribution_public_roles` derives roles from exactly the uses the
observation read serves for that contribution's (owner, set, taxon).

### Notice (web and desktop)

- **Triggers:**
  - becoming public, non-draft and spore-public;
  - any location-precision increase on such an observation;
  - **attaching a reference to an already-public observation;**
  - **spore data changing from private to public** on a public observation.
- **Reference text:** "References on a public observation are public: on the
  observation and its plots, as the version you attached, and in the
  species-page listing under your name, updated when you edit the reference
  in your library. This includes references you attach later. You can stop
  sharing a reference in My shared references." When the observation uses an
  opted-out set: "References you stopped sharing stay private." This line needs opt-out data from
  `list_my_reference_sharing`, so it ships with order step 4, not step 1.
- **"Don't show this again (on this device)":** stored per user and per
  device:
  - web: a `localStorage` key that includes the user id;
  - desktop: `SettingsDB`.

  A Settings toggle, "Show what becomes public before publishing (this
  device)", turns it back on. When suppressed, transitions proceed without
  the modal, including precision increases; that's the owner's choice.
  Desktop must still call `record_confirmed_location_precision` when the
  notice is suppressed, so the sync guard allows the change.

### Clients

- **Web:**
  - notice: triggers, text, don't-show-again and the settings toggle in
    `src/settings.js` / `settings-overlay.js`;
  - "My shared references" (`src/shared-references.js`) moves to
    `list_my_reference_sharing`, with Stop sharing and Share again;
  - i18n in four locales.
- **Desktop (PR #7):**
  - remove the "Share publicly…" consent dialog path
    (`ui/reference_sharing_dialogs.py`, `ui/comparison_panel.py:361`,
    `ui/main_window.py:9492-9517`);
  - set-keyed My shared references with Stop sharing and Share again; new
    RPCs in `utils/cloud_sync.py` and the allowlist (~2244);
  - notice: triggers, including attach-to-public and spore private→public,
    text, don't-show-again, and a toggle in the main settings dialog;
  - nb_NO, sv_SE and de_DE.

  The Add Reference dialog's attach-to-public notice hooks into the attach
  callback, not into dialog internals, which the Add Reference candidate
  owns.
- **Landing:** no change. PR #3 must merge before the server change, so
  species-page rows are always labelled.

## Order

1. **Web notice text and triggers** only (over-warns until the server
   change). The web list keeps using today's RPC.
2. **Landing PR #3**, after its Cloudflare preview issue is resolved.
3. **Server migration:** share basis and sharing period, the opt-out table
   and backfill, the new RPCs (the old list kept), automatic sharing,
   triggers, the observation read, roles, Stage 1B and the deploy refresh.
   Deployed via the deploy tree after the preflight counts are **shown to the
   owner**.
4. **Web list** moves to `list_my_reference_sharing`, with stop and
   share-again.
5. **Desktop (PR #7):** retested by the owner, then released by the owner.

The deferred `20260914090000`'s envelope-version decision must also cover
automatic sharing.

## Rollback

One migration, in one transaction, under the forward migration's table
locks:
1. Restore the fail-closed reads and refresh-only cores.
2. Withdraw every `automatic` row with reason `rollback`.

Opt-out rows stay. No row stays `shared` without the opt-out check.

## Tests

- **Server, new or extended:**
  - automatic create, re-share and opt-out stickiness across every trigger,
    Stage 1B and the deploy refresh;
  - the backfill of pre-2a owner withdrawals;
  - set-keyed stop and share-again RPCs and their surface;
  - the list RPC;
  - account-deletion cascade;
  - moderation hides honoured on both surfaces;
  - the observation read: taxon-less, non-registry, opted-out, draft,
    private, friends-only and private-spore cases, plus deleted sources and
    banned, deleted or blocked owners;
  - roles agree with what the observation read serves;
  - automatic rows never withdrawn as `consent_text_revoked` or
    `consent_scope_exceeded`;
  - CHECKs; rollback.
- **Server, files to update:**
  - `shared_reference_contributions_test.sql`;
  - `shared_reference_production_policy_test.sql`;
  - `shared_reference_consent_data_step_test.sql`;
  - `shared_reference_consent_grant_test.sql`;
  - `shared_reference_roles_test.sql`;
  - `shared_reference_backfill_test.sql`;
  - `public_observation_references_test.sql`;
  - `taxon_identity_repair_test.sql`;
  - `taxon_identity_repair_label_test.sql`;
  - `shared_reference_consent_concurrency_test.sh` (plus opt-out against
    refresh, and share-again against stop);
  - `taxon_identity_repair_concurrency_test.sh`.
- **Web:** notice triggers, text, don't-show-again keyed per user, the
  settings toggle, and the list with stop and share-again.
- **Desktop:**
  - notice triggers, including attach-to-public and spore private→public;
  - a suppressed notice still records confirmed precision;
  - the list with stop and share-again;
  - the consent dialog removed;
  - contract tests for the new RPCs.

Every candidate gets a general review and a security review.

## Handoff: order step 3 (server) candidate, 2026-10-01

- Branch `feature/reference-sharing-default-on-server` from `7e5aac0`;
  migration `20261001113007_share_references_by_default.sql`; new test
  `shared_reference_default_on_test.sql`; listed test files updated (plus
  `identification_v2_rpc_regression_test.sql`). Not deployed.
- Verified locally: `supabase db reset --local`; 71/72 SQL tests pass
  (`public_observation_point_prep_test.sql` fails at the base too); both
  concurrency scripts on fresh resets; deploy-tree node tests; the migration
  also applies without the deferred `20260914090000`.
- Choices inside the plan: the grant mode also refuses an opted-out set
  (`opted_out`); the species-page read (`reference_contribution_is_served`)
  also checks the opt-out; a refresh on a set with a hidden contribution
  returns `moderation_hidden` (Stage 1B records `not_shareable:moderation_hidden`);
  a refresh without a qualifying use and no shared row returns
  `qualifying_use_required` (Stage 1B records it); the backfill also opts out
  rows whose latest withdrawal event is the owner's; the deploy refresh
  aborts the migration on any error.
- Open: the rollback migration is not drafted (its step 2 is tested);
  web `WITHDRAWAL_REASON_KEYS` gains `rollback` with order step 4;
  general and security review of this candidate.
