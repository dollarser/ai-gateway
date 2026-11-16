"""Accounting migration preserves history and mirrors ledger mutations atomically."""

import sqlite3
from pathlib import Path
import tempfile
import unittest

from scripts.ops.build_assets import build, FILES

ROOT = Path(__file__).resolve().parents[1]


class SpendTotalsTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        for file in sorted((ROOT / "cloudflare/migrations").glob("*.sql")):
            if file.name.startswith("0016_"):
                break
            self.db.executescript(file.read_text())
        self.db.execute("INSERT INTO luna_spend VALUES('old-a','2026-11',100,0)")
        self.db.execute("INSERT INTO luna_spend VALUES('old-b','2026-11',200,1)")
        self.db.execute(
            "INSERT INTO audio_spend VALUES('old-a','2026-11-16','asr',1000,0)"
        )
        self.db.executescript(
            (ROOT / "cloudflare/migrations/0016_spend_totals.sql").read_text()
        )

    def tearDown(self):
        self.db.close()

    def luna(self, month="2026-11"):
        return self.db.execute(
            "SELECT cost_nanos,reserved_cost_nanos FROM luna_spend_totals WHERE month=?",
            (month,),
        ).fetchone()

    def test_backfill_deltas_rollback_and_duplicate_safety(self):
        self.assertEqual(self.luna(), (300, 100))
        self.db.execute(
            "UPDATE luna_spend SET cost_nanos=40,settled=1 WHERE lease='old-a'"
        )
        self.assertEqual(self.luna(), (240, 0))
        self.db.execute("SAVEPOINT adjustment")
        self.db.execute("UPDATE luna_spend SET cost_nanos=0 WHERE lease='old-b'")
        self.assertEqual(self.luna(), (40, 0))
        self.db.execute("ROLLBACK TO adjustment")
        self.assertEqual(self.luna(), (240, 0))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO luna_spend VALUES('old-a','2026-11',100,0)")
        self.assertEqual(self.luna(), (240, 0))
        self.db.execute("UPDATE luna_spend SET month='2026-12' WHERE lease='old-b'")
        self.assertEqual(self.luna(), (40, 0))
        self.assertEqual(self.luna("2026-12"), (200, 0))
        self.db.execute("DELETE FROM luna_spend WHERE lease='old-b'")
        self.assertEqual(self.luna("2026-12"), (0, 0))

    def test_audio_settlement_moves_and_deletion(self):
        self.assertEqual(
            self.db.execute(
                "SELECT units,reserved_units FROM audio_spend_totals"
            ).fetchone(),
            (1000, 1000),
        )
        self.db.execute(
            "UPDATE audio_spend SET units=600,settled=1 WHERE lease='old-a'"
        )
        self.assertEqual(
            self.db.execute(
                "SELECT units,reserved_units FROM audio_spend_totals"
            ).fetchone(),
            (600, 0),
        )
        self.db.execute(
            "UPDATE audio_spend SET day='2026-11-17',kind='tts' WHERE lease='old-a'"
        )
        self.assertEqual(
            self.db.execute(
                "SELECT units FROM audio_spend_totals WHERE day='2026-11-16'"
            ).fetchone(),
            (0,),
        )
        self.assertEqual(
            self.db.execute(
                "SELECT units FROM audio_spend_totals WHERE kind='tts'"
            ).fetchone(),
            (600,),
        )
        self.db.execute("DELETE FROM audio_spend WHERE lease='old-a'")
        self.assertEqual(
            self.db.execute("SELECT sum(units) FROM audio_spend_totals").fetchone(),
            (0,),
        )


class PublicAssetsTests(unittest.TestCase):
    def test_only_public_files_built_with_hashes_and_security_headers(self):
        with tempfile.TemporaryDirectory() as directory:
            output = build(Path(directory) / "portal")
            html = (output / "index.html").read_text()
            headers = (output / "_headers").read_text()
            for name in FILES:
                self.assertNotIn("/static/" + name + '"', html)
                stem, suffix = name.rsplit(".", 1)
                hashed = list((output / "static").glob(stem + ".*." + suffix))
                self.assertEqual(len(hashed), 1)
                self.assertEqual(
                    hashed[0].read_bytes(),
                    (ROOT / "accounts/static" / name).read_bytes(),
                )
                self.assertIn("/static/" + hashed[0].name, html)
                self.assertIn("/static/" + hashed[0].name, headers)
            self.assertIn("frame-ancestors", headers)
            self.assertIn("immutable", headers)
            self.assertEqual(
                len(list(output.rglob("*"))), 11
            )  # static dir + 8 files + HTML + headers
