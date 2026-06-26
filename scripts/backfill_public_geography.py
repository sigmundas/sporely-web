#!/usr/bin/env python3
"""Backfill public explorer geography in a reviewable, admin-only workflow.

Safe defaults:
- `seed-regions` is dry-run only unless `--apply` is passed.
- `export-missing` only writes a local CSV export.
- `apply-csv` is dry-run only unless `--apply` is passed.
- no automatic location precision changes
- no network or geocoding calls

The script expects a direct Postgres connection string via `--db-url` or one of:
`SUPABASE_DB_URL`, `DATABASE_URL`.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable


ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_EXPORT_DIR = ROOT_DIR / "exports"

COUNTRY_CODE_RE = re.compile(r"^[A-Z]{2}$")


@dataclass(frozen=True)
class RegionSeed:
    id: str
    country_code: str
    label: str
    sort_order: int | None = None
    map_x: int | None = None
    map_y: int | None = None


@dataclass(frozen=True)
class ReviewUpdate:
    row_number: int
    observation_id: int
    country_code: str | None
    region_id: str | None


NORWAY_REGION_SEEDS: tuple[RegionSeed, ...] = (
    RegionSeed("no-finnmark", "NO", "Finnmark", 1, 84, 4),
    RegionSeed("no-troms", "NO", "Troms", 2, 68, 8),
    RegionSeed("no-nordland", "NO", "Nordland", 3, 48, 14),
    RegionSeed("no-trondelag", "NO", "Trøndelag", 4, 44, 28),
    RegionSeed("no-more-og-romsdal", "NO", "Møre og Romsdal", 5, 35, 41),
    RegionSeed("no-vestland", "NO", "Vestland", 6, 23, 55),
    RegionSeed("no-rogaland", "NO", "Rogaland", 7, 14, 69),
    RegionSeed("no-agder", "NO", "Agder", 8, 23, 84),
    RegionSeed("no-telemark", "NO", "Telemark", 9, 35, 77),
    RegionSeed("no-vestfold", "NO", "Vestfold", 10, 47, 76),
    RegionSeed("no-buskerud", "NO", "Buskerud", 11, 45, 63),
    RegionSeed("no-innlandet", "NO", "Innlandet", 12, 58, 52),
    RegionSeed("no-akershus", "NO", "Akershus", 13, 63, 61),
    RegionSeed("no-oslo", "NO", "Oslo", 14, 67, 65),
    RegionSeed("no-ostfold", "NO", "Østfold", 15, 74, 73),
)


def sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def sql_literal(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    return sql_string(str(value))


def normalize_text(value: object | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def normalize_country_code(value: object | None) -> str | None:
    text = normalize_text(value)
    if text is None:
        return None
    if not COUNTRY_CODE_RE.fullmatch(text):
        raise ValueError("country_code must be two uppercase letters")
    return text


def normalize_region_id(value: object | None) -> str | None:
    return normalize_text(value)


def db_url_from_args(args: argparse.Namespace) -> str:
    if args.db_url:
        return args.db_url

    for env_var in ("SUPABASE_DB_URL", "DATABASE_URL"):
        value = os.environ.get(env_var)
        if value:
            return value

    raise SystemExit(
        "A database URL is required. Pass --db-url or set SUPABASE_DB_URL/DATABASE_URL/PGDATABASE."
    )


def run_supabase_query(db_url: str, sql: str) -> dict:
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as handle:
        handle.write(sql)
        sql_path = Path(handle.name)

    try:
        proc = subprocess.run(
            [
                "supabase",
                "db",
                "query",
                "--db-url",
                db_url,
                "-o",
                "json",
                "-f",
                str(sql_path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
    finally:
        try:
            sql_path.unlink()
        except FileNotFoundError:
            pass

    if proc.returncode != 0:
        stderr = proc.stderr.strip()
        stdout = proc.stdout.strip()
        message = stderr or stdout or "supabase db query failed"
        raise SystemExit(message)

    output = proc.stdout.strip()
    if not output:
        return {}

    return json.loads(output)


def query_rows(db_url: str, sql: str) -> list[dict]:
    result = run_supabase_query(db_url, sql)
    rows = result.get("rows")
    if rows is None:
        return []
    if not isinstance(rows, list):
        raise SystemExit("Unexpected Supabase query result shape: rows is not a list")
    return rows


def export_headers(include_gps: bool) -> list[str]:
    headers = [
        "id",
        "genus",
        "species",
        "species_name",
        "observed_on",
        "location",
        "location_precision",
        "existing_country_code",
        "existing_region_id",
        "suggested_country_code",
        "suggested_region_id",
    ]
    if include_gps:
        headers.extend(["gps_latitude", "gps_longitude"])
    return headers


def default_export_path(include_gps: bool) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%SZ")
    prefix = "admin-public-geography" if include_gps else "public-geography"
    return DEFAULT_EXPORT_DIR / f"{prefix}-{stamp}.csv"


def build_export_row(row: dict, include_gps: bool) -> dict[str, object]:
    genus = normalize_text(row.get("genus"))
    species = normalize_text(row.get("species"))
    species_name = normalize_text(row.get("species_name"))
    if species_name is None:
        parts = [part for part in (genus, species) if part]
        species_name = " ".join(parts) or None

    export_row = {
        "id": row.get("id"),
        "genus": genus,
        "species": species,
        "species_name": species_name,
        "observed_on": row.get("observed_on"),
        "location": normalize_text(row.get("location")),
        "location_precision": normalize_text(row.get("location_precision")),
        "existing_country_code": normalize_text(row.get("existing_country_code")),
        "existing_region_id": normalize_text(row.get("existing_region_id")),
        "suggested_country_code": normalize_text(row.get("suggested_country_code")) or "",
        "suggested_region_id": normalize_text(row.get("suggested_region_id")) or "",
    }
    if include_gps:
        export_row["gps_latitude"] = row.get("gps_latitude")
        export_row["gps_longitude"] = row.get("gps_longitude")
    return export_row


def canonical_region_row(row: dict | None) -> tuple[object | None, ...]:
    if row is None:
        return (None, None, None, None, None)
    return (
        normalize_text(row.get("country_code")),
        normalize_text(row.get("label")),
        row.get("sort_order"),
        row.get("map_x"),
        row.get("map_y"),
    )


def format_display_value(value: object | None) -> str:
    if value is None:
        return "NULL"
    return str(value)


def build_region_upsert_sql(rows: Iterable[RegionSeed]) -> str:
    values_sql = ",\n    ".join(
        "("
        + ", ".join(
            sql_literal(value)
            for value in (row.id, row.country_code, row.label, row.sort_order, row.map_x, row.map_y)
        )
        + ")"
        for row in rows
    )
    return f"""
WITH input(id, country_code, label, sort_order, map_x, map_y) AS (
  VALUES
    {values_sql}
)
INSERT INTO public.public_regions (id, country_code, label, sort_order, map_x, map_y)
SELECT id, country_code, label, sort_order, map_x, map_y
FROM input
ON CONFLICT (id) DO UPDATE
SET country_code = EXCLUDED.country_code,
    label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    map_x = EXCLUDED.map_x,
    map_y = EXCLUDED.map_y
RETURNING id;
""".strip()


def region_changes(existing_rows: list[dict]) -> tuple[list[RegionSeed], list[tuple[RegionSeed, tuple[object | None, ...], tuple[object | None, ...]]]]:
    existing_by_id = {normalize_text(row.get("id")): row for row in existing_rows if normalize_text(row.get("id"))}
    upserts: list[RegionSeed] = []
    diffs: list[tuple[RegionSeed, tuple[object | None, ...], tuple[object | None, ...]]] = []

    for row in NORWAY_REGION_SEEDS:
        existing = existing_by_id.get(row.id)
        desired = (row.country_code, row.label, row.sort_order, row.map_x, row.map_y)
        current = canonical_region_row(existing)
        if existing is None or current != desired:
            upserts.append(row)
            diffs.append((row, current, desired))

    return upserts, diffs


def parse_review_update(row: dict, row_number: int) -> ReviewUpdate:
    if "id" not in row:
        raise ValueError(f"row {row_number}: missing id column")

    id_text = normalize_text(row.get("id"))
    if id_text is None or not id_text.isdigit():
        raise ValueError(f"row {row_number}: id must be a positive integer")

    observation_id = int(id_text)
    country_code = normalize_country_code(
        row.get("suggested_country_code") if normalize_text(row.get("suggested_country_code")) is not None else row.get("country_code")
    )
    region_id = normalize_region_id(
        row.get("suggested_region_id") if normalize_text(row.get("suggested_region_id")) is not None else row.get("region_id")
    )
    return ReviewUpdate(
        row_number=row_number,
        observation_id=observation_id,
        country_code=country_code,
        region_id=region_id,
    )


def build_review_update_sql(updates: list[ReviewUpdate]) -> str:
    values_sql = ",\n    ".join(
        "(" + ", ".join(sql_literal(value) for value in (row.observation_id, row.country_code, row.region_id)) + ")"
        for row in updates
    )
    return f"""
WITH input(id, country_code, region_id) AS (
  VALUES
    {values_sql}
),
validated AS (
  SELECT i.id, i.country_code, i.region_id
  FROM input i
  JOIN public.observations o
    ON o.id = i.id
  LEFT JOIN public.public_regions r
    ON r.id = i.region_id
  WHERE (i.country_code IS NULL OR i.country_code ~ '^[A-Z]{{2}}$')
    AND (i.region_id IS NULL OR r.id IS NOT NULL)
)
UPDATE public.observations o
SET country_code = COALESCE(validated.country_code, o.country_code),
    region_id = COALESCE(validated.region_id, o.region_id)
FROM validated
WHERE o.id = validated.id
RETURNING o.id, o.country_code, o.region_id;
""".strip()


def load_review_updates(path: Path) -> tuple[list[ReviewUpdate], list[str]]:
    updates: list[ReviewUpdate] = []
    errors: list[str] = []
    seen_ids: set[int] = set()

    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise SystemExit(f"{path} does not contain a CSV header row")

        for row in reader:
            if not any(normalize_text(value) for value in row.values()):
                continue
            try:
                update = parse_review_update(row, reader.line_num)
            except ValueError as exc:
                errors.append(str(exc))
                continue

            if update.observation_id in seen_ids:
                errors.append(f"row {reader.line_num}: duplicate observation id {update.observation_id}")
                continue
            seen_ids.add(update.observation_id)
            updates.append(update)

    return updates, errors


def query_current_observations(db_url: str, observation_ids: list[int]) -> dict[int, dict]:
    if not observation_ids:
        return {}
    values_sql = ", ".join(sql_literal(obs_id) for obs_id in observation_ids)
    sql = f"""
SELECT
  o.id,
  o.country_code,
  o.region_id
FROM public.observations o
WHERE o.id IN ({values_sql});
""".strip()
    rows = query_rows(db_url, sql)
    return {int(row["id"]): row for row in rows}


def query_review_validation(db_url: str, updates: list[ReviewUpdate]) -> list[dict]:
    if not updates:
        return []
    values_sql = ",\n    ".join(
        "(" + ", ".join(sql_literal(value) for value in (row.row_number, row.observation_id, row.country_code, row.region_id)) + ")"
        for row in updates
    )
    sql = f"""
WITH input(row_num, id, country_code, region_id) AS (
  VALUES
    {values_sql}
)
SELECT
  i.row_num,
  i.id,
  (o.id IS NOT NULL) AS observation_exists,
  (i.country_code IS NULL OR i.country_code ~ '^[A-Z]{{2}}$') AS country_code_valid,
  (i.region_id IS NULL OR r.id IS NOT NULL) AS region_exists
FROM input i
LEFT JOIN public.observations o
  ON o.id = i.id
LEFT JOIN public.public_regions r
  ON r.id = i.region_id
ORDER BY i.row_num, i.id;
""".strip()
    return query_rows(db_url, sql)


def cmd_seed_regions(db_url: str, apply: bool) -> int:
    region_ids_sql = ", ".join(sql_literal(row.id) for row in NORWAY_REGION_SEEDS)
    existing_rows = query_rows(
        db_url,
        f"""
SELECT id, country_code, label, sort_order, map_x, map_y
FROM public.public_regions
WHERE id IN ({region_ids_sql})
ORDER BY sort_order NULLS LAST, id;
""".strip(),
    )
    upserts, diffs = region_changes(existing_rows)

    print(f"Norway regions defined: {len(NORWAY_REGION_SEEDS)}")
    print(f"Rows needing write: {len(upserts)}")
    for row, current, desired in diffs:
        if current == (None, None, None, None, None):
            action = "insert"
        else:
            action = "update"
        print(
            f"  - {row.id}: {action} "
            f"country_code={format_display_value(current[0])}->{format_display_value(desired[0])}, "
            f"label={format_display_value(current[1])}->{format_display_value(desired[1])}, "
            f"sort_order={format_display_value(current[2])}->{format_display_value(desired[2])}, "
            f"map_x={format_display_value(current[3])}->{format_display_value(desired[3])}, "
            f"map_y={format_display_value(current[4])}->{format_display_value(desired[4])}"
        )

    if not apply:
        if not upserts:
            print("No region rows need changes.")
        else:
            print("Dry-run only. Re-run with --apply to write the region seed rows.")
        return 0

    if not upserts:
        print("No region rows need changes.")
        return 0

    result = query_rows(db_url, build_region_upsert_sql(upserts))
    print(f"Applied region upsert for {len(result)} row(s).")
    return 0


def cmd_export_missing(db_url: str, include_gps: bool, output_path: Path | None) -> int:
    sql = """
SELECT
  o.id,
  nullif(btrim(coalesce(o.genus, '')), '') AS genus,
  nullif(btrim(coalesce(o.species, '')), '') AS species,
  nullif(btrim(concat_ws(' ', o.genus, o.species)), '') AS species_name,
  o.date AS observed_on,
  nullif(btrim(coalesce(o.location, '')), '') AS location,
  o.location_precision,
  nullif(btrim(coalesce(o.country_code, '')), '') AS existing_country_code,
  nullif(btrim(coalesce(o.region_id, '')), '') AS existing_region_id,
  ''::text AS suggested_country_code,
  ''::text AS suggested_region_id%s
FROM public.observations o
WHERE o.visibility = 'public'::text
  AND NOT coalesce(o.is_draft, false)
  AND (
    nullif(btrim(coalesce(o.country_code, '')), '') IS NULL
    OR nullif(btrim(coalesce(o.region_id, '')), '') IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = o.user_id
      AND p.is_banned = true
  )
ORDER BY o.date DESC NULLS LAST, o.id DESC;
""" % (
        ",\n  o.gps_latitude AS gps_latitude,\n  o.gps_longitude AS gps_longitude" if include_gps else "",
    )
    rows = query_rows(db_url, sql)

    destination = output_path or default_export_path(include_gps)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=export_headers(include_gps))
        writer.writeheader()
        for row in rows:
            writer.writerow(build_export_row(row, include_gps))

    print(f"Wrote {len(rows)} row(s) to {destination}")
    if include_gps:
        print("GPS columns were included. Treat this CSV as private/admin-only.")
    return 0


def cmd_apply_csv(db_url: str, path: Path, apply: bool) -> int:
    updates, parse_errors = load_review_updates(path)
    validation_rows = query_review_validation(db_url, updates)
    current_rows = query_current_observations(db_url, [update.observation_id for update in updates])

    validation_by_id = {int(row["id"]): row for row in validation_rows}

    invalid_messages: list[str] = []
    apply_rows: list[ReviewUpdate] = []

    for update in updates:
        validation = validation_by_id.get(update.observation_id)
        if validation is None:
            invalid_messages.append(f"row {update.row_number}: observation id {update.observation_id} was not validated")
            continue
        if not validation["observation_exists"]:
            invalid_messages.append(f"row {update.row_number}: observation id {update.observation_id} does not exist")
        if not validation["country_code_valid"]:
            invalid_messages.append(
                f"row {update.row_number}: country_code {update.country_code!r} is not a valid uppercase two-letter code"
            )
        if not validation["region_exists"]:
            invalid_messages.append(
                f"row {update.row_number}: region_id {update.region_id!r} does not exist in public.public_regions"
            )

        if validation["observation_exists"] and validation["country_code_valid"] and validation["region_exists"]:
            current = current_rows.get(update.observation_id, {})
            current_country = normalize_text(current.get("country_code"))
            current_region = normalize_text(current.get("region_id"))
            if update.country_code == current_country and update.region_id == current_region:
                continue
            apply_rows.append(update)

    print(f"CSV rows read: {len(updates)}")
    print(f"Rows with proposed updates: {len(apply_rows)}")
    print(f"Rows with validation errors: {len(invalid_messages) + len(parse_errors)}")

    for update in apply_rows:
        current = current_rows.get(update.observation_id, {})
        print(
            f"  - id {update.observation_id} (row {update.row_number}): "
            f"country_code {format_display_value(normalize_text(current.get('country_code')))} -> {format_display_value(update.country_code)}, "
            f"region_id {format_display_value(normalize_text(current.get('region_id')))} -> {format_display_value(update.region_id)}"
        )

    for message in parse_errors + invalid_messages:
        print(f"  ! {message}")

    if parse_errors or invalid_messages:
        raise SystemExit(1)

    if not apply:
        if not apply_rows:
            print("No observation rows need changes.")
        else:
            print("Dry-run only. Re-run with --apply to write the reviewed CSV.")
        return 0

    if not apply_rows:
        print("No observation rows need changes.")
        return 0

    result = query_rows(db_url, build_review_update_sql(apply_rows))
    print(f"Applied {len(result)} observation row update(s).")
    return 0


def cmd_audit(db_url: str) -> int:
    sql = """
WITH public_obs AS (
  SELECT
    o.id,
    o.country_code,
    o.region_id,
    o.location_precision,
    o.location
  FROM public.observations o
  WHERE o.visibility = 'public'::text
    AND NOT coalesce(o.is_draft, false)
    AND NOT EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = o.user_id
        AND p.is_banned = true
    )
)
SELECT
  count(*)::bigint AS public_observations_total,
  count(*) FILTER (WHERE nullif(btrim(coalesce(country_code, '')), '') IS NOT NULL)::bigint AS with_country,
  count(*) FILTER (WHERE nullif(btrim(coalesce(region_id, '')), '') IS NOT NULL)::bigint AS with_region,
  count(*) FILTER (WHERE location_precision = 'exact'::text)::bigint AS exact_locations,
  count(*) FILTER (WHERE location_precision = 'fuzzed'::text)::bigint AS fuzzed_locations,
  count(*) FILTER (WHERE location_precision = 'region'::text)::bigint AS region_locations,
  count(*) FILTER (WHERE location_precision = 'hidden'::text)::bigint AS hidden_locations,
  count(*) FILTER (
    WHERE location_precision IS NULL
      OR location_precision NOT IN ('exact'::text, 'fuzzed'::text, 'region'::text, 'hidden'::text)
  )::bigint AS other_location_precision,
  count(*) FILTER (
    WHERE nullif(btrim(coalesce(region_id, '')), '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.public_regions r
        WHERE r.id = public_obs.region_id
      )
  )::bigint AS invalid_region_refs,
  count(*) FILTER (
    WHERE location_precision = 'region'::text
      AND nullif(btrim(coalesce(region_id, '')), '') IS NULL
  )::bigint AS missing_region_refs,
  count(*) FILTER (
    WHERE location_precision = 'exact'::text
      AND nullif(btrim(coalesce(location, '')), '') IS NOT NULL
  )::bigint AS exact_public_location_labels
FROM public_obs;
"""
    row = query_rows(db_url, sql)[0]
    print(f"Public observations total: {row['public_observations_total']}")
    print(f"With country: {row['with_country']}")
    print(f"With region: {row['with_region']}")
    print(f"Location precision counts:")
    print(f"  exact: {row['exact_locations']}")
    print(f"  fuzzed: {row['fuzzed_locations']}")
    print(f"  region: {row['region_locations']}")
    print(f"  hidden: {row['hidden_locations']}")
    print(f"  other: {row['other_location_precision']}")
    print(f"Invalid region references: {row['invalid_region_refs']}")
    print(f"Missing region references: {row['missing_region_refs']}")
    print(f"Public exact location labels: {row['exact_public_location_labels']}")
    if int(row["exact_public_location_labels"]) > 0:
        print("WARNING: exact public observations expose exact locationLabel in the public RPC.")
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--db-url",
        help="Direct Postgres connection string for the target database. If omitted, falls back to SUPABASE_DB_URL, DATABASE_URL, then PGDATABASE.",
    )
    common.add_argument(
        "--apply",
        action="store_true",
        help="Write changes for seed-regions or apply-csv. Without this flag those modes are dry-run only.",
    )

    parser = argparse.ArgumentParser(
        description="Backfill public explorer geography without touching public-facing fields automatically.",
        parents=[common],
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("seed-regions", parents=[common], help="Seed public.public_regions with Norway county rows.")

    export_parser = subparsers.add_parser(
        "export-missing",
        parents=[common],
        help="Export public observations missing country_code or region_id.",
    )
    export_parser.add_argument(
        "--output",
        type=Path,
        help="Destination CSV path. Defaults to exports/public-geography-<timestamp>.csv.",
    )
    export_parser.add_argument(
        "--include-gps",
        action="store_true",
        help="Include raw GPS columns in the CSV. The default output filename is marked admin-only.",
    )

    apply_parser = subparsers.add_parser(
        "apply-csv",
        parents=[common],
        help="Apply reviewed country_code and region_id updates from a CSV file.",
    )
    apply_parser.add_argument("input_csv", type=Path, help="Reviewed CSV exported by export-missing.")

    subparsers.add_parser("audit", parents=[common], help="Print coverage and privacy audits for public observations.")

    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    db_url = db_url_from_args(args)

    if args.command == "seed-regions":
        return cmd_seed_regions(db_url, args.apply)
    if args.command == "export-missing":
        return cmd_export_missing(db_url, args.include_gps, args.output)
    if args.command == "apply-csv":
        return cmd_apply_csv(db_url, args.input_csv, args.apply)
    if args.command == "audit":
        return cmd_audit(db_url)

    raise SystemExit(f"Unknown command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
