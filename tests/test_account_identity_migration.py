"""Canonical email identity migration must preserve stable IDs and all child data."""

import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "cloudflare/migrations/0024_account_identity.sql"


class AccountIdentityMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys=ON")
        for file in sorted((ROOT / "cloudflare/migrations").glob("*.sql")):
            if file.name.startswith("0024"):
                break
            self.db.executescript(file.read_text())
        self.db.execute(
            "INSERT INTO users(id,username,password,role,services,rpm,daily_requests,concurrency,must_change,created,email) VALUES(10,'old-name','password-hash','admin','[\"qwen\"]',0,0,4,0,123,'owner@example.net')"
        )
        self.db.execute("INSERT INTO auth_families VALUES('family',10,9999999999,0)")
        self.db.execute(
            "INSERT INTO access_tokens VALUES('access','family',9999999999)"
        )
        self.db.execute(
            "INSERT INTO refresh_tokens VALUES('refresh','family',9999999999,0)"
        )
        self.db.execute(
            "INSERT INTO sessions(hash,user_id,csrf,expires,family_id) VALUES('session',10,'csrf',9999999999,'family')"
        )
        self.db.execute(
            "INSERT INTO keys(id,user_id,name,hash,prefix,services,expires,created) VALUES(20,10,'key','key-hash','prefix','[\"qwen\"]',9999999999,123)"
        )
        self.db.execute(
            "INSERT INTO requests(id,user_id,key_id,service,path,started,day,ended,status) VALUES('request',10,20,'qwen','/v1/chat/completions',123,'2026-01-01',NULL,NULL)"
        )
        self.db.execute(
            "INSERT INTO customer_notices(id,title,body,state,starts_at,created,updated,published_at) VALUES('notice','Welcome','body','published',123,123,123,123)"
        )
        self.db.execute("INSERT INTO customer_notice_reads VALUES('notice',10,456)")
        self.db.execute(
            "INSERT INTO luna_usage(lease,user_id,month,reserved_tokens,charged_tokens,settled) VALUES('request',10,'2026-01',100,50,1)"
        )
        self.db.execute("INSERT INTO luna_spend VALUES('global-lease','2026-01',123,1)")
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def rows(self, table):
        return sorted(
            self.db.execute('SELECT * FROM "' + table + '"').fetchall(), key=repr
        )

    def migrate(self):
        self.db.executescript("BEGIN;" + MIGRATION.read_text() + "COMMIT;")

    def test_rebuild_preserves_every_row_foreign_key_and_accounting_total(self):
        tables = [
            r[0]
            for r in self.db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        ]
        before = {table: self.rows(table) for table in tables}
        self.migrate()
        for table in tables:
            if table != "users":
                self.assertEqual(self.rows(table), before[table], table)
        self.assertEqual(self.rows("users")[0][:-1], before["users"][0])
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(
            self.db.execute(
                "SELECT count(*) FROM sqlite_master WHERE name LIKE '__identity_backup_%'"
            ).fetchone()[0],
            0,
        )
        self.assertNotIn(
            "username", [r[1] for r in self.db.execute("PRAGMA table_info(users)")]
        )

    def test_failed_cutover_rolls_back_schema_and_rows(self):
        before = self.rows("users")
        with self.assertRaises(sqlite3.OperationalError):
            self.db.executescript(
                "BEGIN;"
                + MIGRATION.read_text()
                + "SELECT * FROM nonexistent_cutover_guard;COMMIT;"
            )
        self.db.rollback()
        self.assertEqual(self.rows("users"), before)
        self.assertIn(
            "username", [r[1] for r in self.db.execute("PRAGMA table_info(users)")]
        )
        self.assertEqual(
            self.db.execute("SELECT count(*) FROM customer_notice_reads").fetchone()[0],
            1,
        )
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_duplicate_display_names_unique_email_and_never_reused_ids(self):
        self.migrate()
        sql = "INSERT INTO users(display_name,password,role,services,rpm,daily_requests,concurrency,created,email) VALUES('old-name','hash','user','[]',0,0,1,123,?) RETURNING id"
        uid = self.db.execute(sql, ("second@example.net",)).fetchone()[0]
        self.assertGreater(uid, 10)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE users SET id=999 WHERE id=10")
        self.db.execute("DELETE FROM users WHERE id=?", (uid,))
        next_id = self.db.execute(sql, ("third@example.net",)).fetchone()[0]
        self.assertGreater(next_id, uid)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(sql, ("OWNER@example.net",))
        self.assertEqual(
            self.db.execute(
                "SELECT count(*) FROM users WHERE display_name='old-name'"
            ).fetchone()[0],
            2,
        )
