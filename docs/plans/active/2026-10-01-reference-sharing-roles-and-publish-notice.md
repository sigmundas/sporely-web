# Stage 2c: contradicting references and the publish notice

Status: proposed, revised after general review and security review of
`3f9eec2` (both "needs changes"; incorporated). Not started. Follows Stage 2
(`docs/plans/active/2026-09-30-reference-sharing-consent.md`). Consent text v1
stays inactive throughout. Activation is a separate owner decision, under the
gate at the end. Desktop PR #7 (sporely-py) stays unmerged until the owner's
manual checks pass.

## Owner decisions (2026-10-01)

1. **Contradicting references stay shareable.** There is no server-side
   refusal. A contradicting reference can be scientifically valuable: it can
   point to incorrect published data, an anomalous specimen, or a
   misidentified or unknown specimen.
2. **The relationship is never hidden.** A contribution shows **every** role
   that its owner's publicly visible uses have for that species. It is
   labelled "Contradicts" whenever any of them contradicts, on **every**
   public listing: the landing species page, the landing compare tray, and
   the desktop catalogue and fork dialog. It is never presented as
   supporting the identification.
3. **A publish notice in web and desktop** whenever an observation becomes
   public and not a draft. It says what becomes public, including any
   reference on it that is already shared.
4. **Moderation message.** After a share, the desktop never says "now shared
   publicly" unless it confirmed the row is served and not hidden.

## Findings

- **What reaches the public today:** contributions are served by
  `search_public_reference_contributions` and
  `get_public_reference_contribution`, with an envelope from
  `private.shared_reference_contribution_envelope`
  (`20260930224506_…:394-473`). The envelope carries no role.
  - **Consumers:**
    - the landing species page (`CuratedReferencesSection`, `SpeciesPage`);
    - the landing compare tray (`compareTray.ts`, via
      `getPublicReferenceContribution`);
    - the desktop catalogue and fork dialog (`curated_reference_forks.py`).
- **Exact keys:** both landing (`normalizeShared`, `SHARED_KEYS`) and desktop
  (`normalize_curated_bundle`, `_SHARED_KEYS`) accept only exact keys, so an
  added envelope field would make old clients drop or reject rows.
- **Observation references** already carry the role per use (`'role',u.role`,
  `20260930224506:1092`), and landing labels it in all four locales.
- **Publishing makes shared references public.** Making an observation public
  and not a draft can turn its uses into qualifying uses. A reference that
  already has a consented, shared contribution for that set and species then
  appears on the observation, with its role, straight away
  (`search_public_observation_references`, `:1046-1140`).

## Design

### One "is served" check

A private helper, `private.reference_contribution_is_served(contribution_id)`,
holds the served-contribution filter. Its conditions:
- `status = 'shared'` with consent set;
- `hidden_at IS NULL`;
- an owner that isn't NULL, banned, deleted or blocked with the caller;
- the current revision exists and is `>= consent_first_revision`;
- the 1 MiB envelope cap (`:946-951`).

The `_v2` reads call it, and so does the shared-row path of today's reads
before they are restricted, so the reads can't drift apart.

In `get_public_reference_contribution_unthrottled` (`20260930224506:972-1037`)
it gates **only the shared-row path**. These stay exactly as they are:
- the **withdrawn tombstone stub**, including for rows whose `owner_id` is
  now NULL;
- serving a **requested revision** from the current consent period, with the
  1 MiB cap applied to that revision.

The helper must not change any of today's read behaviour. In particular,
search keeps applying its 1 MiB cap across the **whole page**, not per row.
All existing read tests pass unchanged.

Replacing those two read functions is allowed: they aren't on the
`20260914090000` must-not-replace list.

### Roles: versioned reads that carry them (the version gate)

Owner decision (2026-10-01): enforce that no client without labels can list a
shared contribution. Today no request carries the client's version, so the
gate is the **RPC version** instead.

- **`private.reference_contribution_public_roles(contribution_id) → text[]`:**
  the sorted distinct roles of the owner's uses that
  `search_public_observation_references` would serve for that contribution.
  That means the same qualifying-use predicate **and** the same content proof
  against a consented revision. A use the public can't see never contributes
  a role.
- **New reads:** `public.search_public_reference_contributions_v2` and
  `public.get_public_reference_contribution_v2`.
  - Same arguments, filters and limits as today.
  - Each served shared row gains `relationship_roles` (text[]), derived live
    at request time from the helper.
  - A served row with no visible use returns `relationship_roles = []`, and
    clients show no relationship label for it.
  - Tombstones and in-period historical revisions in `get_v2` behave exactly
    as in today's `get`.
  - Rate-limited, VOLATILE SECURITY DEFINER wrappers around `_unthrottled`
    bodies, as in `20260830193144`. Execute granted to anon and authenticated
    only.
- **Today's reads** (`search_public_reference_contributions`,
  `get_public_reference_contribution`) **stop serving shared envelopes**:
  - search returns no shared rows;
  - get still returns the withdrawn tombstone stub, but never a shared
    envelope or historical revision.

  So the released desktop v0.9.24 and older builds, and any old cached
  landing bundle, list no shared contributions, never unlabelled ones. Curated
  publications served by other functions are unaffected.
- **Exact keys:** the `relationship_roles` key exists only in `_v2`, so old
  clients never receive a key they don't know. New clients add it to their
  exact-key sets for `_v2` rows only.
- **Live:** changing a role publishes no new revision and doesn't touch
  `consent_scope`.
- **Cost:** no extra request, since roles come inline.

### Label rule (landing and desktop)

- **One label per role present**, joined: "Supports · Contradicts" in that
  order, then "Compared". Whenever `contradicts` is present, it is shown
  prominently, for example as a badge.
- **Empty `relationship_roles`:** no relationship label, never "supports".
- **Locales:** landing no, sv, en and de; web en, nb_NO, sv_SE and de_DE;
  desktop nb_NO, sv_SE and de_DE.

### Landing

- Switch the species page and the compare tray to the `_v2` reads, parse
  `relationship_roles`, and apply the label rule.
- Tests:
  - a contradicting fixture and a mixed one;
  - empty roles;
  - the compare tray;
  - all four locales type-check.

### Desktop (commits on the PR #7 branch)

- **Consent dialog:** for a `contradicts` use, the warning says it is
  published publicly, under the owner's name, for the observation's species,
  **marked as contradicting the identification**.
- **Catalogue and fork dialog (required):** switch to the `_v2` reads, parse
  `relationship_roles`, and apply the label rule. Update `utils/cloud_sync.py`
  and its allowlists accordingly, and add the `_v2` names and signatures to
  `tests/test_stage6l_cross_repository_contract.py`.
- **Moderation message:** the follow-up check runs after `created`,
  `updated` and `no_change`. It returns *unknown* in these cases:
  - the list call throws or returns `rate_limited` or another non-ok status;
  - the contribution id is missing from the result, or from the listing.

  For unknown the text is "Shared. Sporely couldn't confirm whether it's
  visible yet; see My shared references." Only a confirmed served, non-hidden
  row gets "now shared publicly".

### Publish notice (web and desktop)

**Trigger:** any change that makes an observation public and not a draft,
whether a draft becomes published while public, or a published observation's
visibility changes to public. Every such path is covered, or explicitly
excluded with a reason:
- web `src/screens/find_detail.js` `_save()` (`#detail-draft`, visibility);
- web `src/screens/review.js`, both `#review-draft` (~452) and
  `#review-draft-card` (~1466);
- web `src/screens/import_review.js` `.import-draft-checkbox` (~2087);
- desktop `ui/observations_tab.py` `is_draft_checkbox` and the visibility
  control;
- desktop `ui/cloud_conflict_dialog.py`, where resolving `is_draft` or
  visibility toward public is a publish (~189).

Android runs the same web code. The implementer searches for further paths
and lists them in the report.

**Before writing the text,** the implementer records the verified public
exposure for each combination of visibility, `location_precision` and
`spore_data_visibility`, citing the server read functions. It covers:
- exact versus fuzzed location, GPS fields, the location, habitat and notes
  text;
- photos, claiming EXIF stripping only where `storage_exif_safe` is enforced
  server-side;
- spore data;
- AI identification fields;
- comments.

**The notice states:**
- what becomes public under the chosen settings;
- that references attached to the observation stay private unless shared one
  by one with **Share publicly…**;
- that **any attached reference you have already shared** will appear on this
  observation, with how you use it;
- on desktop, that the change takes effect after the next sync.

The "already shared" fact comes from the owner's own
`list_my_shared_reference_contributions`, matched against the observation's
attached sets and the species **as it will be after this save**. Candidate 1
therefore adds `source_measurement_set_id` to that list's output; it is the
owner's own data. Before shipping, check that the 2b desktop list parser
tolerates the extra key.
- If the lookup fails or returns `rate_limited`, the notice still shows a
  cautious line: "References you have shared may appear on this observation."
- The line is never simply left out.

**Behaviour:** a confirmation with Publish/Cancel. Cancel keeps the previous
state. It is shown on every such change; no "don't show again".

**Tests:**
- shown exactly on the publishing transitions;
- Cancel keeps the state;
- the already-shared line appears only when it applies; a failed or
  rate-limited lookup shows the cautious line; a species change in the same
  save is matched;
- the text matches the verified exposure.

### Consent text

v1 has never been active. A new migration edits it in place:
1. Lock the texts, contribution and event tables.
2. Guard: abort unless v1 is inactive and not revoked in both locales, and
   no contribution or event references version 1.
3. `UPDATE` text and `text_sha256` for exactly 2 rows (en, nb) and assert the
   count. `scope` stays unchanged.

The added wording, in en and nb:
- wherever your shared reference is listed publicly, it is marked with how
  you use it on your public observations of the species (compared, supports
  or contradicts the identification);
- the label combines all of them and updates when you change how you use the
  reference.

## Candidates and order

1. **Server** (sporely-web):
   - the "is served" helper and the public-roles helper;
   - the `_v2` reads;
   - today's reads restricted to tombstones;
   - `source_measurement_set_id` in the owner list;
   - the v1 text edit.

   Deployed via the deploy tree, with general and security review. There are
   0 shared contributions now, so restricting today's reads changes nothing
   visible.
2. **Landing:** `_v2` reads and labels on the species page and compare tray,
   after 1.
3. **Desktop** (PR #7 branch): the contradicts wording, required catalogue
   and fork labels, the moderation message and the publish notice.
4. **Web publish notice** (sporely-web `src/`): all web paths above.

Candidates 3 and 4 also get a security review of the publish notice text
against the verified exposure.

## Tests (server)

- **Served check:** the `_v2` reads agree with the served check on served
  versus unserved for each case: hidden, withdrawn, owner NULL, banned,
  deleted, blocked, a pre-consent current revision, and an oversize envelope.
- **Unchanged in `get`:** the withdrawn tombstone stub, including owner NULL,
  and an in-period historical revision are served exactly as before.
- **Roles:**
  - only uses `search_public_observation_references` serves contribute;
  - a use whose snapshot fails the content proof contributes nothing;
  - private, draft, private-spore-data, deleted and other-taxon uses
    contribute nothing;
  - a served contribution with no visible use returns `[]`.
- **`_v2` reads:** they return exactly today's filters, limits and page cap,
  plus `relationship_roles`, and tombstones and in-period revisions in
  `get_v2` are unchanged. The rate limit applies, and anon can call them.
- **Restricted reads:** today's search returns no shared rows, and today's
  get returns tombstones only, never a shared envelope or revision.
- **Execution surface:** no client role can execute the `_unthrottled`
  bodies or either helper.
- **Text edit:** it aborts when v1 is active, revoked or referenced; exactly
  2 rows change; `scope` is unchanged; `text_sha256` matches.

## Activation gate (owner)

Consent text v1 is activated only when all of these hold:
- candidate 1 is deployed, and its general and security reviews are
  accepted;
- the landing labels are deployed and verified in production;
- the web publish notice is deployed;
- the desktop release that includes candidate 3 exists (catalogue and fork
  labels through `_v2`, and the publish notice). Older desktops list no
  shared contributions because today's reads are restricted;
- the owner has re-read and approved the final en and nb wording, and the
  production `text_sha256` of each matches that approved text;
- the owner's manual checks pass (the PR #7 list: unavailable state, a real
  share, draft refusal, private refusal, contradicts labelled, Stop sharing,
  en/nb wording and sv/de display).

## Rollback

- **Server:** disable the `_v2` reads. Every client then lists no shared
  contributions, which fails closed. Never re-open today's reads to shared
  envelopes while any shared contribution exists. Revert the v1 text with a
  new migration; it is still inactive.
- **Clients:** revert normally. Without labels, the activation gate is not
  met.
