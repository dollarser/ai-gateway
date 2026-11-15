import unittest
import sqlite3
import tempfile
from pathlib import Path
from datetime import datetime, timezone
from accounts.store import Store, digest
from scripts.migrations.migrate_legacy_gateway import migrate


class MigrationTests(unittest.TestCase):
    def test_hash_preserved_and_quota_baseline_imported_idempotently(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "old.db"
            target = root / "new.db"
            store = Store(target)
            store.create_user(
                "admin", "strong-password", role="admin", must_change=False
            )
            store.db.close()
            raw = "sk-qw-legacy-test-key"
            with sqlite3.connect(source) as db:
                db.execute(
                    "CREATE TABLE api_keys(id INTEGER PRIMARY KEY,key_hash TEXT,key_prefix TEXT,name TEXT,rpm_limit INTEGER,daily_tokens INTEGER,max_concurrent INTEGER,created_at TEXT,expires_at TEXT,revoked INTEGER,note TEXT)"
                )
                db.execute(
                    "CREATE TABLE usage_log(key_id INTEGER,ts TEXT,prompt_tokens INTEGER,completion_tokens INTEGER)"
                )
                db.execute(
                    "INSERT INTO api_keys VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        1,
                        digest(raw),
                        "sk-qw-legacy",
                        "old key",
                        60,
                        100,
                        4,
                        "2026-01-01 00:00:00",
                        None,
                        0,
                        "",
                    ),
                )
                db.execute(
                    "INSERT INTO usage_log VALUES(?,?,?,?)",
                    (1, datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"), 2, 3),
                )
            result = migrate(source, target, root / "backup")
            self.assertEqual(result["imported_keys"], 1)
            store = Store(target)
            lease = store.acquire(raw, "qwen", "/v1/chat/completions")
            self.assertEqual(store.token_remaining(lease), 95)
            store.finish(lease, 200, prompt_tokens=3, completion_tokens=4)
            self.assertEqual(store.token_remaining(lease), 88)
            store.db.close()
            result = migrate(source, target, root / "backup2")
            self.assertEqual(result["already_present"], 1)
            store = Store(target)
            self.assertEqual(
                store.db.execute("SELECT count(*) FROM keys").fetchone()[0], 1
            )
            store.db.close()
