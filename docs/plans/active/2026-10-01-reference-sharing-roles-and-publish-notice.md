# Stage 2c: contradicting references and the publish notice

Status: proposed, not started. Follows Stage 2
(`docs/plans/active/2026-09-30-reference-sharing-consent.md`). Consent text v1
stays inactive throughout. Activation is a separate owner decision after the
owner re-reads the final en and nb wording. Desktop PR #7 (sporely-py) stays
unmerged until the owner's manual checks pass.

## Owner decisions (2026-10-01)

1. **Contradicting references stay shareable.** There is no server-side
   refusal. A contradicting reference can be scientifically valuable: it can
   point to incorrect published data, an anomalous specimen, or a
   misidentified or unknown specimen.
2. **The relationship is never hidden.** A contribution shows **every** role
   its owner's qualifying uses have for that species. Wherever shared
   contributions are listed publicly, it is labelled "Contradicts" whenever
   any qualifying use contradicts, so it is never presented as supporting the
   identification.
3. **A publish notice in web and desktop.** When an owner switches an
   observation from draft to published, a short notice says what becomes
   public, and that attached references stay private unless shared one by
   one.
4. **Moderation message.** After a share, the desktop never says "now shared
   publicly" unless it confirmed the row isn't hidden by moderation.

## Findings

- **What reaches the public today:** contributions reach the public through
  `search_public_reference_contributions` and
  `get_public_reference_contribution`. The envelope is built by
  `private.shared_reference_contribution_envelope`
  (`supabase/migrations/20260930224506_…:394-473`).
  - **No role:** it carries no role.
  - **Consumers:** the landing species page (`CuratedReferencesSection`,
    `SpeciesPage`) and the desktop catalogue and fork dialog
    (`sporely-py/database/curated_reference_forks.py`).
- **Observation references** already carry the role per use
  (`search_public_observation_references`, `'role', u.role`), and landing
  labels it ("Contradicts", "Supports identification").
- **Exact-key validation:** both contribution consumers validate rows by
  **exact keys**:
  - landing: `publicCuratedReferences.ts` `SHARED_KEYS`, `hasExactPublicKeys`;
  - desktop: `curated_reference_forks.py` `_SHARED_KEYS`, `_exact_mapping`.

  Adding a field to the envelope would make every client that hasn't updated
  **drop the whole row**.
- **Roles change freely:** a role belongs to a use, and owners can change it
  at any time. It isn't part of `consent_scope`, which covers data kinds.

## Design

### Roles: a separate read RPC, derived live

- **Envelope and stored revisions stay unchanged.** No new field, so old
  landing and desktop builds keep parsing every row.
- **New helper:** `private.reference_qualifying_use_roles(owner, set, taxon)
  RETURNS text[]`. It returns the sorted distinct roles of exactly the uses
  `private.reference_qualifying_use_ids` returns: the same qualifying-use
  predicate and filters (live use, live source, public non-draft observation
  with public spore data, exact taxon). Postgres-owned, `search_path = ''`,
  `REVOKE ALL` from every client role.
- **New public RPC:**
  `public.search_public_reference_contribution_relationships(p_contribution_ids uuid[])
  → jsonb[{contribution_id, roles}]`.
  - Anon and authenticated, rate-limited through
    `consume_shared_reference_request` like the other public reads.
  - It returns entries only for contributions the public reads would serve:
    `status = 'shared'`, consented, `hidden_at IS NULL`, owner not banned or
    deleted, not blocked with the caller. An id that isn't served returns
    nothing, so the RPC reveals nothing about hidden or withdrawn rows.
  - Input is bounded to at most 100 ids.
- **Live derivation:** roles are derived at request time, so changing a use's
  role publishes no new revision and never interacts with `consent_scope`.
- **Not touched:** none of the functions the deferred `20260914090000`
  redefines.

### Landing

- **Fetching:** the species page fetches relationships for the contributions
  it shows. A missing entry or a failed call shows **no** relationship label,
  never "supports".
- **Labels:**
  - "Contradicts the identification" when `roles` contains `contradicts`;
  - otherwise "Supports the identification" when it contains
    `supports_identification`;
  - otherwise "Compared".
  - Mixed roles show every one, for example "Supports · Contradicts".

  en and nb strings.
- **Tests:** a contradicting fixture, a mixed fixture, the missing or failed
  relationship call, and a missing entry for a hidden or withdrawn id.

### Desktop (on the PR #7 branch)

- **Consent dialog:** when the use's role is `contradicts`, the warning says
  the reference is published publicly, under the owner's name, for the
  observation's species, **marked as contradicting the identification**.
- **Moderation message:** `_is_hidden` returns "unknown" when it couldn't
  confirm. The result then says "Shared. Sporely couldn't confirm whether
  it's visible yet; see My shared references." It never gives the
  unqualified "now shared publicly".
- **Catalogue and fork dialog:** fetch relationships and show the same labels
  as landing. Optional; recommended if cheap.

### Publish notice (web and desktop)

- **Where:**
  - web `src/screens/find_detail.js` `_save()`, when `#detail-draft` goes
    from checked to unchecked;
  - web `src/screens/review.js`, the capture-time publish when the draft card
    is unchecked;
  - desktop `ui/observations_tab.py` `is_draft_checkbox` save path.
- **What it says:** before writing the text, the implementer **verifies the
  actual public exposure server-side**: the public observation reads, photo
  and media projections, location precision, `spore_data_visibility`,
  identification and AI fields, comments. The text must not be inferred from
  the edit form. It then states, briefly:
  - what becomes public, for this visibility setting;
  - that attached references stay private unless shared one by one with
    **Share publicly…**.
- **Behaviour:** a confirmation with Publish/Cancel. Cancel keeps the draft.
  It is shown on every draft-to-published switch; no "don't show again" in
  this stage. en and nb strings in web; nb_NO, sv_SE and de_DE in desktop.
- **Tests:** shown only on that transition; Cancel keeps the draft; the text
  matches the verified exposure.

### Consent text

v1 has never been active, so no grant can have used it. A new migration
edits v1 **in place**:
- `UPDATE … SET text, text_sha256 WHERE version = 1 AND NOT active AND NOT
  revoked`;
- a guard first that aborts if any contribution or event references version
  1, or if v1 is active.

The change adds, in en and nb, that wherever shared references are listed
publicly, the reference is marked with how you use it (compared, supports or
contradicts the identification), and that a contradicting reference is shown
as contradicting. A new version 2 would only be needed after activation.

## Candidates and order

1. **Server** (sporely-web): `reference_qualifying_use_roles`, the
   relationships RPC with rate limit, and the v1 text edit. It is additive,
   so old clients are unaffected. Deploy via the deploy tree.
2. **Landing:** relationship labels. Ships after 1.
3. **Desktop:** commits on the PR #7 branch for the contradicts wording, the
   moderation message, optional catalogue labels and the publish notice.
4. **Web publish notice** (sporely-web `src/`): independent of 1–3.

Each candidate gets a general review. Candidate 1 also gets a security
review: the new public RPC must not reveal anything about non-served
contributions or non-qualifying uses.

**Activation gate (owner):**
- 1 and 2 are deployed;
- the desktop release that includes 3 exists, or the owner accepts that
  older desktop catalogues show contradicting contributions without a label;
- the owner has re-read and approved the final v1 wording.

## Tests (server)

- **Roles:** the helper returns exactly the roles of qualifying uses, ignoring
  private, draft, private-spore-data, deleted and other-taxon uses.
- **Relationships RPC:**
  - returns roles only for served contributions;
  - returns nothing for hidden, withdrawn, banned-owner, deleted-owner and
    blocked-owner ones;
  - enforces the 100-id bound and the rate limit;
  - anon can call it.
- **Execution surface:** no client role can execute the helper.
- **Text edit:** the v1 edit aborts when v1 is active or referenced, and
  `text_sha256` matches the text.

## Rollback

- **Server:** drop or disable the relationships RPC. Landing and desktop then
  show no labels, never "supports". Revert the v1 text with a new migration;
  it is still inactive.
- **Clients:** revert normally.
