from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "backfill_public_geography.py"
SPEC = importlib.util.spec_from_file_location("backfill_public_geography", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class BackfillPublicGeographyTests(unittest.TestCase):
    def test_seed_regions_are_stable(self) -> None:
        seeds = MODULE.NORWAY_REGION_SEEDS
        self.assertEqual(len(seeds), 15)
        self.assertEqual(seeds[0].id, "no-finnmark")
        self.assertIn("no-vestland", [seed.id for seed in seeds])

    def test_sql_literal_escapes_quotes(self) -> None:
        self.assertEqual(MODULE.sql_literal("O'Reilly"), "'O''Reilly'")

    def test_export_headers_toggle_gps(self) -> None:
        self.assertNotIn("gps_latitude", MODULE.export_headers(False))
        self.assertEqual(MODULE.export_headers(True)[-2:], ["gps_latitude", "gps_longitude"])

    def test_default_export_path_marks_admin_gps_exports(self) -> None:
        self.assertTrue(MODULE.default_export_path(True).name.startswith("admin-public-geography-"))
        self.assertTrue(MODULE.default_export_path(False).name.startswith("public-geography-"))

    def test_parse_review_update_prefers_suggested_columns(self) -> None:
        update = MODULE.parse_review_update(
            {
                "id": "42",
                "country_code": "DE",
                "region_id": "no-vestland",
                "suggested_country_code": "NO",
                "suggested_region_id": "no-trondelag",
            },
            3,
        )
        self.assertEqual(update.observation_id, 42)
        self.assertEqual(update.country_code, "NO")
        self.assertEqual(update.region_id, "no-trondelag")

    def test_parse_review_update_rejects_lowercase_country_code(self) -> None:
        with self.assertRaises(ValueError):
            MODULE.parse_review_update({"id": "1", "suggested_country_code": "no"}, 2)

    def test_norway_region_normalization_maps_common_county_names(self) -> None:
        self.assertEqual(MODULE.normalize_norway_region_name("Trøndelag"), "trondelag")
        self.assertEqual(MODULE.resolve_norway_region_id("Trøndelag"), "no-trondelag")
        self.assertEqual(MODULE.resolve_norway_region_id("Møre og Romsdal County"), "no-more-og-romsdal")
        self.assertEqual(MODULE.resolve_norway_region_id("Innlandet"), "no-innlandet")

    def test_build_coordinate_backfill_plan_uses_mocked_geocode_payloads(self) -> None:
        rows = [
            {
                "id": 101,
                "observed_on": "2026-06-26",
                "genus": "Russula",
                "species": "testa",
                "species_name": "Russula testa",
                "current_country_code": None,
                "current_region_id": None,
                "gps_latitude": 63.4305,
                "gps_longitude": 10.3951,
                "location_precision": "exact",
            },
            {
                "id": 102,
                "observed_on": "2026-06-25",
                "genus": "Russula",
                "species": "uncertaina",
                "species_name": "Russula uncertaina",
                "current_country_code": None,
                "current_region_id": None,
                "gps_latitude": 61.0,
                "gps_longitude": 8.0,
                "location_precision": "exact",
            },
        ]

        def geocode_lookup(lat, lon):
            if round(lat, 4) == 63.4305:
                return {
                    "address": {
                        "country_code": "no",
                        "country": "Norge",
                        "county": "Trøndelag",
                    }
                }
            return {
                "address": {
                    "country_code": "no",
                    "country": "Norge",
                    "county": "Vestfold og Telemark",
                }
            }

        proposals, skipped, invalid = MODULE.build_coordinate_backfill_plan(
            rows,
            geocode_lookup,
            {"no-trondelag", "no-innlandet"},
        )

        self.assertEqual(len(proposals), 2)
        self.assertEqual(proposals[0].observation_id, 101)
        self.assertEqual(proposals[0].suggested_country_code, "NO")
        self.assertEqual(proposals[0].suggested_region_id, "no-trondelag")
        self.assertEqual(proposals[1].observation_id, 102)
        self.assertEqual(proposals[1].suggested_country_code, "NO")
        self.assertIsNone(proposals[1].suggested_region_id)
        self.assertIsNotNone(proposals[1].note)
        self.assertIn("uncertain", proposals[1].note.lower())
        self.assertEqual(invalid, [])

    def test_build_coordinate_backfill_plan_leaves_uncertain_norway_region_blank(self) -> None:
        rows = [
            {
                "id": 201,
                "observed_on": "2026-06-24",
                "genus": "Russula",
                "species": "testb",
                "species_name": "Russula testb",
                "current_country_code": None,
                "current_region_id": None,
                "gps_latitude": 60.0,
                "gps_longitude": 11.0,
                "location_precision": "exact",
            },
        ]

        def geocode_lookup(lat, lon):
            return {
                "address": {
                    "country_code": "no",
                    "country": "Norge",
                    "county": "Vestfold og Telemark",
                }
            }

        proposals, skipped, invalid = MODULE.build_coordinate_backfill_plan(
            rows,
            geocode_lookup,
            {"no-trondelag", "no-innlandet"},
        )

        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0].suggested_country_code, "NO")
        self.assertIsNone(proposals[0].suggested_region_id)
        self.assertIsNotNone(proposals[0].note)
        self.assertIn("uncertain", proposals[0].note.lower())
        self.assertEqual(invalid, [])

    def test_query_rows_accepts_list_results(self) -> None:
        with mock.patch.object(MODULE, "run_supabase_query", return_value=[{"id": 7}]):
            self.assertEqual(MODULE.query_rows("db", "select 1"), [{"id": 7}])

    def test_query_rows_accepts_dict_rows_and_data_results(self) -> None:
        cases = (
            ({"rows": [{"id": 8}]}, [{"id": 8}]),
            ({"data": [{"id": 9}]}, [{"id": 9}]),
        )
        for payload, expected in cases:
            with self.subTest(payload=payload):
                with mock.patch.object(MODULE, "run_supabase_query", return_value=payload):
                    self.assertEqual(MODULE.query_rows("db", "select 1"), expected)

    def test_query_rows_raises_on_unexpected_shape(self) -> None:
        with mock.patch.object(MODULE, "run_supabase_query", return_value={"unexpected": True}):
            with self.assertRaises(RuntimeError) as ctx:
                MODULE.query_rows("db", "select 1")
        self.assertIn("Unexpected Supabase query result shape", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
