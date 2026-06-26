# Public Explorer Geography Backfill

This repo now has a small admin-only workflow for seeding public explorer regions and backfilling `observations.country_code` and `observations.region_id` in a reviewable way.

Script:
- `scripts/backfill_public_geography.py`

Database target:
- pass `--db-url "<postgres connection string>"`
- or set `SUPABASE_DB_URL` or `DATABASE_URL`

Workflow:
1. Dry-run and then seed Norway regions.
2. Export public observations missing `country_code` or `region_id` to CSV.
3. Review the CSV and fill `suggested_country_code` and `suggested_region_id`.
4. Dry-run `apply-csv` first.
5. Re-run `apply-csv --apply` once the review is approved.
6. Run `audit` to confirm coverage and spot any remaining privacy concerns.

Examples:

```bash
python3 scripts/backfill_public_geography.py seed-regions --db-url "$DB_URL"
python3 scripts/backfill_public_geography.py seed-regions --db-url "$DB_URL" --apply
python3 scripts/backfill_public_geography.py export-missing --db-url "$DB_URL"
python3 scripts/backfill_public_geography.py export-missing --db-url "$DB_URL" --include-gps
python3 scripts/backfill_public_geography.py apply-csv --db-url "$DB_URL" exports/public-geography-20260626-120000Z.csv
python3 scripts/backfill_public_geography.py apply-csv --db-url "$DB_URL" --apply exports/public-geography-20260626-120000Z.csv
python3 scripts/backfill_public_geography.py audit --db-url "$DB_URL"
```

Notes:
- Generated CSVs under `exports/public-geography-*.csv` and `exports/admin-public-geography-*.csv` are ignored by git.
- `--include-gps` is off by default and should only be used for private/admin review files.
- The script never changes `location_precision`.
