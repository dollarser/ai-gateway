from pathlib import Path
import sqlite3
import tempfile
import unittest
from accounts.store import Store, check_password
from scripts.migrations.export_d1 import export, ROOT


class D1ExportTests(unittest.TestCase):
    def test_legacy_users_keys_and_password_hashes_survive_migration(self):
        with tempfile.TemporaryDirectory() as name:
            source = Path(name) / "source.db"
            store = Store(source)
            u = store.create_user(
                "legacy-admin", "test-password", role="admin", must_change=False
            )
            raw, kid = store.create_key(u["id"], "legacy-key", ["asr"], 1)
            store.db.close()
            output = Path(name) / "accounts.migration.sql"
            export(source, output)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            db = sqlite3.connect(":memory:")
            db.executescript(
                (ROOT / "cloudflare/migrations/0001_accounts.sql").read_text()
            )
            db.executescript(output.read_text())
            self.assertTrue(
                check_password(
                    "test-password",
                    db.execute("select password from users").fetchone()[0],
                )
            )
            self.assertEqual(db.execute("select id from keys").fetchone()[0], kid)
            self.assertEqual(db.execute("pragma foreign_key_check").fetchall(), [])
            self.assertEqual(
                db.execute(
                    "select count(*) from sqlite_master where type='trigger'"
                ).fetchone()[0],
                2,
            )
            with self.assertRaises(FileExistsError):
                export(source, output)
