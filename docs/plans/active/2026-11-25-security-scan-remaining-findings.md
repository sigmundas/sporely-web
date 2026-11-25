# Remaining findings from the 2026-11-25 security scan

Status: written 2026-11-25 as a handoff. Package A is implemented on branch
`fix/blocking-comment-privacy` (migration `20261125230000`), not yet merged or
deployed. Nothing else is implemented. Update this line when a work package
lands; move the file to `completed/` when the list is empty.

Written for an agent that has not seen the session that produced it.

## Where this comes from

On 2026-11-25 the whole repository was scanned at `703fe99` by Claude (own
pass plus two read-only scouts for the database and the client) and, in
parallel, by a Codex challenge review. Every finding was checked against the
code, and several against production with read-only aggregate queries.

Shipped from that scan:

| PR | Merged as | What |
|---|---|---|
| #69 | `9f44459` | Escaped AI provider status text in the review screens, `/.well-known/security.txt`, HSTS on `app.sporely.no` |
| #70 | `5374aab` | Migration `20261125210000`: an unfinished profile has no public name in five functions; friends list keeps a row for a friend without a public profile |

`20261125210000` is applied to production (remote head on 2026-11-25).

This file overlaps with the "Open findings from the November 2026 agent
security review" block in `INBOX.md` (2026-11-20). Where an item is in both,
it says so; do not fix it twice.

## How to work on these

- Read `AGENTS.md` first. Production is read-only by default. A worker
  deploy, an edge-function deploy and a migration push are all production
  writes: present the exact command and wait for the owner's explicit yes.
- Branch from `origin/main` (`git switch --no-track -c <branch> refs/remotes/origin/main`),
  one commit per concern, push, open a PR, wait for CI.
- Review before merge: `/codex:review` on the branch; `/codex:challenge` and
  the `sporely-security-reviewer` agent for anything touching RLS, auth,
  storage, privacy, moderation or deletion. Verify each finding against the
  code. On PR #70 both reviewers found three further paths the first commit
  missed, so do not skip this.
- Tests:
  - Node: `node --test $(git ls-files '*.test.js' '*.test.mjs')`.
  - SQL: `supabase db reset --local`, then `psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 -f supabase/tests/<file>.sql`
    (password `postgres`). Tests are `BEGIN … ROLLBACK` DO blocks.
  - Baseline on a fresh local database at `5374aab`: 88 of 91 SQL files pass.
    `public_observation_spore_previews_eval_count_test.sql` and
    `…_order_test.sql` need pgTAP (`supabase test db`).
    `public_observation_point_prep_test.sql` fails on "image C point should
    have all prep keys stripped"; that failure predates the scan and is worth
    its own look. `ingestion_location_provenance_test.sql` passes once but is
    not re-runnable on the same database.
  - For every new test, show it fails against the unfixed code (restore the
    old definition inside a rolled-back transaction, or revert the hunk).
- Migrations: follow "Required workflow for a new migration" in `AGENTS.md`.
  While `supabase/deploy-exceptions.json` lists a deferred migration, deploy
  only through `node scripts/supabase-deploy-tree.mjs prepare --allow <version> --ref origin/main`,
  then `check`, then `supabase db push --linked` inside the deploy tree, then
  `post-verify`, then remove the tree. Merge the PR before deploying when the
  client has to ship first.
- A new SQL test fixture profile is unfinished unless it sets
  `profile_completed_at`; since `20261125210000` an unfinished profile has no
  public name, so tests that assert a name must set it.
- Branch previews (`*.pages.dev`) cannot sign in. Signed-in checks need
  localhost, which uses the production database.
- Each work package is done when it is merged, deployed, and checked in
  production with a read-only smoke test. Then stop and report: deployed
  commit, what was verified, what was not.
- The repository is public. Keep exploit detail out of PR text until the fix
  is deployed.

## Owner-only actions (not agent work)

- Cloudflare account: turn on 2FA. This account controls DNS, R2 and the
  worker that holds the Supabase service-role key.
- Cloudflare zone `sporely.no`: enable HSTS with include-subdomains and
  "Always Use HTTPS". On 2026-11-25 `media.sporely.no`, `upload.sporely.no`
  and the apex still answered plain HTTP without redirecting, and `media`,
  `upload` and `admin` sent no HSTS. `upload` receives sign-in tokens.
- DMARC is `p=none`. A Resend DKIM record (`resend._domainkey`) and SES SPF on
  `send.sporely.no` are published. Check the DMARC reports for aligned
  passes, then move to `p=quarantine`, later `p=reject`.
- Confirm `contact@sporely.no` is read; `security.txt` points at it and
  expires 2027-11-25.
- `sporely.no` (landing repo) still answers `/.well-known/security.txt` with
  an HTML page and status 200.
- `admin.sporely.no` (other repo) sends no CSP and no framing protection.

## Work packages

Suggested order. Severity is the scan's judgement, not a measured risk.
Line numbers are as of `5374aab`; trust the function name over the number.

### A. Blocking and comment privacy (one migration, small)

1. **A blocked user can list who blocked them.** Production policy on
   `user_blocks`: `auth.uid() = blocker_id OR auth.uid() = blocked_id`.
   Fix: SELECT for the blocker only. Check `is_blocked_between` and
   `current_user_is_blocked_with` are SECURITY DEFINER first, because the
   blocked side must still be filtered. Production had 0 blocks.
2. **The `comments` base table skips the view's filters.** Policy
   `phase7_comments_read` (`20260812120000`) checks observation access and
   moderation only; `comments_community_view` also filters banned authors and
   block pairs. A direct table read returns those comments. Fix: add both
   predicates to the policy; test both read paths on one friends-only thread.
3. **Friend requests ignore blocks and bans.** Insert policy in
   `20261118120000`. Also in `INBOX.md`. Reported by the database scout; not
   re-verified line by line.
4. **A rejected image or mosaic insert names the owner of any observation
   id**, including private and draft ones. `_media_get_observation_user_id`
   callers in `20260804120000` (image trigger) and `20261011100000` (mosaic
   trigger) raise different errors for "missing" and "owned by someone else",
   the second with the owner's id. Fix: one error and SQLSTATE for every
   inaccessible parent.
5. **`observations_follow_view` lost `security_barrier`.** Confirmed in
   production (`reloptions` is null). `20261001195524` re-created the view
   without the `WITH` clause that `20260809120000` set. Fix: restore it.
6. **Comment inserts accept a client-chosen `id` and `created_at`.**
   `20261119130000` restricted UPDATE only. Fix: `GENERATED ALWAYS` id and a
   column-level INSERT grant. Scout-reported; verify before changing.

Outcome of A (2026-11-25, reviewed by a Codex challenge and the
`sporely-security-reviewer` agent; `block_and_comment_privacy_test.sql`):
all six items are closed as written, plus: self-blocks are refused, anon has
no privileges on `comments` or `user_blocks`, and `comments_id_seq` is
`USAGE` for authenticated only. Left open, each worth its own change:

- **Block status is still testable for one known user id.** The RLS helpers
  are public RPCs: `current_user_is_blocked_with`, `can_read_observation`, and
  the two added by A (`comment_author_is_visible`, `can_befriend`) answer
  "blocked either way or banned". Listing every blocker is closed; testing a
  known id is not. Bidirectional filtering also shows a block by design.
  Fix: move all RLS helpers to a schema PostgREST does not expose, granting
  `USAGE` and `EXECUTE` to the roles whose policies call them.
- **Blocking does not end friendships.** No trigger on `user_blocks`. An
  accepted friendship stays accepted (every current `are_friends` caller
  checks blocks first, so nothing leaks today) and comes back after an
  unblock; a pending request from the blocker stays visible to the blocked
  user, and accepting it now fails with an RLS error. Fix (deletes data; owner
  decision): an AFTER INSERT trigger on `user_blocks` that deletes the pair's
  `friendships` rows.
- **Landing comment edits always fail.** `updateOwnComment` in
  `sporely-landing/src/lib/communityApi.ts` sends `mentioned_user_ids`, but
  only `body` is updatable since `20261119130000`. Fix in the landing repo:
  send only `body`.
- `observation_shares: owner full` checks `owner_id` only, so a user can
  create a share row for someone else's observation id. Nothing reads shares
  for access today; check before relying on them.
- `reports` INSERT checks only the reporter, so a report against an existing
  private observation succeeds where a missing id fails its foreign key. Ids
  are sequential, so this tells little.
- A banned user can no longer edit or delete their own comments (the read
  policy applies to UPDATE/DELETE). Consistent with B.

### B. Bans stop writes

Bans only hide content. The only ban trigger in production is
`trg_profile_ban_media_version_bump`; `SUPABASE_DB.md` (about line 309)
claims a write-blocking trigger that does not exist. The upload worker does
refuse banned users. A banned user can still insert observations, comments,
friend requests, follows and reports. Fix: the trigger, or an `is_banned`
check in the insert policies, and correct the doc. Production had 0 banned
users.

### C. Upload worker (`cloudflare/r2-upload-worker/src/index.js`; needs a worker deploy)

1. **Account deletion leaves media behind.** `delete-account/plan.js` builds
   its R2 worklist only from database rows. In legacy mode an upload needs no
   `observation_images` row, a second device can upload after the snapshot,
   and a token that is still valid after deletion can keep uploading
   (`fetchStorageProfile` returns null for a missing profile and the upload
   proceeds). Fix: refuse uploads without a profile row, and end deletion
   with a sweep of the user's key prefix in every configured bucket through
   an authenticated route that only touches the caller's own prefix. Keep it
   retryable; `INBOX.md` separately notes deletion is not resumable.
2. **A failed overwrite loses both copies in legacy mode.** `handleUpload`
   uses the temp-key path only when `canonicalBucket === 'private'`. In legacy
   mode it writes straight to the key; if `applyStorageDelta` then fails,
   `rollbackWrittenBytesOnly` deletes that key. Fix: use the temp-key path in
   legacy mode too.
3. **Free storage is unlimited and accepts any bytes.**
   `FREE_STORAGE_QUOTA_BYTES = "0"` in `wrangler.toml`,
   `profiles.storage_quota_bytes` is nullable, there is no rate limit, and
   `normalizeUploadContentType` accepts `application/octet-stream`. Any
   signed-up user can host files on `media.sporely.no`. The live worker
   variables were not checked. Fix: a free quota, a Cloudflare rate-limit
   rule on `PUT upload.sporely.no`, and decide whether octet-stream is still
   needed for desktop originals. `INBOX.md` notes parallel uploads can exceed
   a quota once one exists.
4. **Open proxies.** `/reverse-location` needs no sign-in and `/artsorakel`
   relays any body for any signed-in user with Sporely's token. Neither is
   rate-limited.

### D. Moderation hold

`hide_reported_observation` in `supabase/functions/admin-ops/adminActions.ts`
sets `visibility` and `spore_data_visibility` to `private`. Both are
owner-editable, and observations have no moderation column, so the owner can
republish at once. Fix: a moderator-only hold on the observation, enforced in
the community views, the public RPCs and `media_authorize_delivery`. Touches
the admin repo's UI.

### E. Stripe delayed payments

`handleCheckoutSessionCompleted` in
`supabase/functions/stripe-webhook/entitlement.js` ignores a session whose
`payment_status` is not `paid`, and `index.ts` has no case for
`checkout.session.async_payment_succeeded`, so a delayed method that settles
later never grants Pro. Only matters if the Stripe account offers delayed
methods; check that first. Fix: route that event through the same handler
and subscribe the webhook to it. `INBOX.md` also lists the one
`billing_payment_id` per profile limit.

### F. Client hardening (web and Android; no backend)

1. **The Android app has no CSP.** `index.html` has no CSP meta tag and
   `public/_headers` applies only on Cloudflare Pages. Fix: a meta tag that
   matches the header policy. Test sign-in, Turnstile, maps and media on a
   device.
2. `android:allowBackup="true"` with no extraction rules
   (`AndroidManifest.xml`), so the refresh token in WebView storage may be
   backed up. Fix: `allowBackup="false"` or rules that exclude `app_webview`
   and shared prefs.
3. `esc()` in `src/esc.js` does not escape `'`. No single-quoted attribute
   sink uses it today.
4. Taxon search results interpolate `r.displayName` and `r.family` unescaped
   (`src/screens/find_detail.js` about line 4527, `src/screens/review.js`
   about line 1587). The source is the curated taxonomy RPC.
5. `avatar_url` is free text with no database constraint and is rendered as
   an image source to other users. Fix: constrain it to the avatars bucket or
   derive it from the user id; narrow `img-src` from `https://*.supabase.co`
   to the project host.
6. Web CSP still allows `'unsafe-inline'` scripts (also in `INBOX.md`); the
   Report-Only line duplicates the enforced policy.
7. The hosted Turnstile page allows framing from `http://localhost`
   (`public/_headers`); drop it once every shipped build uses https.
8. `WRITE_EXTERNAL_STORAGE` has no `maxSdkVersion`, and `file_paths.xml`
   exposes more than `native-camera/`. Scout-reported.

### G. Private media cutover (the existing Stage 2 programme)

`MEDIA_STORAGE_MODE = "legacy"`: every object is public at
`media.sporely.no/<key>` with a one-year immutable cache, so a URL keeps
working after an observation goes private. Design and status are in
`docs/security/stage-2-media-authorization.md`; this is that plan's work, not
a new one. Facts from this scan:

- 3,941 live image rows still have the old time-based key
  (`<user>/<observation>/<n>_<timestamp>.<ext>`). Keys are random since
  `1ab1a16` (2026-10-01).
- `private.public_observation_spore_mosaic_raw` (`20261012100000`) still
  returns `https://media.sporely.no/<storage_key>` as `sporeMosaic.url` to
  signed-out callers. `src/screens/find_detail.js` (about line 1162) reads
  `mosaic.url`, so the client must switch to `mosaicMediaUrl` before the
  field is dropped.
- `search_public_observation_images` returns a full-size worker URL even when
  `storage_exif_safe` is false, so GPS in a photo could defeat a fuzzed
  location. `src/publish-notice.js` already warns about it. In production 2
  public images were unverified and none belonged to a fuzzed observation.
- `media.sporely.no` sends no `nosniff` (also in `INBOX.md`).

### H. Admin purge race

`purgeSingleTombstoneRow` in `admin-ops/adminActions.ts` deletes the R2
objects of a tombstone selected at the start of the batch; an owner restore
(`20260717120000`) that lands in between loses its image, because
`finalize_observation_image_purge` checks only `purged_at`. Narrow window.
Fix: claim the row atomically before touching R2.

### I. Smaller hardening (batch when convenient)

- GitHub Actions are pinned by tag, not by commit; `release-android.yml`
  handles the signing key.
- `stripe-webhook`, `create-pro-checkout` and `delete-account` import
  `npm:stripe@16` and `jsr:@supabase/supabase-js@2` unpinned and have no
  lock file.
- `handle_new_user()` still seeds `username` from the email local part. It is
  no longer public before setup, but 33 finished profiles kept it. Consider
  a neutral seed and an explicit choice in setup.
- `profile_completed_at` is writable by the owner (also in `INBOX.md`).
  Acceptable for visibility; it only publishes or hides yourself.
- Reported by the database scout and not re-verified: 19 media functions
  declare `search_path = 'public,pg_catalog'` as one quoted name; the image
  key guard checks the user prefix but not `.` / `..` segments; baseline
  `GRANT ALL` to `anon` remains on some tables; `search_community_spore_datasets`
  has no upper bound on `p_limit`; `can_see_exact_observation_location` is
  unused and executable by PUBLIC.
- Pending friend requests fall back to the raw user id as the name
  (`src/screens/profile.js` `_loadPending`, `src/screens/home.js` about line
  744); the friends and blocked lists use "Unknown · <id start>".

## Checked and found sound (do not redo)

- No secrets in tracked files or git history; `npm audit` clean for
  production dependencies; secret scanning and push protection are on.
- The worker's JWT verification, the Stripe signature check, the admin gate
  (`is_admin` is not self-grantable since `20261118120000`), RLS enabled on
  every public table.
- No stored XSS from another user's content: comments, names, bios,
  locations and map popups are escaped.
- OAuth consent, native OAuth and the Turnstile bridge validate origin, state
  and client id.

## Not verified

- Storage bucket policies for `avatars` and `observation-images` are not in
  the migrations.
- Live worker variables and secrets (only `wrangler.toml` was read).
- Whether dynamic OAuth client registration is enabled in Supabase.
- What Android Auto Backup actually includes on current devices.
