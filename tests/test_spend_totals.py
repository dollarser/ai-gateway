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
            html = (output / "index.html").read_text() + (
                output / "captcha.html"
            ).read_text()
            html += (output / "admin/index.html").read_text()
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
                len(list(output.rglob("*"))), 2 * len(FILES) + 6
            )  # Two asset aliases each, two directories, three HTML pages, headers


class WriteReductionTests(unittest.TestCase):
    def database(self, through="0017"):
        db = sqlite3.connect(":memory:")
        for file in sorted((ROOT / "cloudflare/migrations").glob("*.sql")):
            if file.name[:4] > through:
                break
            db.executescript(file.read_text())
        db.execute(
            "INSERT INTO users(username,password,role,services,rpm,daily_requests,concurrency,created,luna_monthly_tokens) VALUES('write-fixture','unused','user','[\"qwen\"]',0,0,10,0,10000000)"
        )
        return db

    def test_legacy_cost_normalization_and_noop_settlement(self):
        db = self.database()
        try:
            uid = db.execute("SELECT id FROM users").fetchone()[0]
            db.execute(
                "INSERT INTO requests(id,user_id,service,path,started,day) VALUES('legacy-write',?,'qwen','/v1/chat/completions',unixepoch(),'2026-11-16')",
                (uid,),
            )
            db.execute(
                "INSERT INTO luna_usage(lease,user_id,month,reserved_tokens,charged_tokens,prompt_tokens,completion_tokens) VALUES('legacy-write',?,'2026-11',100,100,50,50)",
                (uid,),
            )
            self.assertEqual(
                db.execute("SELECT cost_nanos,settled FROM luna_spend").fetchone(),
                (31250, 0),
            )
            db.execute(
                "UPDATE luna_usage SET charged_tokens=30,settled=1,prompt_tokens=20,completion_tokens=10 WHERE lease='legacy-write'"
            )
            self.assertEqual(
                db.execute("SELECT cost_nanos,settled FROM luna_spend").fetchone(),
                (7000, 1),
            )
            self.assertEqual(
                db.execute(
                    "SELECT cost_nanos,reserved_cost_nanos FROM luna_spend_totals"
                ).fetchone(),
                (7000, 0),
            )
            before = db.total_changes
            db.execute(
                "UPDATE luna_usage SET settled=1,prompt_tokens=20,completion_tokens=10,charged_cost_nanos=7000 WHERE lease='legacy-write'"
            )
            self.assertEqual(
                db.total_changes - before, 1
            )  # only the explicitly requested usage update
        finally:
            db.close()

    def test_catalog_migration_preserves_today_inflight_and_adjustment_linked_records(
        self,
    ):
        db = self.database()
        try:
            uid = db.execute("SELECT id FROM users").fetchone()[0]
            for name, ended, day in [
                ("archive", 1, "2000-01-01"),
                ("inflight", None, "2000-01-01"),
                ("today", 1, db.execute("SELECT date('now','+8 hours')").fetchone()[0]),
                ("protected", 1, "2000-01-01"),
            ]:
                db.execute(
                    "INSERT INTO requests(id,user_id,service,path,started,day,ended,status,response_bytes) VALUES(?,?,'qwen','/v1/models',0,?,?,200,12)",
                    (name, uid, day, ended),
                )
            db.execute(
                "INSERT INTO quota_adjustments(id,kind,lease,actor,user_id,previous_units,new_units,reason,created) VALUES('protect','luna','protected',?,?,1,1,'fixture',0)",
                (uid, uid),
            )
            db.executescript(
                (
                    ROOT / "cloudflare/migrations/0018_compact_legacy_catalog.sql"
                ).read_text()
            )
            self.assertEqual(
                {r[0] for r in db.execute("SELECT id FROM requests")},
                {"inflight", "today", "protected"},
            )
            self.assertEqual(
                db.execute(
                    "SELECT total,response_bytes FROM request_history"
                ).fetchone(),
                (1, 12),
            )
            self.assertEqual(
                db.execute("SELECT count(*) FROM quota_adjustments").fetchone()[0], 1
            )
        finally:
            db.close()


class PersonalCloudTotalsTests(unittest.TestCase):
    def test_backfill_and_budget_enforcement_preserve_existing_balances(self):
        from scripts.ops.check_spend_totals import PERSONAL_QUERY

        db = sqlite3.connect(":memory:")
        for file in sorted((ROOT / "cloudflare/migrations").glob("*.sql")):
            if file.name.startswith("0023_"):
                break
            db.executescript(file.read_text())
        db.execute(
            "INSERT INTO users(id,username,password,role,services,rpm,daily_requests,concurrency,must_change,created,luna_monthly_tokens) VALUES(100,'summary-test','unused','user','[\"qwen\"]',0,0,10,0,unixepoch(),1000)"
        )
        period = db.execute("SELECT strftime('%Y-%m','now','+8 hours')").fetchone()[0]
        for lease, charged, settled in [("first", 100, 0), ("second", 30, 1)]:
            db.execute(
                "INSERT INTO requests(id,user_id,service,path,started,day) VALUES(?,100,'qwen','/v1/chat/completions',unixepoch(),date('now','+8 hours'))",
                (lease,),
            )
            db.execute(
                "INSERT INTO luna_usage(lease,user_id,month,reserved_tokens,charged_tokens,settled,prompt_tokens) VALUES(?,100,?,?,?,?,?)",
                (lease, period, charged, charged, settled, charged),
            )
        db.executescript(
            (ROOT / "cloudflare/migrations/0023_resource_efficiency.sql").read_text()
        )
        self.assertEqual(
            db.execute(
                "SELECT used_tokens,reserved_tokens,requests FROM luna_user_month_totals WHERE user_id=100"
            ).fetchone(),
            (130, 100, 2),
        )
        self.assertEqual(db.execute(PERSONAL_QUERY).fetchone()[0], 0)
        db.execute("UPDATE users SET luna_monthly_tokens=130 WHERE id=100")
        db.execute(
            "INSERT INTO requests(id,user_id,service,path,started,day) VALUES('over',100,'qwen','/v1/chat/completions',unixepoch(),date('now','+8 hours'))"
        )
        with self.assertRaisesRegex(sqlite3.IntegrityError, "luna_budget_exhausted"):
            db.execute(
                "INSERT INTO luna_usage(lease,user_id,month,reserved_tokens,charged_tokens,prompt_tokens) VALUES('over',100,?,1,1,1)",
                (period,),
            )
        db.execute(
            "UPDATE luna_usage SET charged_tokens=50,settled=1,prompt_tokens=50 WHERE lease='first'"
        )
        self.assertEqual(
            db.execute(
                "SELECT used_tokens,reserved_tokens FROM luna_user_month_totals WHERE user_id=100"
            ).fetchone(),
            (80, 0),
        )
        db.execute("UPDATE luna_usage SET month='2000-01' WHERE lease='first'")
        self.assertEqual(db.execute(PERSONAL_QUERY).fetchone()[0], 0)
        db.execute("DELETE FROM luna_usage WHERE lease='first'")
        self.assertEqual(db.execute(PERSONAL_QUERY).fetchone()[0], 0)
        self.assertIsNotNone(
            db.execute("SELECT lease FROM luna_spend WHERE lease='first'").fetchone()
        )
        db.close()
