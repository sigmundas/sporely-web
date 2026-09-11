# sporely-web — project knowledge

Durable knowledge for an implementation or sparring agent working on this
repository. Verified against the working tree on 2026-09-10.

This file is injected verbatim into both the stage-agent and the sparring-agent
prompt. Keep it factual and short enough to stay cheap; put stage-specific scope
in the stage brief, not here.

## What this repository is

`sporely-web` is Sporely's mobile field companion: the web app at
`app.sporely.no` plus a Capacitor Android wrapper shipped to Google Play. It is
the client users capture observations with in the field.

Siblings under `~/Documents/Code/sporely/` (do not edit them from a
`sporely-web` stage): `sporely-py/` (desktop app, GitHub repo name is
`sporely`), `sporely-landing/` (the public explorer, despite the name),
`sporely-admin/`. Shared backend: Supabase plus Cloudflare R2 media.

**Stale-worktree hazard.** The parent directory holds around ten orphaned
worktree copies (`sporely-web-minimax/`, `sporely-web-security/`, and so on)
whose `.git` files point at gitdirs that no longer exist. They are readable,
plausible, stale source. Never grep the parent root; scope every search to this
repository's own directory.

## Stack

- Vite 6, vanilla JS ES modules. **No framework** — no React, no Vue, no JSX.
- Plain CSS custom properties in `src/style.css`. No preprocessor, no utility
  classes.
- Supabase JS v2 (`@supabase/supabase-js`) for auth and database.
- Capacitor 8 Android wrapper (`android/`, `capacitor.config.json`).
- Media: Cloudflare R2 via an authenticated Worker at `upload.sporely.no`,
  served from `media.sporely.no`.
- Node 22+ required and enforced (`npm run check:node` runs as a `pre` hook on
  `dev`/`build`). `.nvmrc` pins 22.

## Important directories

- `src/` — flat module directory. Each module is one concern, and its tests sit
  beside it as `<name>.test.js`.
- `src/screens/` — one module per screen: `auth`, `home`, `finds`, `capture`,
  `review`, `import_review`, `profile`, `map`, `find_detail`, `people`,
  `oauth-consent`.
- `src/state.js` — a single shared mutable object. There is no reactivity
  layer; screens read and write it directly.
- `src/router.js` — `navigate(screen)` swaps an `.active` class and
  starts/stops the camera.
- `supabase/migrations/` — 104 migrations. Production history. See the
  migration-safety rules below.
- `supabase/functions/` — Deno edge functions, TypeScript.
- `cloudflare/r2-upload-worker/` — the authenticated upload Worker.
- `docs/plans/active/` — canonical active plans. `docs/plans/completed/` —
  finished ones.
- `android/` — Capacitor Android project. GitHub Actions is the canonical
  release builder.

## Test / build commands

```bash
npm run check:node                     # Node 22+ guard
node --test src/screens/finds.test.js  # focused: name the exact file(s)
npm test                               # full suite = `node --test`
npm run build                          # vite build
npx eslint .                           # 0 errors / 51 warnings at baseline
git diff --check                        # whitespace
```

Prefer focused `node --test <file>` runs during iteration. Run `npm test` and
`npm run build` at a stage boundary, not after every edit.

### Known baseline failures — do not attribute these to your change

`npm test` at baseline is **1260 tests, 1216 pass, 8 fail, and exits 1.** All
eight failures pre-exist and are unrelated to ordinary feature work:

1. `src/live-reconnect.test.js` — "QA3: Offline pill supersedes the header Sync
   tag (never both)" assertion failure.
2. `src/screens/map.test.js` — "map current location uses state.location.fix …";
   fails with `ERR_UNKNOWN_FILE_EXTENSION` importing `leaflet.css` through the
   ESM loader.
3.–8. Six Deno/TypeScript edge-function suites that `node --test` cannot load at
   all (`ERR_UNKNOWN_FILE_EXTENSION` on `.ts`):
   `supabase/functions/admin-ops/adminActions.test.ts`,
   `supabase/functions/reference-curation/{actions,http,lifecycle_actions,reads}.test.ts`,
   `supabase/tests/adminActions.test.ts`.

A stage is clean when the failure list still contains exactly these eight and no
others. Report the count, not just "tests pass".

**`ARCHITECTURE.md`'s "Testing & Auditing" table is stale.** It claims ESLint
and Vitest are "planned". ESLint 10 is actually installed and configured
(`eslint.config.js`); there is no Vitest — the runner is Node's built-in
`node --test`. Trust `package.json` over that table.

## Coding conventions

- Vanilla ES modules, no framework and no new runtime dependency without being
  asked. Do not introduce jsdom or another DOM framework to make a test
  possible; prefer pure/helper-level tests and small exported test seams, which
  is the established pattern in `src/screens/finds.js`.
- Module-private helpers that tests need are exported with a leading underscore
  (`_runPagedFindsQuery`, `_maybeLoadMoreFinds`, `_applyFilter`). Follow that
  convention rather than inventing a new seam style.
- Tests are colocated: `src/foo.js` is tested by `src/foo.test.js`, using
  `node:test` and `node:assert`.
- Write the failing regression before the production edit where practical.
- Unused variables must match `/^_/u` to satisfy ESLint.

## Working-tree hygiene

This repository often carries concurrent uncommitted work.

- Inspect `git status` before staging. Stage only files belonging to the current
  stage; use `git add -p` for mixed files.
- Never bundle unrelated `supabase/schema.sql`, migrations, tests, docs, or UI
  changes into a stage commit.
- Do not add `deno.lock` unless the task requires it.
- Never rewrite published history (no `--force`, no `--amend` to a pushed
  branch).

## Product constraints and invariants

Violations here tend to be silent, which is why they are listed.

- **Supabase migration history is production state.** Once a version appears in
  the Remote column of `supabase migration list`, it is immutable. Corrections
  are new compensating migrations. Never run `supabase migration repair`, never
  edit an applied migration, never use MCP `apply_migration` for a repo-tracked
  migration, and never invent a replacement timestamp. If local and remote
  history disagree, STOP and report — do not repair automatically. Full rules in
  `AGENTS.md`.
- **Media goes through the authenticated Worker, never direct R2.** Supabase
  Storage (`observation-images`) is legacy-only: not for new uploads and not as
  a fallback.
- **`docs/supabase-sync-contract.md` is authoritative** for sync behavior. Code
  contradicting it is wrong, or the contract needs an explicit amendment. No
  silent divergence.
- **Auth is a six-state machine** in `src/auth-state.js` (RESOLVING /
  UNAUTHENTICATED / INCOMPLETE / COMPLETE / CACHED / REAUTH_REQUIRED), with
  structural invariant tests. `src/reauth.js` is the single recovery seam and
  `src/capabilities.js` the single capability gate. Do not add a parallel path.
- **Turnstile asymmetry.** `VITE_TURNSTILE_SITE_KEY` is public and client-side
  only; enforcement is a project-wide Supabase dashboard secret. If that secret
  is unset, login still succeeds and the token is silently ignored — a passing
  login is not evidence CAPTCHA works. Never provision a second Turnstile
  widget for this client.
- **Visibility** (hidden / banned / blocked / private / friends-only) is
  enforced by backend views and RLS policies. The frontend must not duplicate
  or second-guess it.
- **Write identity** never comes from the client. No caller-supplied `user_id`,
  `reporter_id`, or `blocker_id`; identity comes from the session and RLS
  `auth.uid()`.
- Business model is Free / Pro; Pro adds private sync capacity and
  higher-quality cloud images.

## Manual and device checks

Much of this app cannot be proven on a workstation. When a stage's real proof
needs hardware or a human eye, say so and stop rather than guessing — that is a
legitimate NEEDS_YOU, not a failure.

Genuinely device- or human-dependent surfaces:

- Android/WebView scroll smoothness, thumbnail flashing, and scroll restoration
  (`src/screens/finds.js`).
- Camera capture and the native photo picker (`src/screens/capture.js`,
  `import_review.js`).
- Native Google sign-in and OAuth return
  (`docs/android-google-sign-in.md`).
- Offline/airplane-mode behavior, the IndexedDB sync queue drain, and
  background-task upload (`src/sync-queue.js`).
- Session-expiry and reauthentication banners after a real token lapse.
- Anything visual: layout, contrast, dark mode.

Standing checklists live in `docs/manual-qa.md`; the active plan's own manual
scenarios take precedence for that stage. Install a device build with
`npm run android:install` (needs a connected device); `npm run android:sync`
alone just builds and syncs.

## Data handling

The production database holds accounts, emails, and observation locations —
personal data. Under SINTEF policy this tooling is approved for green and yellow
data but not personal data without prior written consent. Do not connect live
production as a review or implementation input; work against the declared
contracts (`SUPABASE_DB.md`, `docs/supabase-sync-contract.md`,
`supabase/migrations/`). Never put a service-role key in a prompt or a commit.

## Reading discipline

`src/screens/finds.js`, `src/images.js`, and `src/screens/import_review.js` are
large. Search symbols first (`rg "symbol" src/screens/finds.js`), then read
bounded ranges. In the sibling `sporely-py` repo three modules exceed 20,000
lines and a single wholesale read ends a session; the same habit applies here.

## Project-specific implementation subagents

Available for delegation from inside a stage. They are capacity, not
independent review — this stage's sparring agent is the independent check.

- `Explore` (Haiku) — locate files, symbols, call paths, likely ownership.
  Returns a compact map. Use it before any expensive investigation. Give it a
  turn budget and an explicit repository path; it stops at a turn limit and
  returns partial output if the task is too broad.
- `sporely-implementer` (Sonnet) — one bounded work package with nontrivial
  edits. Stops at the package boundary.
- `sporely-planner` (Sonnet) — only real architectural decisions: ambiguous
  ownership, cross-repo contracts, schema or sync redesign. Not for locating
  code.
- `sporely-security-reviewer` — only when auth/session, RLS, SECURITY DEFINER
  or public RPCs, storage, secrets/service-role, account binding, visibility,
  moderation/blocking, or deletion actually changed. Not for routine UI work.

Guidance: Haiku maps, Sonnet works, Opus diagnoses hard failures. Do not chain
planner → implementer → reviewer by default. If a subagent's result is
incomplete rather than wrong, resume it instead of spawning a fresh one, and
pass the failure evidence up when escalating.

## Subagent policy

Default: do the stage directly in the top-level implementation session.

Do not delegate implementation work merely because subagents are available.
The stage agent is the single implementation owner and should retain the
cross-file and cross-step context of the stage.

Subagents may be used only when they provide a concrete advantage:

- read-only exploration of a genuinely large/unfamiliar code area;
- a specialist investigation requiring isolated expertise;
- a clearly independent work package explicitly permitted by the stage brief.

Do not use subagents for:
- ordinary code search;
- single-file or tightly coupled edits;
- splitting one coherent feature into pieces;
- independent "review" of implementation -- agent-sparring already provides
  the independent sparring pass;
- convenience or token conservation alone.

No nested delegation.
No concurrent implementation writers in the same worktree.

If a subagent is used, the stage handoff must state:
- which subagent was used;
- its exact task;
- whether it was read-only or edited files;
- the configured/runtime model if actually known;
- what result was incorporated.

If model or runtime information is not exposed, say "unknown"; do not infer it.

The top-level stage agent remains responsible for inspecting all delegated
work, integrating it, running verification, and making the candidate commit.