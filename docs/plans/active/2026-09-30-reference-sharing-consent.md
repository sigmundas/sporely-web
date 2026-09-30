# Stage 2: consent and visibility for shared reference contributions

Status: proposed, not started. Stage 2 of
`docs/plans/active/2026-09-30-reference-share-eligibility.md`. An independent
security review of this plan is required before implementation, and the owner
decisions at the end come first. Stage 3 (widening eligibility) is out of
scope.

## Goal

A reference contribution becomes public only after its owner explicitly opts
in to that contribution, and stays public only while the owner hasn't
withdrawn it.
- **Consent enforced everywhere:** the server enforces this on every path,
  including old clients.
- **No automatic sharing from private or drafts:** private and draft
  observations never create public contributions automatically.
- **Observation visibility is not consent:** a public observation doesn't
  count as consent.
- **Eligibility unchanged:** it stays at the current registry species. 617026
  and 55368 stay private.

## What is public today, and how it gets there

A shared contribution is readable by anyone, signed in or not, through
`public.search_public_reference_contributions` and
`public.get_public_reference_contribution`
(`supabase/migrations/20260830183210_add_shared_reference_contributions.sql:542-653`).
The public landing site's species pages use both
(`sporely-landing/src/lib/publicApi.ts:1214,1232`, `SpeciesPage.tsx`). The
envelope carries:
- the contributor's stable account id and username ("Sporely user" if blank
  or containing `@`);
- the full citation (work, authors, editors, publisher) and exports;
- the measurement set, including projected raw points;
- the species.

Revisions are immutable and kept indefinitely.

Every path that creates or re-shares one runs without an owner action:

| Path | Trigger | Today |
|---|---|---|
| Reference-use sync | `observation_reference_use_shared_contribution_trg` (`:937-940`) → `refresh_shared_reference_for_use_row` (`:782-823`) → `share_reference_contribution_for_owner` (`:190-411`) | creates or re-shares on every insert/update of a use |
| Source edits | `reference_measurement_set_…_trg`, `reference_treatment_…_trg`, `reference_work_…_trg` (`:942-952`) | a revision bump publishes a new public revision |
| Taxon change | `observation_taxon_shared_contribution_trg` (`:954`) → `refresh_shared_references_for_observation_taxon` (`:825-889`) | withdraws under the old taxon and shares under the new one |
| Stage 1B repair | `_taxon_identity_repair_reconcile_references` (`20260930213813`) | shares after a promotion |
| Historical backfill | `20260831150330` | ran once at deploy; the function no longer exists |
| Explicit RPC | `public.share_reference_contribution` (`:413-435`), granted to `authenticated` | the desktop has a wrapper (`sporely-py/utils/cloud_sync.py:16461`) that no UI calls |

Neither path checks the observation's visibility or draft state. Re-sharing
also clears `withdrawn_at` (`:382-387`), so **a withdrawn contribution
silently comes back on the owner's next sync or edit**. Withdrawal exists
(`public.withdraw_reference_contribution`, `:437-467`, owner-only), but no UI
in either client calls it. The web app has no reference features at all.
Only the desktop creates reference uses.

## Design

### Consent record

- **Unit:** consent covers one contribution key, `(owner_id,
  source_measurement_set_id, sporely_taxon_id)`, the same key contributions
  already use.
  - *Per-account* would publish future sources and species the owner never
    saw.
  - *Per-set* breaks when a taxon changes.
- **On the contribution row:** `consented_at`, `consent_version`, and
  `consent_client` (`desktop`/`web`).
  - Invariant: `CHECK (status <> 'shared' OR consented_at IS NOT NULL)`.
  - Withdrawal sets `consented_at = NULL`.
- **Audit:** `private.shared_reference_consent_events`, append-only, one row
  per grant, withdrawal or system withdrawal: contribution, event, consent
  version, client, time, reason. No copy of user data beyond the ids already
  in the contribution row.
- **Consent texts:** `private.reference_share_consent_texts` (`version`,
  `text_sha256`, `active`). The grant RPC accepts only the active version, and
  clients show exactly that text. A wording change adds a version, so old
  consent never covers new disclosure text.

### Granting

- **New RPC:** `public.share_reference_contribution_with_consent(set_id,
  taxon_id, expected revisions…, consent_version)`, granted to
  `authenticated`, owner derived from `auth.uid()`. It is the only path that
  can set `consented_at` or move a row to `shared`.
- **Checks, all server-side:**
  - the three source revisions match what the client displayed;
  - active consent version;
  - registry species (eligibility unchanged);
  - at least one live use of that set on a **non-draft** observation of that
    exact taxon;
  - the account isn't banned or deleted.

  The existing advisory and row locks (`:229-232,353-358`) cover the whole
  check-and-write.
- **The old RPC:** `public.share_reference_contribution` stays callable for
  old clients but returns `consent_required` and never creates, re-shares or
  revises anything.

### Automatic paths

- **Never create or reactivate:** the use trigger, the source-edit triggers,
  the taxon trigger and Stage 1B never create a contribution and never
  reactivate a withdrawn one. `share_reference_contribution_for_owner` refuses
  `consent_required` unless the row is `shared` with `consented_at` set.
- **Source edits** on a consented, shared contribution publish a new revision
  only while a qualifying non-draft use remains (decision C below).
  Otherwise they withdraw.
- **Losing the qualifying use:** when the last qualifying use goes away
  (detached, observation deleted, turned into a draft, or the taxon changed),
  the contribution is withdrawn and the event is recorded. A later return
  does not re-share; that needs new consent.
- **Taxon change:** withdraw under the old key as today. The new key needs its
  own consent.
- **Stage 1B:** records `consent_required` instead of sharing (next to
  `not_registry_species` and `not_species`).

### Visibility

- **Drafts:** never qualify, for granting or for keeping a contribution
  shared.
- **Private observations:** may back an **explicit** share (see decision B)
  if the consent screen warns that the contribution will still publicly
  reveal, under the owner's name, that they have identified this species,
  even though the observation stays private. Automatic sharing from a private
  observation is impossible, because nothing shares automatically any more.

### Withdrawal

- **Web and desktop** get a "My shared references" list showing status,
  species, revision and shared date, with **Stop sharing**. It calls the
  existing `withdraw_reference_contribution`.
- **What withdrawal does:** public search and the envelope read stop at once;
  a withdrawn row returns only a `{status: 'withdrawn'}` stub (`:627-638`).
- **What it cannot undo**, stated in the consent text and in
  `docs/supabase-sync-contract.md`:
  - copies other users already made into their own references
    (`sporely-py/database/curated_reference_forks.py`) belong to them, and
    recalling them would mean editing other users' data;
  - retained immutable revision rows, which are private and needed for frozen
    evidence;
  - anything cached by third parties while it was public.

### Client changes

- **Desktop (`sporely-py`):**
  - a **Share publicly…** action on a reference set that is attached to an
    eligible observation;
  - a consent dialog showing the active consent text: what becomes public
    (attribution, citation, measurement points, species), that edits publish
    new revisions, what withdrawal cannot undo, and the private-observation
    warning;
  - "My shared references" with Stop sharing.

  Sync keeps working unchanged: an unconsented use simply stays private.
- **Web (`src/`):** "My shared references" with Stop sharing. A share action
  only if web ever gains reference features, which are out of scope.
- **Contract:** update `docs/supabase-sync-contract.md:5-15`: sharing
  requires explicit per-contribution consent; withdrawal is final until new
  consent.

## The 2 existing contributions

Production, read-only, 2026-09-30:
- **Owner and taxon:** both belong to 1 owner and are filed under taxon
  34615, shared 2026-09-06, with 1 revision each. They are not hidden.
- **Carrying observations:** one public, and one **public but draft**.
- **Copies:** no other user's use or measurement set mentions either
  contribution id, and there are no policy events.

**Recommendation: withdraw both in the Stage 2 migration**, recorded as system
withdrawal with reason `consent_missing`. Neither had consent, and one breaks
the draft rule outright.
- **Why this doesn't conflict with decision 4:** withdrawal reduces exposure
  and manufactures no consent.
- **Reversible for the owner:** they can re-share with one explicit opt-in.
  Leaving the contributions public cannot be undone the same way.
- **Needs authorization:** this is a production data write and needs explicit
  authorization at deploy time (AGENTS.md "Production writes by agents"). The
  migration's dry-run count must be exactly 2.

## Threats and privacy analysis

| Threat | Mitigation |
|---|---|
| Old or buggy client publishes without consent | Only the new RPC can grant, and every other path refuses `consent_required`. The consent version is checked server-side; no client flag is trusted |
| A client calls the new RPC without showing the text | The RPC is the only proof. It needs the active version, matching displayed revisions and an authenticated owner. Residual risk: a modified client can still skip the dialog for its own owner's data. This is accepted, because the owner is the one consenting |
| Withdrawn contribution comes back on sync or edit | Removed: nothing but the grant RPC sets `shared`. Tested |
| Race between grant and withdraw | Same advisory and row lock order. The last committed action wins, and both are audited |
| Edits publish content the owner didn't review | Disclosed in the consent text. Alternatively, require re-consent per revision (decision C) |
| Species revealed from a private observation | Explicit consent with a warning (decision B), or forbid (B alternative) |
| Draft observations | Never qualify, and losing the last qualifying use withdraws |
| Banned, blocked or deleted accounts | Unchanged: `account_unavailable`, read filters, anonymisation (`:233-239,516,570-579`). Consent columns stay for audit after anonymisation |
| Consent log reveals behaviour | The log is private, postgres-only, with no grants, and holds no data beyond ids |
| Copies by other users | Cannot be recalled; disclosed before consent |
| Sensitive species (for example *Psilocybe semilanceata*) | No widening in this stage, and explicit consent with a warning. Not relevant to the 2 existing contributions |

## Migration and rollout

- **Server migration** (one, deployed via `scripts/supabase-deploy-tree.mjs`):
  - consent columns and CHECK;
  - the events table and the consent-texts table with version 1;
  - the new RPC;
  - `CREATE OR REPLACE` of `share_reference_contribution_for_owner`, the old
    RPC, the three triggers' functions, `refresh_shared_reference_for_use_row`,
    `refresh_shared_references_for_observation_taxon` and the Stage 1B
    reconcile helper;
  - `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role` on every new
    private function.
- **Data step:** withdraw the 2 existing rows, if approved (see above). The
  CHECK is added after that step, so the migration can't fail on the existing
  rows.
- **Order:**
  1. The server migration ships first. Old desktop builds keep syncing and
     simply stop publishing.
  2. Then the desktop release with the share dialog and list.
  3. Then the web list.
- **Landing site:** no change. Withdrawn rows disappear from its species pages.
- **Rollback:** a full revert to the pre-Stage-2 function bodies is not
  allowed. Those bodies re-share on the next sync, which would re-publish the
  withdrawn rows without consent. Instead:
  - a rollback migration may drop or disable the new grant RPC and the client
    features;
  - it must keep the consent gate in `share_reference_contribution_for_owner`,
    so every path fails closed and nothing becomes public;
  - the new columns and tables stay, since they are inert;
  - the 2 withdrawn rows stay withdrawn.

  This leaves sharing off, not back at automatic.

## Tests

- **`supabase/tests/shared_reference_contributions_test.sql`:**
  - use sync, source edit, taxon change and the old RPC each create nothing
    without consent;
  - the grant RPC shares only with the active version, matching revisions, a
    registry species and a non-draft use;
  - a draft-only use refuses;
  - a private non-draft use is allowed or refused per decision B;
  - withdraw, then sync, then edit: the contribution stays withdrawn;
  - losing the last qualifying use withdraws;
  - the audit events are exact;
  - the CHECK invariant holds;
  - execution surface: the grant RPC is callable by `authenticated` only, and
    the helpers by nobody.
- **`shared_reference_backfill_test.sql`:** replaying the old backfill logic
  creates nothing without consent.
- **`shared_reference_production_policy_test.sql`:** rate limits cover the new
  RPC.
- **`taxon_identity_repair_test.sql`, `taxon_identity_repair_label_test.sql`:**
  a promotion records `consent_required` and shares nothing.
- **Concurrency:** a grant/withdraw race and a grant/detach race, following the
  pattern of `taxon_identity_repair_concurrency_test.sh`.
- **Data step:** the withdrawal of existing rows touches exactly the
  unconsented shared rows, and a second run touches none.
- **Desktop (`sporely-py`):** the dialog renders the active text, the share
  call passes the displayed revisions and version, the list withdraws, and
  sync never calls share.
- **Web:** the list renders and Stop sharing calls withdraw.
- **Landing:** a withdrawn contribution is absent (existing
  `CuratedReferencesSection.test.tsx`, `publicApi.curatedReferences.test.ts`).

## Owner decisions needed

- **A. The 2 existing contributions:** withdraw both in the migration
  (recommended), or only the one carried by a draft observation?
- **B. Private observations:** may they back an explicit share, with the
  warning (recommended, since sharing is a separate action), or must the
  observation be public?
- **C. Source edits after consent:** publish new revisions automatically,
  covered by the original consent and disclosed (recommended), or require
  re-consent for every revision?
- **D. Web:** a list with Stop sharing only (recommended, since web has no
  reference features), or should this stage also add reference-sharing
  features to web?
