# Plans

- `active/`: staged plans that still have open work. Each starts with a status
  line; update it when a stage lands.
- `completed/`: closed plans, kept as the record of decisions. A closed plan
  starts with a dated note saying what shipped and where any leftover work went.
- Unstaged backlog items live in `PLAN.md` at the repo root; unsorted ideas in
  `INBOX.md`.

When a plan closes, `git mv` it from `active/` to `completed/` and fix
references in docs. Do not edit applied migrations or their header comments
to follow the move: some migrations, tests and rollbacks under `supabase/`
still cite `docs/plans/active/<name>.md`, and the same file name is now under
`completed/`.
