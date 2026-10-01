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
- **Event types:** the event table gains `shared_automatically`,
  `opted_out` and `share_again`. They carry no locale and no hash. The CHECKs
  are updated, and the withdrawal reasons gain `rollback` (helper list,
  events CHECK, web `WITHDRAWAL_REASON_KEYS`).
- **Consent texts and the grant RPC** stay inert.

### Opt-out: `private.reference_share_opt_outs(owner_id, source_measurement_set_id, opted_out_at)`

- **Keys and protection:** PK `(owner_id, set)`; `owner_id` references
  `profiles` `ON DELETE CASCADE`. RLS is enabled with no grants. Writes take
  `lock_shared_reference_key(owner, set)`.
- **New owner RPCs**, rate-limited, owner-checked, and returning the same
  response for an unknown or foreign set:
  - `public.stop_sharing_reference_set(set_id)` inserts the opt-out and
    withdraws every contribution of that set with reason `owner`;
  - `public.share_reference_set_again(set_id)` deletes the opt-out and
    refreshes now.

  The existing `withdraw_reference_contribution` becomes a wrapper:
  contribution id → its set → stop sharing.
- **Owner list:** `list_my_shared_reference_contributions` is replaced by a
  set-keyed `list_my_reference_sharing()`. It returns each of the owner's
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
- **At deploy:** after creating the functions, the migration runs refresh
  once for every currently qualifying key, which creates the 1 qualifying
  key and re-shares the 1 eligible `consent_missing` row. The rows are
  logged as `shared_automatically`.

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
  opted-out set: "References you stopped sharing stay private."
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

1. **Web notice and list** (over-warns until the server change).
2. **Landing PR #3**, after its Cloudflare preview issue is resolved.
3. **Server migration:** share basis, the opt-out table and backfill, the
   RPCs, automatic sharing, triggers, the observation read, roles, Stage 1B
   and the deploy refresh. Deployed via the deploy tree after the preflight
   counts are **shown to the owner**.
4. **Desktop (PR #7):** retested by the owner, then released by the owner.

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
