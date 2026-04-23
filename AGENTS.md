# AI Agent Instructions (Sporely Web)

This file contains guidelines for AI coding assistants (Gemini, Claude, Cursor, etc.) working on the `sporely-web` project.

## Code Review & Auditing Mindset
When proposing changes, reviewing code, or debugging, always apply a strict refactor/audit mindset. We maintain a very high standard for code quality. 

Do not praise. Look for concrete problems only, categorizing them by:
1. Duplicate logic
2. Conflicting source of truth
3. Database consistency
4. State flow problems
5. UI consistency problems
6. Dead code / stale code
7. Overgrown files / bad boundaries
8. Naming problems
9. Error handling / edge cases

## Testing & Quality Assurance
We are moving from purely manual QA and "debug logs" towards automated testing. As an agent, you should:
- **Promote Static Analysis:** Write JavaScript that passes strict linting. Propose using ESLint to automate the discovery of dead code, missing variables, and unused imports.
- **Write Testable Code:** The sync architecture (IndexedDB offline queues, Cloudflare R2 worker uploads, Supabase inserts) is highly complex. When touching `src/sync-queue.js` or `src/artsorakel.js`, isolate pure functions so they can be tested independently.
- **Suggest Vitest Tests:** When adding or fixing logic (e.g., deduplication in `_observationsLikelySame`, or image crop math), provide the corresponding `Vitest` unit tests.
- **Audit RLS Policies:** Ensure that Row Level Security (RLS) policies in Supabase are verifiable. Suggest automated tests for database security rather than relying on manual UI checks.

## Stack Constraints
- **Vanilla JS, no framework.** No React, Vue, or Svelte.
- **Supabase JS v2** for auth and database interactions. No raw `fetch` for DB calls.
- **State** lives in `src/state.js`.
- **CSS** uses plain custom properties in `style.css`.