# Sporely Finds smooth scrolling, search pagination, and thumbnail stability

**Plan file target in repo:** `docs/plans/active/2026-09-09-finds-smooth-pagination.md`  
**Repository:** `sporely-web`  
**Prepared:** 2026-09-09  
**Evidence baseline:** `main` at `a7de5e2c5aefa6ced99d91d8b6bdcf7fff6e68c3`  
**Status:** ready for staged implementation with `sporely-sparring`

---

## 1. Goal

Fix the Finds screen so that:

1. normal infinite scrolling does not visibly stall at each page boundary;
2. search is truly paginated over matching observations instead of filtering only the already-loaded page(s);
3. loading another page never makes already-visible thumbnails disappear, flash white, or rehydrate;
4. the next page is normally fetched before the user reaches the end;
5. expensive secondary work is not needlessly serialized in front of rendering;
6. Mine, Feed, user-target, offline queue, visibility/status filters, date/species sort, and the existing media-cache/auth safety rules continue to work.

The desired user-visible behavior is continuous scrolling. Existing cards should remain visually inert while new cards appear below or are inserted into the correct group.

---

## 2. Observed symptoms

### Normal scrolling

Finds currently pauses close to the end of a loaded page before additional observations appear. On Android/WebView this is visible as a brief scroll stop.

### Search

A search such as `Cortinarius` behaves much worse. A small number of matches appear, then scrolling reaches the end almost immediately, another general page is fetched, the newly loaded rows are filtered client-side, and the process repeats.

This creates the impression that Sporely is searching among the first page, then the second page, then the third page rather than paging through search results.

### Thumbnail flash

When another page is incorporated, already-visible image areas briefly become empty/white before the thumbnails return.

The attached QA screenshots from 2026-09-09 show the same cards before and during this blank-image state.

### Scroll position lost on detail return, once past page 1

User-reported (2026-09-09): opening an observation from the list and going
back (cancel, or the `<` back control) loses the scroll position, but only
once the user had scrolled past the first 20 results (page 1). The list
always lands back at the same fixed vertical position regardless of which
item beyond page 20 was opened. Reproduces in plain (non-search) Finds too,
not only search — this is not a Stage 1 regression.

Root cause (confirmed by inspection, `src/screens/finds.js` /
`src/screens/find_detail.js` at the current baseline): the detail screen's
back handler unconditionally calls `loadFinds()`, which resets paging state
(`_resetPagingState`) and clears the cache (`_setFindsCache(scope, [])`)
before re-fetching — so only page 1 is re-fetched, discarding any
already-loaded pages 2+. `_pendingScrollRestore` still holds the original
(deeper) scroll offset, but the DOM only has page-1 height to scroll into,
so the browser clamps the restore to the same fixed position every time.

This is the same category of problem Stage 2 targets below (a full,
destructive re-render/re-fetch discarding already-loaded pagination state)
via a different call site (detail-return vs. ordinary load-more) — see the
added Stage 2 scope note and acceptance criterion. Fixing it well needs the
same underlying page-tracking/incremental-render infrastructure Stage 2
builds; a standalone hotfix now would either duplicate that work or fight it
once Stage 2 lands. Deferred to Stage 2 rather than fixed ahead of it.

---

## 3. Current implementation diagnosis

The implementation evidence on the preparation baseline points to a combined pagination/render problem rather than an Android-specific image bug.

### 3.1 Page size is 20

`src/screens/finds.js` defines:

```js
const FINDS_PAGE_SIZE = 20
const FINDS_LOAD_MORE_THRESHOLD = 240
```

The page size itself is not the root problem. Increasing it would only hide the boundary less frequently while making destructive rerenders more expensive.

### 3.2 Search is client-side after paging

`_applyFilter()` filters `_cache[...]` using `_matches(obs, q)` and includes the explicit comment:

```js
// Search still runs client-side against the loaded pages only. True global
// search needs server-side filtering and is out of scope for this pass.
```

Therefore a search with many total matches but a low hit rate per general page repeatedly exhausts the visible filtered list and causes more general pages to be fetched.

### 3.3 Load-more rerenders the whole currently loaded result set

`_maybeLoadMoreFinds()` currently:

1. loads another page;
2. reloads profile data for the scope;
3. calls `_applyFilter()`;
4. recursively checks whether more data is required.

`_applyFilter()` calls `_renderCards()` or `_renderBySpecies()` for the complete filtered cache.

Those renderers fetch image metadata for all observations in the current rendered set and then commit with:

```js
list.innerHTML = html
```

That destroys the existing card/image DOM during ordinary pagination.

### 3.4 The media loader explains the white-thumbnail frame

`src/image-helpers.js` intentionally renders cacheable observation images without a remote `src`. `wireImageFallback()` binds those new elements to the cache-first media loader.

`src/protected-media.js` owns the object URLs and releases bindings for removed elements. Its removal observer checks removed nodes after a microtask and releases media that remains disconnected.

Therefore a full `innerHTML` replacement creates new `<img>` elements that have to be rebound and repainted from the cache. The brief interval before that paint matches the blank image state seen in device QA.

### 3.5 The request/render path contains avoidable serial work

A page load currently includes observation fetching, red-list enrichment, profile/social loading in relevant scopes, image metadata loading, full HTML generation, DOM replacement, and media hydration.

The 240 px trigger gives this work almost no lead time.

---

## 4. Architecture constraints

These are hard constraints for every stage.

- Preserve the current capability/auth gates and field-offline behavior.
- Do not bypass the cache-first media loader or reintroduce raw public thumbnail `src` URLs merely to hide flicker.
- Do not weaken protected-media behavior.
- Do not remove queued local observations from Mine or make offline search require network access.
- Apply scope, visibility, draft/published status, user-target, and search predicates before server pagination wherever the server owns the rows.
- Do not mix rows from two different search queries in one paging state.
- Keep ordering deterministic with a stable tie-breaker.
- Do not add a virtual-list framework or a DOM-diffing dependency for this repair.
- Do not treat a larger page size as the fix.
- Do not redesign the Finds UI.
- Keep this work in `sporely-web`; no `sporely-py` or landing-site work is required unless fresh evidence proves otherwise.
- A load-more operation must not remove and recreate already-rendered observation cards.
- Full rerender remains acceptable for intentional state transitions such as changing scope, changing sort, changing view mode, or committing a new search result set. It is not acceptable for ordinary page append.

---

## 5. Sparring execution contract

This plan is intended to be the active plan consumed by the existing `sporely-sparring` workflow.

For each implementation stage:

1. Start from a clean repository state and fresh `origin/main`.
2. Run the normal deterministic sparring selector before opening the stage prompt or implementation files.
3. The selected stage implementer owns only the bounded stage below.
4. The implementer must update this active plan during the implementation pass with actual decisions, changed files, tests, and any deviations.
5. Run focused proof first, then the relevant broader suite.
6. A **fresh independent top-level reviewer** reviews the candidate commit/diff and the actual product code read-only. Do not replace this reviewer with a reviewer subagent.
7. Treat the implementer's report as a claim, not evidence.
8. Fix reviewer findings within the same stage and rerun proof.
9. Create exactly one verified implementation commit for the stage.
10. Record that commit SHA and verification result in this plan before moving to the next stage.

The top-level stage owner retains integration, broader verification, user iteration, and final handoff. Bounded subagents may be used for implementation work packages, but they do not replace the final reviewer.

If the working tree is dirty at handoff, do not present it as a verified result. Either clean it or identify an explicit candidate commit and review that commit.

Final handoff should include base/head commit metadata, the active-plan state, stage reports, exact automated commands, and manual-device results. Do not paste huge diffs into the handoff.

---

# Stage 1 — Server-side search-aware pagination

**Stage id:** `stage-finds-server-search-pagination`  
**Primary goal:** make a Finds search page through matching server rows instead of filtering arbitrary pages after they arrive.

## 1.1 Required behavior

For authenticated online Finds:

- normalize the current search text into a paging/query key;
- apply the search predicate to each server query **before** `.range(...)`;
- apply it consistently to:
  - Mine (`observations`);
  - public Feed (`observations_community_view`);
  - Friends (`observations_friend_view`);
  - Followed (`observations_follow_view`);
  - user-target observations;
- preserve the existing local `_matches()` filtering for queued/local observations so offline Mine remains searchable;
- reset paging when the normalized search query changes;
- prevent a response for an old search query from entering the new query's cache;
- debounce network-backed search input so typing `Cortinarius` does not start eleven paginated resets/renders.

Target debounce: approximately **200–300 ms**. The exact value is an implementation detail; use one value and test the behavior rather than spreading magic numbers.

## 1.2 Search fields

Preserve the current effective search surface unless a fresh schema constraint requires a documented exception:

- `common_name`
- `genus`
- `species`
- `location`
- `notes`

The implementation must safely encode arbitrary user text for the PostgREST/Supabase filter syntax. Do not interpolate an unescaped raw query into an `.or(...)` expression.

If a direct PostgREST OR filter cannot be made robust without fragile parsing, stop and record that evidence in this plan before introducing a small server RPC. Do not silently narrow search semantics.

## 1.3 Paging invariants

Each paging state must be tied to the dimensions that determine its result set, at minimum:

```text
scope/source + target user where relevant + status/visibility filter + sort + normalized search query
```

A page loaded for query `corti` must never be appended after the state has changed to `cortinarius`.

Offset advancement must reflect the server rows consumed by that specific filtered query.

## 1.4 Search transition UX

Do not paint the generic full-screen/list `Loading…` shell on every debounced search keystroke after results already exist.

Preferred behavior:

- typing may immediately narrow the currently cached cards locally;
- after debounce, the authoritative server-search first page replaces the result set once ready;
- stale async results are guarded by the existing load/render sequence mechanisms;
- clearing search resets to the unfiltered server query cleanly.

Do not preserve stale search results indefinitely if the server request fails; use the existing error UX.

## 1.5 Stage 1 code surfaces

Expected primary surfaces:

```text
src/screens/finds.js
src/screens/finds.test.js
```

Possible small supporting test changes are allowed. A migration is not expected unless the direct-query approach is proven unsafe or incapable of preserving the existing search contract.

## 1.6 Stage 1 automated proof

At minimum add focused regressions proving:

- Mine search predicate is applied before pagination.
- Feed source search predicate is applied before pagination.
- User-target search predicate is applied before pagination.
- changing search text invalidates/reset paging state;
- stale page responses cannot contaminate the new query;
- queued/local observations can still be matched client-side;
- special characters in search text cannot break the query expression or broaden it unexpectedly;
- empty/whitespace search behaves as no server search filter.

Run:

```bash
npm run check:node
node --test src/screens/finds.test.js
npm test
npm run build
git diff --check
```

## 1.7 Stage 1 reviewer questions

The fresh reviewer must answer:

- Is search genuinely before `.range(...)` for every online Finds source?
- Can any source still scan arbitrary pages and client-filter them as the authoritative search?
- Can an old debounced/in-flight query append into a new query?
- Are visibility/RLS/auth semantics unchanged?
- Does offline/local queue search still work?
- Is user-provided search text safely encoded?
- Did the stage introduce a hidden dependency on a larger page size?

## 1.8 Stage 1 commit

Suggested commit subject:

```text
fix: page Finds searches on the server
```

Record after verification:

```text
Stage 1 commit: 251f971fdb785ac8d43bad43c0126c9fa6a7c5f2 on feature/finds-server-search-pagination (base 7cd9e36f61ab7a3a59cd2b52cedfe70ad31250c1); pushed to origin; superseded by the correction pass below (commit e152401)
Stage 1 reviewer: 2026-09-09 fresh sporely-sparring — partly confirmed; changes requested
Stage 1 focused proof: node --test src/screens/finds.test.js — 34 pass, 0 fail
Stage 1 broader proof: npm run check:node (pass); npm test (1205 pass / 8 fail, all 8 pre-existing on main at 7cd9e36 — confirmed via git stash rerun, none in src/screens/finds.*); npm run build (pass); git diff --check (clean)
Stage 1 deviations/notes: see the Stage 1 implementation notes in section 10 (Recovery/resume notes) — summary: search predicate applied via one shared exported helper (applyFindsSearchFilter/_runPagedFindsQuery) reused by all three sources; debounced (~250ms) reload path (_reloadFindsForSearch) added alongside loadFinds() to satisfy the "narrow locally, then replace" UX without a full loading-shell repaint; _loadFeedSelectionPage gained an opt-in clearCache:false to support that; open question flagged for the reviewer regarding PostgREST's `*`→`%` ILIKE alias not being verified against a live server

Stage 1 correction pass (2026-09-09, human-gated — see section 10 for full detail):
Fixed: (1) on-input paging invalidation ahead of the network debounce, tied to
the normalized query (`_invalidateFindsSearchPagingOnInput`); (2) a loadSeq
recheck after awaited red-list enrichment, before the cache write, in all
three loaders. Investigated and resolved as a documented, accepted limitation
(user decision, not unilateral): PostgREST v12.2.3 unconditionally maps `*`
to `%` before Postgres ever applies the ILIKE escape character (confirmed
both from source and against a live local PostgREST instance with synthetic
rows) — no client-side escaping can preserve a literal `*`; kept the existing
escaping (documented in code) rather than adding an RPC/migration.
Focused proof: node --test src/screens/finds.test.js — 40 pass, 0 fail (6 new).
Broader proof: npm run check:node (pass); npm test (1211 pass / 8 fail, same
8 pre-existing failures as the Stage 1 baseline, none in src/screens/finds.*);
npm run build (pass); git diff --check (clean).
Committed: e1524016d6e019d02fd482c7c06b1654a9d7a00c on feature/finds-server-search-pagination;
pushed to origin; stage prompt reconciled to this SHA (status:
candidate_pending_review) via workflow_transitions.py mark-candidate. Manual
tests 2-4 (slow-network mid-search cancel, offline queued search, literal
special-character search) are recorded as outstanding, not run and not
assumed passing — proceeding to code review does not accept the stage; see
section 10 for the exact wording.
```

Stage 1 second correction pass (2026-09-09, human-gated — see section 10 for full detail):
Fixed the two defects from the "Independent code review — second correction"
section of the same-stage prompt: (1) the search-input handler now invalidates
the render guard/paging state *before* starting the local narrowing render
(previously `_applyFilter()` ran first, so the render's async image lookup
was later discarded by the invalidation that landed after it began); (2) the
debounce timer is now only (re)armed when an edit actually changed the
normalized query — an equivalent edit (e.g. trailing whitespace) no longer
arms a reload that would otherwise unconditionally reset paging back to page
one. The input-event handler itself was factored into an exported test seam,
`_handleFindsSearchInput`, so tests exercise the exact same wiring production
uses rather than only the lower-level helpers.
Focused proof: node --test src/screens/finds.test.js — 42 pass, 0 fail (2 new).
Broader proof: npm run check:node (pass); npm test (1213 pass / 8 fail, same
8 pre-existing failures as the Stage 1 baseline, none in src/screens/finds.*);
npm run build (pass); git diff --check (clean).
Committed: a65faca616719e28df9f86b5cf7fbc87ff5b853d on feature/finds-server-search-pagination-revision
(base 7cd9e36f61ab7a3a59cd2b52cedfe70ad31250c1, the original stage prompt's
immutable base). Manual tests 2-4 (slow-network
mid-search cancel, offline queued search, literal special-character search)
remain outstanding, not run and not assumed passing — the two code defects
above are fixed and proven by automated test, but that is not a substitute
for those manual checks.
```

---

# Stage 2 — Incremental load-more rendering and thumbnail preservation

**Stage id:** `stage-finds-incremental-pagination-render`  
**Depends on:** Stage 1 verified  
**Primary goal:** ordinary pagination must add new results without destroying existing cards or rehydrating their media.

**Also in scope (user-reported 2026-09-09, see section 2 "Scroll position lost
on detail return, once past page 1"):** the detail screen's back
navigation calls `loadFinds()` unconditionally today, which clears the
cache/paging state and re-fetches only page 1 — discarding pages 2+ and
making scroll restoration land at the same fixed (page-1-height) position
regardless of what was opened. This must be fixed as part of this stage: a
detail-return round trip should re-render from the already-loaded pages
rather than re-fetching page 1, so `_pendingScrollRestore` has real content
to scroll back into. Reproduces in both plain and search Finds.

## 2.1 Core invariant

After a successful load-more, for every observation that was already rendered before the request:

```text
existing card DOM node survives
existing <img> DOM node survives
existing media binding/object URL survives
existing visible pixels do not return to an empty placeholder state
```

This is the central regression target.

## 2.2 Separate initial/full render from page append

Refactor the rendering contract so the caller can distinguish:

```text
full result-set render
vs.
incremental page incorporation
```

A load-more path must not call the current full-data `list.innerHTML = html` behavior.

It is acceptable for initial load and explicit display-mode transitions to use a full render.

## 2.3 Page-load return contract

Change the page-loading layer to expose the delta clearly enough that the render layer does not rediscover it from the full cache.

A reasonable shape is conceptually:

```js
{
  loaded: true,
  rawRows: [...],
  addedItems: [...],
  hasMore: true
}
```

The exact object shape is not prescribed, but `addedItems`/equivalent must be available.

Deduped rows that were already in cache are not "added".

## 2.4 Image metadata scope

During load-more:

```text
fetchCardImages / fetchFirstImages
```

must receive only IDs required for newly rendered cards, not all IDs already visible in the list.

Existing image elements must not be rewired merely because another page arrived.

## 2.5 Date-sort incremental DOM

For date sort:

- append observations into the existing last date group when the date matches;
- create a new date separator/group when the next page crosses a date boundary;
- preserve current server ordering inside groups;
- append before the stable bottom sentinel/footer;
- update the "no more finds"/loading footer without rebuilding prior groups.

The implementation should factor card markup so full render and incremental render do not drift into two independent versions of the UI.

## 2.6 Species-sort incremental DOM

Species sort cannot simply append all new groups to the bottom because a newly discovered species can sort alphabetically before an already-rendered species.

Implement incremental group insertion:

- derive the same `_speciesKey()` and scientific-name ordering used by the full renderer;
- if a species group already exists, add only its new observation cards and update its observation count;
- if it does not exist, insert the new group at its correct sorted position;
- unidentified remains last;
- do not replace existing species groups/cards to accomplish the insertion.

Within an existing species group, newly loaded older observations may be appended after the existing observations if the paged server order is date-descending.

## 2.7 View variants

The invariant applies to:

- single-column `cards`;
- `two`;
- `three`.

Do not create three independent pagination engines. Share the card/group insertion logic as far as practical.

The legacy `_renderTiles()` path only needs modification if fresh code inspection shows that current product navigation can still select it.

## 2.8 Existing interaction behavior

Newly inserted cards must receive the same behavior as initial cards:

- open detail;
- pending-sync handling;
- delete button wiring;
- image fallback/media binding;
- red-list badge location;
- author chip;
- scroll restoration when entering/leaving detail.

Avoid a repeated "query all cards and rebind all events" strategy. Wire the newly inserted fragment or use safe delegation on a stable ancestor where appropriate.

## 2.9 Stage 2 automated proof

Add focused proof for the incremental contract. Prefer pure/helper tests and the existing lightweight test style; do **not** add jsdom or another DOM framework solely for this change unless the existing environment cannot prove the behavior without it.

Required assertions include:

- a page delta contains only newly added observation IDs;
- image metadata lookup for append receives only those IDs;
- date-group append logic joins the existing terminal date group correctly;
- a new date group is created exactly once at a boundary;
- species-group insertion chooses the correct alphabetical position;
- adding rows to an existing species group updates count without recreating the group;
- no ordinary `_maybeLoadMoreFinds()` path performs a full list `innerHTML` replacement;
- load-more does not re-run media wiring for pre-existing cards.

If a lightweight fake-DOM harness can assert object identity, add:

```text
oldCardAfter === oldCardBefore
oldImgAfter === oldImgBefore
```

Run:

```bash
npm run check:node
node --test src/screens/finds.test.js src/images.test.js src/image-helpers.test.js src/media-loader.test.js
npm test
npm run build
git diff --check
```

## 2.10 Stage 2 reviewer questions

The fresh reviewer must answer:

- Can any normal load-more path still replace the entire Finds list?
- Are already-visible `<img>` elements left untouched?
- Are image metadata calls delta-only?
- Are event handlers correct for newly inserted cards without duplicating old handlers?
- Do date and species grouping remain correct at page boundaries?
- Can dedupe cause a group count mismatch?
- Are pending queue cards and remote rows still merged safely?
- Does the media loader remain the sole owner of cacheable image painting?

## 2.11 Stage 2 commit

Suggested commit subject:

```text
fix: append Finds pages without repainting existing cards
```

Record after verification:

```text
Stage 2 commit:
Stage 2 reviewer:
Stage 2 focused proof:
Stage 2 broader proof:
Stage 2 deviations/notes:
```

---

# Stage 3 — Early prefetch and remove the load-more waterfall

**Stage id:** `stage-finds-prefetch-and-enrichment`  
**Depends on:** Stage 2 verified  
**Primary goal:** start the next page early enough that the user normally never reaches an unloaded boundary, and stop low-priority enrichment from blocking card availability.

## 3.1 Replace the 240 px late trigger

Prefer an `IntersectionObserver` observing a stable bottom sentinel inside the Finds scroller.

Recommended starting contract:

```text
root: #screen-finds
rootMargin: approximately one viewport ahead, e.g. 1000px 0px
threshold: 0
```

The exact root margin may be tuned after device QA.

The sentinel must remain stable through incremental page insertion. New cards go before it.

Keep a fallback for environments without `IntersectionObserver`, using a threshold derived from viewport height rather than the current fixed 240 px.

Suggested fallback:

```text
max(800px, 1.25 * scroller.clientHeight)
```

Use one centralized helper/constant rather than duplicated values.

## 3.2 Preserve single-flight behavior

The current `paging.loadingMore` guard is important. The observer may fire repeatedly while the sentinel remains within the root margin.

Ensure:

- at most one page request per paging source is active;
- after a successful append, the observer may immediately request another page only if the viewport/root margin still requires it;
- `hasMore === false` stops the observer-driven loading cleanly;
- query/scope reset cannot reuse an old observer completion.

## 3.3 Restructure enrichment

The current load-more path should not be:

```text
page
→ red-list
→ profile/social
→ image metadata
→ render
```

After observation rows are authoritative and merged, perform independent work in parallel where dependencies allow.

Required policy:

- **red-list enrichment must not block insertion of otherwise renderable cards**;
- profile/social hydration should operate only on user IDs not already cached;
- profile loading must merge into `_profileMap` rather than resetting all profiles on every page;
- image metadata must remain delta-only from Stage 2;
- patch late-arriving red-list badges in place without rebuilding the card;
- if profile data is needed before author UI can be correct, profile and image metadata may be awaited together for the new fragment while red-list runs in the background.

Do not make an already-rendered card wait again for enrichment when another page arrives.

## 3.4 Failure behavior

Secondary enrichment failure must not discard a successfully fetched observation page.

- red-list failure: card remains, badge absent;
- profile/social failure: preserve existing fallback author treatment;
- image metadata failure: card remains with normal image placeholder;
- next-page fetch failure: keep existing list untouched and allow the existing retry/error UX.

## 3.5 Optional performance instrumentation

A small development-only timing seam is allowed if useful for verification, but do not ship noisy production logging.

Useful measurements:

```text
page fetch start → page rows available
page rows available → new fragment inserted
fragment inserted → image paint (sampled)
```

The goal is to verify architecture, not to invent a brittle universal millisecond SLA.

## 3.6 Stage 3 automated proof

Required focused coverage:

- observer/fallback threshold requests before the physical bottom;
- repeated observer callbacks cannot create overlapping page loads;
- `hasMore=false` prevents further page requests;
- profile hydration requests only new user IDs and preserves existing `_profileMap` entries;
- red-list enrichment failure does not prevent page insertion;
- stale query/scope completion cannot append after reset.

Run:

```bash
npm run check:node
node --test src/screens/finds.test.js src/images.test.js src/image-helpers.test.js src/media-loader.test.js
npm test
npm run build
git diff --check
```

## 3.7 Stage 3 reviewer questions

The fresh reviewer must answer:

- Does prefetch begin materially before the user reaches the bottom?
- Can observer churn create duplicate/concurrent pages?
- Does any secondary enrichment still serialize unnecessarily in front of rendering?
- Does profile hydration accidentally drop profiles from previous pages?
- Can enrichment completion trigger a destructive rerender?
- Do failures leave the existing list stable?
- Are offline/auth capability boundaries unchanged?

## 3.8 Stage 3 commit

Suggested commit subject:

```text
perf: prefetch Finds pages and hydrate incrementally
```

Record after verification:

```text
Stage 3 commit:
Stage 3 reviewer:
Stage 3 focused proof:
Stage 3 broader proof:
Stage 3 deviations/notes:
```

---

# 6. Final automated verification gate

Run this only after all three implementation stages are individually reviewed and committed.

From `sporely-web`:

```bash
git status --short
git log --oneline --decorate -8

npm run check:node
node --test src/screens/finds.test.js src/images.test.js src/image-helpers.test.js src/media-loader.test.js
npm test
npm run build
git diff --check
```

If the repository has new Finds-specific test files by this point, include them explicitly in the focused command before `npm test`.

Then inspect the final stage range rather than trusting reports:

```bash
git diff --stat <BASE>..<HEAD>
git diff --check <BASE>..<HEAD>
git log --oneline <BASE>..<HEAD>
```

The final sparring reviewer should inspect the actual changed product code and tests at the candidate commits.

---

# 7. Manual device QA — run last

Do not perform this in the middle of the implementation stages. Complete automated proof and independent review first, then test the integrated result on Android.

Build/install with the project's normal environment:

```bash
npm run android:install
```

If installation is intentionally not available but an Android artifact still needs compilation proof:

```bash
npm run android:build:debug
```

## Scenario A — normal Feed scroll

1. Open Finds → Feed → All, date sort, single-column cards.
2. Start near the top with network available.
3. Scroll continuously through at least three page boundaries.
4. Watch an already-visible card while the next page arrives.

Pass conditions:

```text
scroll does not stop at an unloaded boundary under normal network conditions
existing visible thumbnails never turn white/empty
existing cards do not jump or repaint
new cards arrive below the existing content
```

## Scenario B — Cortinarius search

1. Open search and enter `Cortinarius`.
2. Wait for the debounced search request.
3. Scroll continuously through at least two result pages if the dataset contains enough matches.

Pass conditions:

```text
results page through matching observations
the UI does not repeatedly scan visible batches of non-matching observations
no repeated full-list thumbnail flash occurs
page loading feels like ordinary infinite scroll rather than a stop/rebuild cycle
```

If there are fewer than two pages of Cortinarius in the selected scope, use another known common genus with enough observations and record the substitute.

## Scenario C — rare search

Search a taxon known to have only a handful of results.

Pass conditions:

```text
the app reaches the true end cleanly
it does not repeatedly fetch/render arbitrary general pages just to prove there are no more matches
"No more finds" appears once authoritative paging is exhausted
```

## Scenario D — search churn

Type progressively:

```text
C
Co
Cor
Cort
Cortinarius
```

Then quickly replace it with another query.

Pass conditions:

```text
no old-query rows appear after the new query has committed
no flicker caused by stale render completion
no overlapping-page corruption
```

## Scenario E — sort and view variants

With enough results loaded:

1. switch Date ↔ Species;
2. switch Cards ↔ Two ↔ Three;
3. scroll another page in each relevant mode.

Pass conditions:

```text
intentional mode changes may rerender once
ordinary subsequent load-more remains non-destructive
species groups remain correctly ordered
species group counts remain correct
```

## Scenario F — Mine/status/visibility

Verify Mine with:

```text
All
Private
Friends
Public
Drafts
Published
```

Use only combinations exposed by the actual UI.

Pass conditions:

```text
server paging respects the selected filter before pagination
search does not leak rows outside the active visibility/status scope
queued observations remain present where they were present before this work
```

## Scenario G — offline cached mode

1. Establish the app normally.
2. Enter the supported field-offline/cached state.
3. Open Mine with queued local observations.
4. Search text that matches and does not match queued observations.

Pass conditions:

```text
queued/local search still works
no network-only search is required to use the offline queue
no auth/capability bypass was introduced
cached media behavior remains unchanged
```

## Scenario H — detail round-trip

1. Scroll well below the first page.
2. Open an observation.
3. Go back.

Pass conditions:

```text
scroll position restores acceptably
the return does not trigger a destructive full-list image flash
the visible page does not unexpectedly reset to the top
```

## Scenario I — pull-to-refresh

Pull to refresh after several pages have been loaded.

Pass conditions:

```text
an explicit refresh may perform a full authoritative rerender
the refreshed list is correct
infinite scrolling still works after refresh
auth/offline reconnect semantics remain unchanged
```

---

# 8. Final acceptance criteria

The work is complete only when all of the following are true.

| Requirement | Required result |
|---|---|
| Online search pagination | Search predicate is server-side before page range for every Finds source |
| Query isolation | No stale query page can enter a newer query |
| Offline queue search | Still works client-side without a network requirement |
| Normal load-more | Existing card and image nodes are not destroyed |
| Thumbnail stability | Already-visible thumbnails do not blank/reload when a page arrives |
| Image metadata | Load-more fetches metadata only for newly added observation IDs |
| Date grouping | Correct across page boundaries |
| Species grouping | Correct incremental insertion/counts without rebuilding old groups |
| Prefetch | Starts roughly a viewport before the bottom, not at 240 px |
| Concurrency | No duplicate/overlapping page loads |
| Enrichment | Red-list work does not block otherwise renderable cards |
| Profile cache | Previous page profiles are retained |
| Failure behavior | Existing list stays intact on page/enrichment failure |
| Auth/media safety | Capability gates and cache-first media model unchanged |
| Detail-return scroll restore | Returning from detail lands where the user left off, even past page 1, in both plain and search Finds (user-reported 2026-09-09) |
| Automated verification | Focused tests + full `npm test` + `npm run build` + `git diff --check` pass |
| Device QA | Scenarios A–I pass or any exception is recorded with reproducible evidence |

---

# 9. Explicit non-goals / follow-ups

Do not expand this plan into any of the following unless new evidence proves one is required for correctness:

```text
virtualized list/windowing
changing the media-cache storage model
changing protected-media authorization
general full-text-search infrastructure
taxonomy-v2 search redesign
map-screen search redesign
Home-feed redesign
raising FINDS_PAGE_SIZE as the main optimization
new animation/skeleton design
Cloudflare/media-worker changes
```

After this repair is verified, a separate later performance task may consider list virtualization if very large in-memory result sets eventually become a measurable problem. It is not part of this fix.

---

# 10. Recovery / resume notes

Every implementation pass must keep this section current.

Use this compact format:

```text
Current verified stage:
Current verified commit:
Current candidate/unverified work:
Last focused proof:
Last broader proof:
Last reviewer result:
Manual QA status:
Known issue/blocker:
Next exact action:
```

Initial state:

```text
Current verified stage: none
Current verified commit: none
Current candidate/unverified work: none
Last focused proof: plan preparation only
Last broader proof: plan preparation only
Last reviewer result: not started
Manual QA status: not started
Known issue/blocker: none known
Next exact action: run sporely-sparring selector and execute stage-finds-server-search-pagination
```

State after Stage 1 implementation pass (not yet independently reviewed):

```text
Current verified stage: none (Stage 1 candidate pending fresh independent review)
Current verified commit: none
Current candidate/unverified work: 251f971fdb785ac8d43bad43c0126c9fa6a7c5f2 on feature/finds-server-search-pagination (base 7cd9e36f61ab7a3a59cd2b52cedfe70ad31250c1)
Last focused proof: node --test src/screens/finds.test.js (34 pass, 0 fail)
Last broader proof: npm run check:node (pass); npm test (1205 pass / 8 fail — all 8 pre-existing on main at 7cd9e36, unrelated to Finds: supabase/functions/* and supabase/tests/adminActions.test.ts Deno edge-function tests, src/screens/map.test.js leaflet.css ESM extension error, src/live-reconnect.test.js QA3 assertion — verified via `git stash` + rerun on the unmodified tree before this pass); npm run build (pass); git diff --check (clean)
Last reviewer result: not started
Manual QA status: not applicable — Stage 1 is self-verifiable (unit/model-level only, no interactive/device-dependent surface)
Known issue/blocker: PostgREST's documented `*`→`%` ILIKE-alias substitution point (raw filter value vs. post-unescape value) was not independently confirmed against a live PostgREST server; the implementation escapes `*` with the same backslash convention as `%`/`_` per Postgres's ILIKE default escape character, consistent with the confirmed PostgREST url_grammar reserved-character/quoting rules, but a residual edge case remains for a literal `*` in search text — see Stage 1 reviewer note below
Next exact action: fresh independent sporely-sparring review of candidate 251f971 on feature/finds-server-search-pagination
```

**Stage 1 deviations / implementation notes for the reviewer:**

- The search predicate is applied via one shared helper, `applyFindsSearchFilter(query, searchQuery)` (exported), called from inside `_runPagedFindsQuery` (also exported as a test seam) — before `_orderedFindsQuery(...).range(...)`. All three paging call sites (`_loadMinePage`, `_loadFeedSourcePage`, `_loadUserPage`) route through `_runPagedFindsQuery` unmodified, so the "before `.range()`" invariant holds structurally for all of them, not just by convention.
- Search encoding (`buildFindsSearchOrFilter`, exported): the ILIKE pattern is built as `%<escaped>%`, escaping backslash first, then `%`, `_`, `*`; the whole pattern is then always wrapped in double quotes with `"`/`\` escaped for PostgREST's or()-list reserved characters (`,` `.` `:` `(` `)`), per PostgREST's url_grammar docs. This was verified against PostgREST's published docs (reserved-character list and quoted-value escaping rule), not against a live server — see the known issue/blocker above regarding `*`.
- Debounce (~250ms, `FINDS_SEARCH_DEBOUNCE_MS`) triggers a new `_reloadFindsForSearch()` (exported test seam), a lighter sibling of `loadFinds()` that resets paging the same way but skips the cache clear + full "Loading…" shell, so already-rendered cards stay visible (narrowed locally by the existing `_applyFilter()`/`_matches()` path on every keystroke) until the debounced server result replaces them. It participates in the existing `_loadFindsSeq` guard, so a slow/stale in-flight query can never be appended once the query has moved on (regression-tested with a deliberately-delayed stale response).
- `_loadFeedSelectionPage` gained a `clearCache` option (default `true`, unchanged for `loadFinds()`'s existing scope/status-change path) so the new search-reload path can pass `clearCache:false` and avoid a premature blank-list flash for Feed scope specifically.
- `_matches()` is untouched; still used for offline/queued-item client-side search (regression-tested).

State after the Stage 1 correction pass (committed, candidate reconciled, awaiting outstanding manual checks and fresh independent code review — NOT accepted):

```text
Current verified stage: none
Current verified commit: none
Current candidate/unverified work: e1524016d6e019d02fd482c7c06b1654a9d7a00c on feature/finds-server-search-pagination (base 7cd9e36f61ab7a3a59cd2b52cedfe70ad31250c1); pushed to origin; stage prompt reconciled to this SHA via workflow_transitions.py mark-candidate (status: candidate_pending_review)
Last focused proof: node --test src/screens/finds.test.js (40 pass, 0 fail; 6 new tests added this pass)
Last broader proof: npm run check:node (pass); npm test (1211 pass / 8 fail — same 8 pre-existing failures as the Stage 1 baseline, unrelated to Finds); npm run build (pass); git diff --check (clean)
Last reviewer result: prior candidate 251f971 was "partly confirmed, changes requested" (2026-09-09); this corrected candidate (e152401) has not yet been reviewed
Manual QA status: NOT passed, NOT accepted. Only manual test 1 (search during scroll/typing across scopes) is confirmed by the user. Manual tests 2 (slow-network mid-search cancel), 3 (offline queued search), and 4 (literal special-character search) are explicitly deferred by the user as outstanding — recorded here, not run, not assumed passing. The user explicitly directed committing candidate e152401 despite tests 2-4 being outstanding; this is a deliberate user decision to proceed to code review with those checks still open, not an agent judgment that they are unnecessary or an acceptance of the stage.
Known issue/blocker: manual tests 2, 3, and 4 remain outstanding against the real app/device and must be run before this stage can be treated as fully accepted, independent of code review. The `*`→`%` PostgREST ILIKE-alias question itself was investigated to a conclusive, evidenced answer and resolved by an explicit user decision (keep + document, no RPC) — that part is not open; only its manual confirmation (test 4) is outstanding. Separately (not part of this stage's outstanding items): a user-reported detail-return scroll-restore bug was found and deferred to Stage 2 — see section 2 and the Stage 2 scope/acceptance-criteria notes; that plan edit is still uncommitted local-only documentation, correctly excluded from candidate e152401 by mark-candidate's excluded_local_paths check.
Next exact action: request fresh independent sporely-sparring code review of candidate e1524016d6e019d02fd482c7c06b1654a9d7a00c (candidate_pending_review). Outstanding manual tests 2-4 must still be run and recorded before the stage can be accepted, regardless of the code review's outcome.
```

State after the Stage 1 second correction pass (fixes both defects from the
"Independent code review — second correction" section; committed, awaiting
fresh independent code review — NOT accepted):

```text
Current verified stage: none
Current verified commit: none
Current candidate/unverified work: a65faca616719e28df9f86b5cf7fbc87ff5b853d on feature/finds-server-search-pagination-revision (base remains 7cd9e36f61ab7a3a59cd2b52cedfe70ad31250c1, per the original stage prompt's immutable base)
Last focused proof: node --test src/screens/finds.test.js (42 pass, 0 fail; 2 new tests added this pass)
Last broader proof: npm run check:node (pass); npm test (1213 pass / 8 fail — same 8 pre-existing failures as the Stage 1 baseline, unrelated to Finds); npm run build (pass); git diff --check (clean)
Last reviewer result: prior candidate e1524016d6e019d02fd482c7c06b1654a9d7a00c was "partly confirmed, not accepted" (second correction review, 2026-09-09); this newly corrected candidate has not yet been reviewed
Manual QA status: unchanged from the prior pass — NOT passed, NOT accepted. Only manual test 1 is confirmed by the user. Manual tests 2 (slow-network mid-search cancel), 3 (offline queued search), and 4 (literal special-character search) remain outstanding, not run, not assumed passing.
Known issue/blocker: manual tests 2-4 remain outstanding against the real app/device. The two code defects identified by the second correction review (render-guard invalidation ordering; unconditional debounce-timer arming on an equivalent edit) are fixed and covered by new automated tests; no further code defects are open at time of writing.
Next exact action: request fresh independent sporely-sparring code review of candidate a65faca616719e28df9f86b5cf7fbc87ff5b853d. Outstanding manual tests 2-4 must still be run and recorded before the stage can be accepted, regardless of the code review's outcome.
```

**Stage 1 second correction-pass notes for the reviewer:**

1. **Render-guard invalidation ordering.** The search-input `input` handler (now factored into the exported `_handleFindsSearchInput(value)` test seam, called by the actual DOM listener) previously ran `_applyFilter()` — which captures the current render sequence via `_findsRenderGuard.begin()` — before `_invalidateFindsSearchPagingOnInput()` — which calls `_findsRenderGuard.invalidate()`. That ordering meant the very render just started for the new keystroke was immediately invalidated by the guard bump that landed right after it, so its async image lookup (`fetchCardImages`/`fetchFirstImages`) would later find `_isCurrentFindsRender(...)` false and discard the render (`_renderCards`/`_renderBySpecies`, the `await fetchCardImages(...)` guard check). Reordered so invalidation happens first; the local narrowing render now begins on the already-current (fresh) sequence and survives its own async image lookup. New test: `typing narrows cached cards locally and the render commits after debounce invalidation, including an async image lookup still pending` — holds the (faked) image-table query open past the point where the old ordering would have discarded the render, then releases it and asserts the narrowed HTML actually committed to `list.innerHTML`.
2. **Debounce timer armed unconditionally.** `_scheduleFindsSearchReload()` previously ran on every keystroke regardless of whether `_invalidateFindsSearchPagingOnInput()` reported a real change. Because `_reloadFindsForSearch()` (the timer's callback) unconditionally resets paging to page one, an equivalent edit (e.g. trailing whitespace added/removed after the user had already scrolled through several pages) would still arm — or replace — the debounce timer and, once it fired, silently reset the user back to page one. `_scheduleFindsSearchReload` now takes the `pagingChanged` result from invalidation and returns immediately (leaving any already-pending timer untouched) when the edit was a normalized no-op. New test: `an equivalent normalized edit does not arm or disturb the debounce timer, so a page-one reload is not forced after browsing further pages` — loads two pages via scroll, then asserts a trailing-whitespace edit arms no timer and leaves paging untouched, while a subsequent real edit still arms exactly one timer and correctly resets to a fresh page one once fired.
3. Both fixes touch only `src/screens/finds.js` (the input handler and the two helper functions it calls) and add two focused tests to `src/screens/finds.test.js`. `_applyFilter` was exported as a test seam (previously module-private) so the new render test can await its return value directly instead of polling for a side effect.

**Stage 1 correction-pass notes for the reviewer (addresses the three findings from the 2026-09-09 review):**

1. **On-input paging invalidation (finding 1).** Added `_invalidateFindsSearchPagingOnInput()` (exported test seam), called from the search-input `input` handler immediately, before `_scheduleFindsSearchReload()`'s debounce timer. Each paging state now carries a `searchKey` (the normalized query it is valid for, set by `_resetPagingState`). On every keystroke, if the newly normalized query differs from the current scope's `paging.searchKey`, this bumps `_loadFindsSeq` (so any older in-flight page fetch or enrichment awaiting a response is invalidated immediately, not just once the debounce eventually fires) and replaces the paging state with a fresh, un-initialized one tagged with the new query. Because the fresh paging state's `initialized` is `false`, the scroll-threshold load-more path (`_maybeLoadMoreFinds`) cannot fire against it at all until the debounced authoritative reload establishes a real first page — so a load-more can no longer reuse a stale offset against the new query text. A normalized-equivalent edit (e.g. added/trimmed whitespace) leaves `paging.searchKey` matching and is a no-op, per the review's explicit "equivalent normalized queries should not reset paging."
2. **Post-enrichment cache-write guard (finding 2).** `_loadMinePage`, `_loadFeedSourcePage`, and `_loadUserPage` each already checked `loadSeq` before awaiting red-list enrichment; each now rechecks it again immediately after that await, before calling `_setFindsCache(...)`. An older request whose page fetch was still current when it started, but whose red-list lookup resolves after a newer search has already completed and written the cache, now no-ops instead of overwriting the newer result.
3. **The `*`→`%` PostgREST ILIKE-alias question (finding 3) — investigated, not left open.** Confirmed via PostgREST v12.2.3 source (`src/PostgREST/Query/SqlFragment.hs`: `T.map star` over the raw ilike/like filter value, `star c = if c == '*' then '%' else c`, applied unconditionally before Postgres ever sees the value) and independently reproduced against this repo's own local Supabase/PostgREST instance with a throwaway synthetic-data table (dropped after verification, no migration/schema change): a literal `*` in search text cannot be preserved through this filter surface — `\*` becomes `\%` at the SQL layer, which Postgres reads as an escaped literal `%`, not `*`. This does not broaden or break the query (confirmed live: searching for `*` returned only rows containing a literal `%`, never an unrelated row) — it only means a literal-`*` search silently finds a literal `%` instead. Per the correction prompt's instruction not to decide this unilaterally, the user was asked and chose: keep the existing escaping and document the limitation (no RPC/migration). The code comment on `_escapeFindsIlikeText` now states this precisely with the source citation, and a new pure-JS test (`special characters in search text match their literal counterpart...`) faithfully re-implements the confirmed three-stage pipeline (this file's quoting → PostgREST's star substitution → Postgres ILIKE with backslash escape) to assert literal-match correctness for `%`, `_`, `\`, `"`, `,`, `.`, `:`, `(`, `)` and the documented non-broadening `*` exception, without depending on a live server in CI.
4. **New/replaced tests** (`src/screens/finds.test.js`): the old single stale-response test (which only asserted call counts, per the review) is now several focused tests asserting actual resulting cache row IDs and paging offsets: query-change invalidation with real IDs; equivalent-vs-real query-change paging behavior; load-more racing a pending debounce; the enrichment-race guard (finding 2), using a real (mocked) red-list lookup held open with a controllable promise; clearing search; and Mine + all three Feed sources (public/friends/followed) + user-target each individually exercised through the real `loadFinds()` entry point against their own table/view (not just three labels calling the same low-level helper). Two small test-only seams were added to `finds.js`: `_getFindsCacheForTests`/`_getFindsPagingStateForTests` (read-only cache/paging inspection) and exporting `_maybeLoadMoreFinds` for the load-more-during-debounce test.

---

# 11. Evidence pointers for the first implementer/reviewer

Inspect these fresh from the selected candidate/base rather than relying on this document as authority:

```text
src/screens/finds.js
  FINDS_PAGE_SIZE
  FINDS_LOAD_MORE_THRESHOLD
  _bindInfiniteScroll
  loadFinds
  _runPagedFindsQuery
  _loadMinePage
  _loadFeedSourcePage
  _loadFeedSelectionPage
  _loadUserPage
  _maybeLoadMoreFinds
  _matches
  _applyFilter
  _renderBySpecies
  _renderCards

src/images.js
  fetchObservationImageRows
  fetchFirstImages
  fetchCardImages

src/image-helpers.js
  imageHtml
  wireImageFallback

src/protected-media.js
  ProtectedMediaLoader.bindCacheable
  ProtectedMediaLoader._loadCacheable
  ProtectedMediaLoader.release
  _observeRemovedMedia

src/screens/finds.test.js
src/images.test.js
src/image-helpers.test.js
src/media-loader.test.js
```

Preparation-time baseline facts are evidence, not implementation authority. If current `main` has changed before Stage 1 starts, update the plan with the new base and reconcile the stage against the fresh code before editing.


## Independent Stage 1 review — 2026-09-09

Reviewed candidate 251f971fdb785ac8d43bad43c0126c9fa6a7c5f2 against
7cd9e36f61ab7a3a59cd2b52cedfe70ad31250c1. Current HEAD eec95e8 adds only
plan bookkeeping; unrelated untracked docs/google-closed-testing-log.md was
excluded. Handoff repo/stage/candidate and implementation session match.

Verdict: partly confirmed, not accepted. Search is before range for all source
builders, local matching and authorization predicates are unchanged, and the
reviewer's focused run passes 34/34. Broader checks remain implementer-reported.
Blocking findings: old paging remains live during debounce; awaited enrichment
can complete a stale cache write; literal-star escaping contradicts upstream
PostgREST v12.2.3's unconditional star-to-percent substitution (production
version unconfirmed). Existing stale tests do not assert cache or offsets.

The backend recorded changes_requested for the exact candidate. Correction
instructions and required proof are in the existing stage-finds-server-search-pagination
prompt, pinned to full HEAD eec95e89f6b12a063d19622c369b586db358c16d.
Current verified stage/commit: none. Next action: correct Stage 1 in a fresh
implementation session, stopping for a reviewed alternative if direct ILIKE
cannot preserve arbitrary text. The correction is human-gated because input
and debounce behavior are interactive; no manual results are claimed. Stage 2
remains deferred. No product code was edited during review.


### Independent code review of correction e152401 — 2026-09-09

Partly confirmed, not accepted. Candidate/handoff identities now match;
HEAD 7aa2273 adds plan documentation only. Focused tests independently rerun:
`node --test src/screens/finds.test.js` — 40 pass, 0 fail. Post-enrichment
sequence guards are present in Mine, Feed, and user-target loaders.

Two defects remain in the actual input path: local narrowing starts before
its own render guard is invalidated (nonempty renders are discarded after
image awaits), and normalized-equivalent input still schedules a delayed
page-one reset. Existing tests bypass those handler/timer interactions.
The same-stage prompt now records exact code pointers and required regression
scenarios under “Independent code review — second correction”. No product
code changed in review. Manual tests 2–4 remain user-deferred and unconfirmed;
Stage 2 remains pending. No security specialist is required for these fixes.


### Independent code review of candidate 09e6db1 — 2026-09-09

Partly confirmed, not accepted. Reviewed base 7cd9e36f61ab7a3a59cd2b52cedfe70ad31250c1
through recorded candidate 09e6db1ab80b917cb2dcb11a567b090fd43b49b4 (implementation
a65faca plus documentation follow-up); handoff and clean-tree identities match.
The immediate input ordering and equivalent-edit timer gating fixes are present.
Independent focused run: 42 pass / 0 fail. Broader checks remain implementer-reported.

One overlap defect remains: the debounced reload invalidates the current local
narrowing render when its image lookup exceeds the debounce interval. A read-only,
in-memory adaptation of the existing render test held the second server response
pending and started reload before releasing images: 41 pass / 1 fail, local
render returned false. The normal test releases images before reload starts.
Required correction and completion-order regressions are recorded under
"Independent code review — third correction" in the same pending stage prompt.
No product or test files were changed by this review.

Current verified stage/commit: none. The shared record-result backend succeeded
(exit 0; response status recorded, verdict partly_confirmed, accepted false).
Stage remains open as changes_requested, expected_starting_head
09e6db1ab80b917cb2dcb11a567b090fd43b49b4. Manual tests 2–4 remain deferred and
unconfirmed; the prior recorded literal-star exception is not proof of literal
matching. Next action: a fresh standard implementer session fixes the debounce /
slow-image overlap within Stage 1, verifies both response orders, updates this
plan, and captures its own handoff. Stage 2 remains pending. No security specialist
is required for this client-only scheduling correction.

### Stage 1 third correction pass (2026-09-09, human-gated)

Fixes the overlap defect from "Independent code review of candidate 09e6db1"
above: `_reloadFindsForSearch()` (`src/screens/finds.js`) invalidated the
render guard and reset paging unconditionally on every call, even when the
debounce fired for the exact same normalized query that
`_invalidateFindsSearchPagingOnInput()` had already tied paging to at
keystroke time. That redundant invalidation discarded the still-in-flight,
same-query local narrowing render whenever its image lookup took longer than
the debounce interval. Fixed by comparing the current paging state's
`searchKey` against the normalized query before invalidating/resetting:
skip both when they already match (the common debounce-fire case, preserving
the local render), but still invalidate/reset when they genuinely differ
(the clear/close paths, which set `state.searchQuery` directly without going
through the input handler). A later, superseding render still naturally wins
over an earlier one purely because `_findsRenderGuard.begin()` is itself
monotonic — no explicit invalidate is needed for that half of the guarantee.

New regression tests added to `src/screens/finds.test.js`, covering exactly
what the review asked for:
- a same-query debounced reload starting while its own authoritative page is
  still unresolved does not discard the in-flight local narrowing render
  (asserts the locally narrowed HTML actually commits while the authoritative
  page is held open, then that the authoritative response replaces it once
  released);
- the inverse completion order — a local render whose image lookup resolves
  only after the authoritative response has already begun rendering must not
  overwrite it;
- an equivalent normalized edit arriving while a real-change timer is already
  pending must leave that timer untouched (the pre-existing test with a
  similar title exercised only the "no timer was pending yet" case, per the
  review's note).

While writing these tests, the shared `installFakeFindsTimers()` test helper
(used by the pre-existing timer test too) was found to have a latent,
occasionally-flaky hazard unrelated to this fix: it intercepted every
`setTimeout` call process-wide, including unrelated real background timers
(observed: the imported `supabase` client's own connection housekeeping),
which could coincidentally land in the fake's map and inflate its pending
count. Narrowed it to only intercept calls made with the search debounce's
own 250ms delay, passing every other delay through to the real timer
unchanged; this is a test-harness robustness fix, not a product-code change.

Focused proof: `node --test src/screens/finds.test.js` — 45 pass, 0 fail
(3 new tests added this pass).
Broader proof: `npm run check:node` (pass); `npm test` (1216 pass / 8 fail —
same 8 pre-existing failures as every prior pass on this stage, none in
`src/screens/finds.*`); `npm run build` (pass); `git diff --check` (clean).
Committed: 71dfde521ea19545c32ad9dbdead414ef2c9fa29 on
feature/finds-server-search-pagination-revision (base
`7cd9e36f61ab7a3a59cd2b52cedfe70ad31250c1`, unchanged from the original stage
prompt).
Manual tests 2–4 (slow-network mid-search cancel, offline queued search,
literal special-character search) remain outstanding — not run, not assumed
passing. This pass fixes only the third review's code-level finding.
Next exact action: fresh independent `sporely-sparring` review of the new
candidate.


### Stage 1 final manual evidence and acceptance attempt — 2026-09-10

User explicitly confirmed in the fresh sparring session: "Test 2 passes with that candidate", referring to 453c834d0e27604a3cb4bc20e6b95146c61e25c2. Test 2 is passed on this exact candidate; do not request it again. Previous manual dispositions for tests 1, 3 and 4 remain valid, including the deliberate literal-star limitation, not a claim of literal-star support. This supersedes earlier outstanding-manual-test statements above.

Reviewer checked unchanged HEAD and clean working tree, inspected the third-correction product diff, and reran node --test src/screens/finds.test.js: 45 pass, 0 fail. Combined with the recorded prior code review, substantive verdict is Confirmed. Broader verification retains its prior recorded disposition; no new broader run is claimed. No product files changed.

The shared workflow backend refused the confirmed receipt (exit 2): acceptance cannot be recorded from changes_requested while a revision is pending. Durable status did not move: changes_requested; expected_starting_head remains 453c834d0e27604a3cb4bc20e6b95146c61e25c2. Stage 1 is not mechanically accepted or archived, and Stage 2 has not been opened. Next action is documentation-only revision bookkeeping in the implementation session: preserve this evidence in a new candidate, stamp with mark_candidate, then fresh acceptance review. No further product fix or repeated manual test is requested. No specialist reviewer is needed for this documentation-only follow-up.
