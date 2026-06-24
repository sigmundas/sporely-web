# Sporely Draft / Publish State and Find Filter Plan

This plan separates **workflow state** from **visibility**.

- `is_draft` answers: “Is this observation unfinished?”
- `visibility` answers: “Who may see this after it is published?” (`private`, `friends`, `public`)
- `location_precision` answers: “Is the location exact or protected/fuzzed?”
- Privacy slots apply to deliberate protected **published** observations, not ordinary drafts.
- Drafts are owner-only by effect, but they are not the same thing as `visibility = 'private'`.

## Product rules

### Draft behavior

A draft is only visible to the owner, regardless of its selected visibility.

Examples:

| State | Visibility | Meaning |
|---|---|---|
| Draft | Public | Owner-only for now; becomes public when published |
| Draft | Friends | Owner-only for now; becomes friends-visible when published |
| Draft | Private | Owner-only for now; remains private when published |
| Published | Public | Visible in public feed/community views |
| Published | Friends | Visible to accepted friends |
| Published | Private | Owner-only, intentional private published observation |

Drafts should not count toward the free-tier privacy slot cap. They should still count toward cloud media/storage quota.

### Old and stale drafts

No draft should be auto-deleted or auto-published because of age alone.

Suggested lifecycle:

| Draft age | Label | Behavior |
|---|---|---|
| < 90 days | Draft | Normal draft |
| >= 90 days | Old draft | Gentle reminder in UI |
| >= 180 days | Stale draft | Stronger reminder; these count towards the privacy slot cap of 20 for free tier|

Recommended free-tier rule:

- Free users may keep unlimited local drafts.
- Cloud drafts count toward storage quota.
- Free users may keep up to `20` stale cloud drafts + private observations.
- Pro users are limited by storage/media quota, not stale-draft count.
- Nothing is deleted or published without explicit user action. If a user adds microscope images and spore measures in sporely-py, the syncs to cloud, the Draft label is switched off.

This prevents `Draft` from becoming an unlimited hidden cloud archive while keeping the normal field → microscopy → publish workflow friendly.

### Auto-publish when microscopy is complete

When a draft receives microscopy media and spore data from `sporely-py`, it may automatically become published, but the publish action should be explicit. Do not use a blind Supabase trigger that publishes merely because rows were inserted into `observation_images` or `spore_measurements`.

Use a safety-first rule:

- Auto-publish only if the observation is still a draft.
- Auto-publish only if `auto_publish_when_complete = true`.
- Completion requires:
  - at least one `observation_images` row where `image_type = 'microscope'`
  - at least one valid `spore_measurements` row for the observation
- `sporely-py` should call an explicit publish RPC after image/media and measurement sync has succeeded.
- Supabase should enforce ownership, draft visibility, publish metadata, and privacy-slot limits.
- If the observation would publish as `private`, `friends`, or fuzzed, the privacy-slot trigger must still run.
- If the free-tier privacy slot cap would be exceeded, keep it as draft and show a clear UI message.
- Do not auto-publish stale/old drafts just because they are old.
- Do not auto-publish if the user has explicitly disabled auto-publish for that observation.

Default recommendation:

- New finds are drafts by default.
- Auto-publish may be on by default for public exact-location observations after microscopy completion.
- Protected observations (`private`, `friends`, or fuzzed) should require confirmation or a separate desktop setting before auto-publish, because publishing consumes a privacy slot.
- The Draft popover should explain that microscopy completion can publish the observation using the selected visibility.
- Add a per-observation toggle later if needed: “Publish automatically when microscopy is complete.”

## Database migration plan

### Stage 0 — Inspect current production state

Before writing SQL, confirm the live schema:

- Does `observations.is_draft` already exist?
- Does `observations.published_at` already exist?
- What timestamp columns exist on `observations`? (`created_at`, `updated_at`, etc.)
- What is the exact `spore_measurements` schema and observation foreign key?
- What is the current free-tier privacy-slot trigger/function?
- Which views currently expose observations to friends and public community feeds?
- Which web queries read from `observations`, `observations_friend_view`, and `observations_community_view`?

Important: if `is_draft` is added to a live table, do **not** backfill all existing observations as drafts. Existing cloud observations should usually be treated as published unless an existing draft flag says otherwise.

### Stage 1 — Add/normalize draft columns

Migration target for `observations`:

```sql
alter table public.observations
  add column if not exists is_draft boolean;

alter table public.observations
  add column if not exists draft_started_at timestamptz;

alter table public.observations
  add column if not exists draft_keep_confirmed_at timestamptz;

alter table public.observations
  add column if not exists published_at timestamptz;

alter table public.observations
  add column if not exists auto_publish_when_complete boolean not null default true;

alter table public.observations
  add column if not exists published_reason text;
```

Backfill policy:

```sql
-- If is_draft is newly added, preserve existing observations as published.
update public.observations
set is_draft = false
where is_draft is null;

-- Existing drafts get a draft start date.
update public.observations
set draft_started_at = coalesce(draft_started_at, created_at, now())
where is_draft = true;

-- Existing published observations get a published timestamp.
update public.observations
set published_at = coalesce(published_at, created_at, now())
where is_draft = false;

alter table public.observations
  alter column is_draft set not null;

alter table public.observations
  alter column is_draft set default true;
```

Add constraints:

```sql
alter table public.observations
  add constraint observations_published_reason_check
  check (
    published_reason is null
    or published_reason in ('manual', 'sporely_py_auto_microscopy', 'imported', 'admin')
  );

alter table public.observations
  add constraint observations_draft_published_at_check
  check (
    (is_draft = true and published_at is null)
    or
    (is_draft = false and published_at is not null)
  );
```

If the existing app already writes `is_draft`, preserve compatibility by making the client send explicit values during the migration window.

### Stage 2 — Add lifecycle helper functions

Do not store `old`/`stale` as a column unless you need indexing. It depends on `now()`, so it is better computed in a view/RPC/client.

Example helper:

```sql
create or replace function public.observation_draft_age_state(
  p_is_draft boolean,
  p_draft_started_at timestamptz
)
returns text
language sql
stable
as $$
  select case
    when p_is_draft is distinct from true then 'published'
    when coalesce(p_draft_started_at, now()) <= now() - interval '180 days' then 'stale'
    when coalesce(p_draft_started_at, now()) <= now() - interval '90 days' then 'old'
    else 'active'
  end;
$$;
```

Add an owner-facing view or RPC only if it simplifies the client. For example:

```sql
create or replace view public.my_observations_with_draft_state as
select
  o.*,
  public.observation_draft_age_state(o.is_draft, o.draft_started_at) as draft_age_state
from public.observations o;
```

If using a view, verify RLS behavior. In many cases it is simpler to compute `draft_age_state` in the app from `draft_started_at`.

### Stage 3 — Update privacy-slot enforcement

Current rule documented in the DB notes:

```text
Free accounts are limited to 20 cloud observations that are private or fuzzed
(visibility != 'public' OR location_precision = 'fuzzed')
```

Update the rule to count only published protected observations:

```sql
is_draft = false
and (
  visibility != 'public'
  or location_precision = 'fuzzed'
)
```

Recommended behavior:

- Drafts never consume privacy slots.
- Publishing a private/friends/fuzzed observation consumes a slot.
- If a free user has no slot available, publishing fails and the row remains draft.
- The error message should be specific enough for the client to show: “Private/fuzzed published observations are limited to 20 on Free.”

Also add a stale-draft count function for UI and future enforcement:

```sql
create or replace function public.count_my_stale_cloud_drafts()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.observations o
  where o.user_id = auth.uid()
    and o.is_draft = true
    and coalesce(o.draft_started_at, o.created_at, now()) <= now() - interval '180 days';
$$;
```

Optional enforcement trigger for Free:

- If user is Free and has more than `20` stale cloud drafts, block creation/sync of additional new cloud drafts.
- Do not block editing existing drafts.
- Do not block publishing/deleting drafts, because those are resolution actions.

### Stage 4 — Update visibility views and RLS descriptions

Friend/public views must exclude drafts:

```sql
where o.is_draft = false
```

Apply this to:

- `observations_community_view`
- `observations_friend_view`
- any profile-feed RPC that returns non-owner observations
- any community spore-data RPC that exposes contributor datasets
- any AI identification list/detail RPC or view visible to non-owners

Owner reads still use the base `observations` table and may include drafts.

RLS intent:

- Owner can read/write own drafts.
- Non-owners can never read drafts.
- Non-owners can read published observations only according to `visibility`, friendship, shares, block state, and ban state.
- Comments and images follow the parent observation rule.
- AI ID candidates follow the parent observation rule.
- Spore measurements follow the parent observation rule unless exposed through dedicated community RPCs.

### Stage 5 — Add explicit publish RPC and database guardrails

Do **not** create a blind database trigger that publishes an observation just because microscopy images or `spore_measurements` rows are inserted.

Microscopy data is normally added by `sporely-py`, and desktop sync may be doing a normal user action, a repair sync, a historical backfill, or a conflict resolution. The database cannot reliably infer product intent from row inserts alone. A hidden trigger could unexpectedly expose observations through friend/community views after sync.

Use the database as a gatekeeper, not as the decision-maker.

Responsibility split:

```text
sporely-py decides when a draft is ready to publish.
Supabase enforces ownership, draft visibility, publish metadata, and privacy-slot limits.
The web app shows state, filters, explanatory text, and manual publish actions.
```

Keep an optional helper that checks whether the observation has microscopy content. This is useful for UI, sync preflight, and tests, but it should not publish anything by itself.

```sql
create or replace function public.observation_has_microscopy_complete(p_observation_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1
      from public.observation_images oi
      where oi.observation_id = p_observation_id
        and oi.image_type = 'microscope'
        and coalesce(oi.deleted_at, false) = false
    )
    and exists (
      select 1
      from public.spore_measurements sm
      where sm.observation_id = p_observation_id
    );
$$;
```

Adjust the `deleted_at` predicate if the live schema differs. If `spore_measurements` has a quality/deleted/rejected flag, use only valid active measurements.

Add an explicit publish RPC. The RPC should be callable by the authenticated owner and should perform a normal `observations` update so the privacy-slot trigger still runs.

```sql
create or replace function public.publish_observation(
  p_observation_id bigint,
  p_publish_source text default 'manual',
  p_require_microscopy_complete boolean default false
)
returns table (
  published boolean,
  reason text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_publish_source not in ('manual', 'sporely_py_auto_microscopy') then
    raise exception 'Invalid publish source';
  end if;

  if p_require_microscopy_complete
     and not public.observation_has_microscopy_complete(p_observation_id) then
    return query select false, 'microscopy_not_complete';
    return;
  end if;

  update public.observations o
  set
    is_draft = false,
    published_at = coalesce(o.published_at, now()),
    published_reason = p_publish_source
  where o.id = p_observation_id
    and o.user_id = auth.uid()
    and o.is_draft = true
    and (
      p_publish_source = 'manual'
      or o.auto_publish_when_complete = true
    );

  if found then
    return query select true, 'published';
  else
    return query select false, 'not_draft_not_owner_or_auto_publish_disabled';
  end if;
end;
$$;
```

The existing free-tier privacy-slot trigger should run during the `update public.observations` statement. If publishing a `private`, `friends`, or fuzzed observation would exceed the cap, the update should fail and the client should keep the observation as draft after refetch.

Recommended RPC behavior:

- Manual publish may publish any owner draft, subject to privacy-slot enforcement.
- `sporely_py_auto_microscopy` publish should require microscopy completion.
- Do not auto-revert published observations to draft if microscopy data is later deleted.
- Do not auto-publish because a draft becomes old or stale.
- Do not attach publish triggers to `observation_images` or `spore_measurements`.

If a future web client adds microscopy upload, it should also call the same RPC explicitly after its own upload flow succeeds.

### Stage 6 — Desktop sync owns microscopy auto-publish intent

Update `sporely-py` so the sync layer explicitly publishes a draft only after microscopy data has successfully synced.

Auto-publish candidate:

```text
- local/cloud observation is still a draft
- linked observation belongs to the current authenticated user
- auto_publish_when_complete is true
- sync has no unresolved conflict for that observation
- microscope image metadata/media sync succeeded
- spore measurement sync succeeded
- observation has at least one microscope image and at least one valid spore measurement
```

Recommended sync order:

```text
1. Push or update the observation base row.
2. Push microscope image metadata and upload media.
3. Push spore measurements.
4. Refetch or locally confirm that the cloud observation has the required microscopy content.
5. If eligible, call publish_observation(
     p_observation_id,
     p_publish_source = 'sporely_py_auto_microscopy',
     p_require_microscopy_complete = true
   ).
6. Refetch the observation row and update the local snapshot/local row from the server result.
```

Do not set `is_draft = false` as part of the same payload that uploads measurements. Publishing should be a separate final step after the required sync work has succeeded.

Protected visibility needs extra caution:

```text
Public + exact location:
  May auto-publish when microscopy is complete, if auto-publish is enabled.

Friends/private/fuzzed:
  Should not silently auto-publish by default, because publishing consumes a privacy slot.
  Either require explicit user confirmation, or require a separate desktop preference such as
  “Auto-publish protected observations after microscopy”.
```

If the publish RPC fails because the free privacy-slot cap is reached, keep the row as draft and show a clear desktop sync message:

```text
Microscopy synced. Still draft because publishing this private/fuzzed find requires an available privacy slot.
```

If auto-publish is disabled or the observation is protected and confirmation is required, show:

```text
Microscopy synced. Observation is still draft until you publish it.
```

Update `sporely-py` sync projections and conflict handling:

- Pull/push `is_draft`
- Pull/push `draft_started_at`
- Pull/push `published_at`
- Pull/push `auto_publish_when_complete`
- Pull/push `published_reason` if useful
- Do not overwrite a cloud-published row back to draft from stale local state.
- Treat draft/published divergence as a conflict unless the change came from the current sync run and was confirmed by the publish RPC result.
- Persist the post-publish cloud snapshot after refetch so the next sync does not see its own publish as a conflict.

Add desktop tests for:

- draft with microscope image + spore measurements calls `publish_observation` after successful sync
- failed microscope image upload does not publish
- failed measurement sync does not publish
- public exact-location draft auto-publishes when enabled
- private/friends/fuzzed draft does not silently auto-publish without explicit protected-auto-publish permission
- privacy-slot RPC failure leaves observation as draft and surfaces a useful message
- cloud-published row is not overwritten back to draft by stale local state
- manual draft/published conflict is reported clearly

## UI implementation plan

### Stage 1 — Replace confusing filter pills

Current problem:

- The UI uses similar pill styling for source selection, visibility selection, status filtering, sorting, content filtering, and layout.
- This looks clean but hides meaning.

Recommended visible controls:

```text
Mine / Feed

Scope: All ▼
Status: All ▼
Sort: Date ▼
Spores
[layout icons]
```

Behavior:

- `Mine / Feed` remains a segmented control.
- `Scope` dropdown changes options based on selected source.
- `Status` dropdown uses `All`, `Drafts`, `Published`.
- `Spores` remains a simple toggle filter.
- `Sort` dropdown uses `Date`, `Species`.
- Layout stays icon-only.

### Scope dropdown

For `Mine`:

| Option | Meaning |
|---|---|
| All | My private, friends-visible, and public observations |
| Private | My private observations |
| Friends | My friends-visible observations |
| Public | My public observations |

For `Feed`:

| Option | Meaning |
|---|---|
| All | Followed species + friends + public |
| Followed | Observations matching species I follow |
| Friends | Observations from accepted friends |
| Public | Public community observations |

A forced single-select dropdown is a reasonable V1 because it keeps the UI compact. The limitation is that users cannot select “Followed + Friends but not Public”. To avoid painting the code into a corner, represent the internal filter as an array/set even if the V1 UI only allows one value:

```js
feedScopes: ['followed', 'friends', 'public'] // All
feedScopes: ['friends']                      // Friends
```

That lets you later switch to a multi-select bottom sheet without rewriting the data model.

### Status dropdown

Use the attached style:

```text
Status: Drafts Only ︿
```

Expanded:

```text
FILTER BY PUBLISH STATE

All        Drafts        Published

New finds are drafts by default until microscopy is uploaded.
```

Labels:

- Collapsed `All`: `Status: All`
- Collapsed `Drafts`: `Draft: Drafts Only`
- Collapsed `Published`: `Status: Published`
- Avoid using only `Draft` for the filter, because it sounds like a binary toggle.

### Sort dropdown

Use a small dropdown, not a pill toggle:

```text
Sort: Date ▼
Sort: Species ▼
```

If the date headings disappear when species is selected, consider:

```text
Group: Date ▼
Group: Species ▼
```

But if the list is merely ordered by species while still date-grouped, `Sort` is correct.

### Spores toggle

Keep as a simple toggle.

Suggested label:

- `Spores` if the user base already understands it
- `Microscopy` if you want it to be clearer to new users
- `Has spores` if the filter means actual spore measurements, not microscope photos in general

Recommended V1:

```text
Spores
```

Keep the short existing label, but use popup/help text to clarify.

### Draft label in cards/detail

Observation cards:

- Show a small `DRAFT`, `OLD DRAFT`, or `STALE DRAFT` badge.
- Only show draft badges to the owner.

Find-detail page:

Next to the Draft tag, add an info icon or tap target.

Copy:

```text
Draft
Only visible to you. New finds stay as drafts until microscopy and spore data are added, or until you publish manually.
```

For old draft:

```text
Old draft
Only visible to you. This draft is more than 90 days old. Publish it, keep it as a draft, make it private, or delete it.
```

For stale draft:

```text
Stale draft
Only visible to you. This draft is more than 180 days old. Free accounts may keep a limited number of stale cloud drafts.
```

For draft with auto-publish enabled:

```text
This draft will publish automatically when microscopy images and spore data are added, using the selected visibility.
```

For draft with auto-publish disabled:

```text
Auto-publish is off. This draft will stay private to you until you publish it manually.
```

### Draft detail actions

Add actions in the detail page or Draft popover:

- `Publish now`
- `Keep draft`
- `Make private`
- `Delete`
- Optional: `Auto-publish when microscopy is complete` toggle

For old/stale drafts, the `Keep draft` action should update `draft_keep_confirmed_at`, so the UI can reduce repeated nagging.

## Popup notification copy

These are the short bottom popups after a user taps a filter.

### Status

| Action | Message |
|---|---|
| Status = All | Showing drafts and published finds. |
| Status = Drafts | Showing drafts only. Drafts are visible only to you. |
| Status = Published | Showing published finds only. |
| Draft published manually | Observation published. |
| Auto-published | Microscopy complete — observation published. |
| Auto-publish blocked by cap | Privacy limit reached. Publish as Public or free a private slot. |

### Scope

For Mine:

| Action | Message |
|---|---|
| Scope = All | Showing all your finds. |
| Scope = Private | Showing your private finds. |
| Scope = Friends | Showing finds shared with friends. |
| Scope = Public | Showing your public finds. |

For Feed:

| Action | Message |
|---|---|
| Scope = All | Showing followed species, friends, and public finds. |
| Scope = Followed | Showing finds from species you follow. |
| Scope = Friends | Showing finds from friends. |
| Scope = Public | Showing public finds. |

### Spores and sort

| Action | Message |
|---|---|
| Spores on | Showing finds with spore data. |
| Spores off | Showing finds with and without spore data. |
| Sort = Date | Sorted by date. |
| Sort = Species | Sorted by species. |
| Layout changed | Layout updated. |

## Testing plan

### Database tests

Add tests for:

- Owner can see own active/old/stale drafts.
- Friend cannot see owner draft even if `visibility = 'friends'`.
- Public cannot see owner draft even if `visibility = 'public'`.
- Published public observation appears in community view.
- Published friends observation appears in friend view.
- Draft public observation does not appear in community view.
- Draft friends observation does not appear in friend view.
- Draft private/fuzzed observation does not count toward free privacy slots.
- Publishing private/fuzzed observation consumes a privacy slot.
- Explicit publish RPC succeeds for manual owner publish.
- Explicit publish RPC with `p_require_microscopy_complete = true` refuses incomplete microscopy.
- Privacy-slot enforcement leaves private/fuzzed drafts unpublished if the cap would be exceeded.
- Stale draft count returns correct value.
- Stale draft enforcement, if enabled, does not block publishing/deleting.

### Web UI tests

Add tests for:

- Status dropdown has All/Drafts/Published.
- Status filter changes query state correctly.
- Scope dropdown options change between Mine and Feed.
- Feed `All` maps to followed + friends + public internally.
- Sort dropdown switches Date/Species.
- Spores toggle only filters observations with spore data.
- Draft badge appears only for owner.
- Old/stale draft labels appear from age thresholds.
- Draft detail copy appears next to Draft tag.
- Bottom popup messages are short and match the selected filter.
- Auto-publish success/failure message appears after microscopy/spore upload and refetch.

### Desktop sync tests

Add tests for:

- Draft fields are pushed and pulled.
- Old local client without draft fields does not accidentally publish or hide existing rows.
- Cloud observation published through the explicit RPC is not overwritten back to draft by stale local state.
- Conflict handling reports draft/publish state conflicts clearly.

## Suggested rollout

### Release 1 — UI clarity only

- Add `Status` dropdown.
- Add `Scope` dropdown.
- Keep Spores as simple toggle.
- Add `Sort` dropdown.
- Add short bottom popup messages.
- No database behavior change except reading existing `is_draft`.

### Release 2 — Draft lifecycle database migration

- Add/normalize draft columns.
- Add old/stale draft computation.
- Update views to exclude drafts.
- Update privacy-slot trigger to ignore drafts.
- Add owner-facing draft explanatory text.

### Release 3 — Explicit publish RPC and desktop auto-publish

- Add microscopy completion helper.
- Add explicit `publish_observation` RPC.
- Do not add database auto-publish triggers.
- Update `sporely-py` to call the RPC after microscope image/media and spore measurement sync succeeds.
- Add UI notification after publish success, publish skipped, or privacy-cap failure.
- Add privacy-cap failure handling.

### Release 4 — Stale draft limits

- Add stale draft count UI.
- Add non-destructive reminders.
- Add Free stale cloud draft cap only if abuse becomes real.
- Do not auto-delete drafts.

## Agent checklist

When implementing, do not assume the schema from this plan is exact. First inspect the current production migrations and live schema.

Required code areas likely include:

- Supabase migrations
- RLS policy descriptions/docs
- `SUPABASE_DB.md`
- find list query builder
- find filter state model
- find-detail Draft badge/info copy
- image/spore upload completion flow
- desktop sync projections in `sporely-py`
- tests for DB visibility, UI filters, and sync conflicts

Keep the core invariant intact:

```text
Draft is workflow.
Private is visibility.
Drafts are owner-only.
Drafts do not use privacy slots.
Published private/friends/fuzzed observations use privacy slots.
```
