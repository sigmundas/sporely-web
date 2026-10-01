# Stage 2d: references shared by default, and a dismissible publish notice

Status: proposed, not started. It replaces the opt-in model of Stage 2
(`2026-09-30-reference-sharing-consent.md`) and the activation gate of Stage
2c (`2026-10-01-reference-sharing-roles-and-publish-notice.md`). Stage 2c's
roles, labels and version gate stay. Desktop PR #7 (sporely-py) stays unmerged
until the owner retests.

## Owner decisions (2026-10-01)

1. **Shared by default, everywhere.** A reference attached to a public,
   non-draft observation is public:
   - on the observation page and in its plots: citation, measurements and
     role;
   - on the species-page listing, under the owner's display name.

   There is no consent dialog and no consent text. Drafts, private and
   friends-only observations, and observations with private spore data, never
   share.
2. **Stop sharing sticks.** The owner can stop sharing a reference, and no
   automatic path re-shares it. Share again undoes it. It covers both public
   surfaces.
3. **Contradicting references** stay shareable and labelled (Stage 2c).
4. **Informational publish notice.** It has a persistent "Don't show this
   again" checkbox. Once suppressed, transitions proceed without the modal,
   and Settings can turn the notice back on.

## Exposure at deploy (production, read-only, 2026-10-01)

- **30** live reference uses on **21** public, non-draft, spore-public
  observations, all from **1 owner**, all with role `compared`.
- **26** of those uses are on observations without a Sporely taxon. They
  appear on observation pages only.
- **1** contribution key qualifies for the species-page listing (a registry
  species).
- **1** of the 2 contributions withdrawn by the system (`consent_missing`)
  qualifies again and would be re-shared, since it was never an owner opt-out.
- 617026 and 55368 are not registry species, so they never appear on a
  species page. On observation pages they follow the same rule as any use.

## Design

### Opt-out: `private.reference_share_opt_outs(owner_id, source_measurement_set_id, opted_out_at)`

- **Key:** PK `(owner_id, source_measurement_set_id)`. "Stop sharing" means
  this reference set, everywhere and for every species, including uses whose
  observation has no taxon.
- **Independent of contributions:** it doesn't depend on a contribution row
  existing, so it works for non-registry and taxon-less uses too.
- **Withdraw:** `withdraw_reference_contribution` (and any desktop or web Stop
  sharing) inserts the opt-out row and withdraws every contribution of that
  set through the existing withdrawal helper, with reason `owner`.
- **Share again:** a new owner RPC, `public.share_reference_again(set_id)`,
  rate-limited like the others, deletes the opt-out row. The next qualifying
  event, or an immediate refresh in the same call, shares again.
- **Who can read it:** postgres only, plus the owner's own list RPC.

### Automatic sharing (species-page contributions)

- **Refresh mode creates rows:** the share core's refresh mode may now
  **create** a contribution, or re-share a system-withdrawn one, when all of
  these hold:
  - there is a qualifying use (unchanged predicate);
  - the species is a registry species;
  - there is no opt-out for the owner and set.
- **Sentinel consent:** it fills the existing consent columns with
  `consent_version = 0`, `consent_client = 'automatic'`, `consent_locale =
  NULL`, `consent_first_revision` set to the new revision, and
  `consent_scope` from the snapshot. The bidirectional CHECK
  (`status = 'shared'` ⇔ consented) stays as the exposure invariant. The
  all-or-nothing CHECK is adjusted so locale may be NULL for the automatic
  marker.
- **Opt-out is checked:** in the core's create, refresh and reshare
  branches, and in every trigger path. An opted-out set never shares.
- **Consent scope:** `consent_scope_exceeded` no longer applies to automatic
  rows. A new revision just updates the row's scope. The consent texts were
  never shown, so there's no disclosure to stay within.
- **Grant RPC:** `share_reference_contribution_with_consent` is kept but
  inert; the texts stay inactive. Removing it is later cleanup.

### Observation references (observation page and plots)

- **What it serves:** `search_public_observation_references` serves the
  frozen use snapshot for every live use whose observation is public, not a
  draft and has public spore data, whose owner isn't banned, deleted or
  blocked with the caller, and whose set has **no opt-out**. That is
  regardless of taxon or registry membership, as before Stage 2a. Each item
  keeps its role.
- **No content proof:** the consent-period content check is dropped. The
  owner's decision makes the frozen evidence itself the public record.
- **Output shape unchanged** (landing exact keys).

### Roles helper

`reference_contribution_public_roles` derives roles from the same uses the
observation read now serves, for that contribution's (owner, set, taxon), so
the two can't drift apart.

### Stage 1B labels

`consent_required` becomes unreachable. Rename the label for an opted-out set
to `opted_out`. Update the reconcile mapping and its tests.

### Notice (web and desktop)

- **New reference text:** "References attached to this observation become
  public with it: on the observation and its plots, and in the species page
  listing under your name. You can stop sharing a reference at any time in My
  shared references." When the observation has an opted-out set: "References
  you stopped sharing stay private."
- **"Don't show this again":** a checkbox, stored per device:
  - web: `localStorage`, using the existing settings pattern in
    `src/settings.js` and the `import.dontShowAgain` string;
  - desktop: `SettingsDB`.

  A Settings toggle, "Show what becomes public before publishing", turns it
  back on. When suppressed, transitions proceed without the modal, including
  precision increases. The setting is the owner's choice.

### Clients

- **Desktop (PR #7):**
  - remove the **Share publicly…** consent dialog path;
  - per-reference status shows Shared or Stopped, with Stop sharing / Share
    again, in My shared references and wherever the old action was;
  - update the notice text and add don't-show-again plus the settings
    toggle;
  - don't touch `add_reference_dialog.py`, which another candidate owns.
- **Web:** update the notice text and add don't-show-again plus the settings
  toggle. "My shared references" lists every shared set, automatically shared
  or not, with Stop sharing / Share again.
- **Landing:** no change needed. PR #3's labels apply to the newly listed
  rows. It should merge before or with the server change, so species-page
  rows always show labels.

## Order

1. **Web notice text** (says references become public). Ships first, so it
   is never understating. Until the server change it over-warns slightly.
2. **Landing PR #3** merged; its Cloudflare preview issue is resolved first.
3. **Server migration:** the opt-out table, automatic sharing, the
   observation-reference rewrite, the roles helper and the Stage 1B labels.
   - Deployed via the deploy tree after a production preflight that repeats
     the counts above.
   - Shown to the owner before the push, since it's a production change that
     makes data public.
4. **Desktop (PR #7):** retested by the owner, then released by the owner.

## Rollback

Restore fail-closed reads through a new migration. Existing `automatic` rows
get withdrawn with reason `rollback`, and the opt-out rows are kept. A
rollback must never leave rows `shared` without the opt-out check in place.

## Tests

- **Automatic sharing:**
  - an automatic contribution is created on a qualifying use for a registry
    species, and not for a non-registry one;
  - a system-withdrawn row is re-shared, and an owner-withdrawn (opted-out)
    one never is, across use sync, source edit, taxon change and Stage 1B;
  - Share again re-shares.
- **Observation references:**
  - served for qualifying uses, including taxon-less and non-registry ones;
  - omitted for opted-out sets, drafts, private, friends-only, private spore
    data, and banned, deleted or blocked owners;
  - output shape unchanged.
- **Roles:** they match the served uses.
- **Execution surface:** the opt-out table and the new RPC.
- **Concurrency:** opt-out races refresh, and Share again races withdraw.
- **Notice:**
  - don't-show-again persists and suppresses the modal;
  - the Settings toggle restores it;
  - the new text, and the opted-out line.

Every candidate gets a general review and a security review. The security
review must explicitly re-justify removing the Stage 2a mitigations (the
consent gate and the content proof) under the new owner decision.
