# Reported statistics activation

The single-user desktop now writes the existing full L/W/Q content and frozen
v2 attachments. Migration `20261026180718` installs the already reviewed v2
snapshot implementation at the current chronological head and removes the
obsolete older-device creation hold. It preserves ownership, per-request
version validation, RLS, CAS and rate limits. It does not rewrite scientific
records or publish curated content.

The original `20260914090000` file and its pinned checksum remain unchanged and
excluded by the deployment registry. Do not apply it out of order or repair
its history. Public version-aware readers are already deployed.

Prepare the committed candidate and check the exact one-migration allowlist:

```sh
node scripts/supabase-deploy-tree.mjs prepare --allow 20261026180718 --ref HEAD --out /private/tmp/sporely-reference-deploy
node /private/tmp/sporely-reference-deploy/scripts/supabase-deploy-tree.mjs check --tree /private/tmp/sporely-reference-deploy
```

Only after explicit production GO, run `supabase db push --linked` from that
prepared tree, then its `post-verify --tree /private/tmp/sporely-reference-deploy`
command. Target: `zkpjklzfwzefhjluvhfw`. The helper validates project identity,
committed candidate, deferred-file hashes and the dry-run migration set.

Validation: all 19 deployment-helper tests pass. After applying the candidate
to a separate local schema database, all four rollback-only SQL suites pass:
`reference_snapshot_v2_test.sql`, `reference_measurement_content_extension_test.sql`,
`reference_client_capability_test.sql`, and
`reference_snapshot_version_public_reads_test.sql`. This isolated schema test
does not substitute for a full Supabase reset or production sync. Production
preflight found no unsupported measurement-details versions; the existing
publication/submission constraint names match the migration.
