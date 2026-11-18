"""Release backup verification restores into memory and checks relationships."""

import tempfile
import unittest
from pathlib import Path
from scripts.ops.release import verify_backup


class ReleaseTests(unittest.TestCase):
    def test_restore_checks_foreign_keys(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "backup.sql"
            path.write_text(
                "CREATE TABLE p(id INTEGER PRIMARY KEY);CREATE TABLE c(id INTEGER REFERENCES p(id));INSERT INTO p VALUES(1);INSERT INTO c VALUES(1);"
            )
            verify_backup(path)
            path.write_text(
                "CREATE TABLE p(id INTEGER PRIMARY KEY);CREATE TABLE c(id INTEGER REFERENCES p(id));INSERT INTO c VALUES(2);"
            )
            with self.assertRaisesRegex(RuntimeError, "integrity"):
                verify_backup(path)


class ReleasePropagationTests(unittest.TestCase):
    def test_maintenance_and_old_version_are_retried_before_ready(self):
        import httpx
        from scripts.ops.release_checks import wait_for_release

        calls = []

        def backend(request):
            calls.append(request.url.path)
            if len(calls) < 3:
                return httpx.Response(
                    503, json={"release": "old", "error_code": "maintenance"}
                )
            return httpx.Response(200, json={"release": "new", "ready": True})

        with httpx.Client(transport=httpx.MockTransport(backend)) as client:
            wait_for_release(
                client,
                ["https://accounts.test", "https://api.test"],
                "new",
                attempts=4,
                sleep=lambda _: None,
            )
        self.assertGreaterEqual(len(calls), 4)

    def test_wrong_release_or_missing_assets_cannot_pass(self):
        import httpx
        from scripts.ops.release_checks import wait_for_release, verify_assets
        from scripts.ops.build_assets import build

        with httpx.Client(
            transport=httpx.MockTransport(
                lambda r: httpx.Response(200, json={"release": "wrong", "ready": True})
            )
        ) as client:
            with self.assertRaises(RuntimeError):
                wait_for_release(
                    client,
                    ["https://accounts.test"],
                    "expected",
                    attempts=2,
                    sleep=lambda _: None,
                )
        with tempfile.TemporaryDirectory() as folder:
            assets = build(Path(folder) / "portal")

            def backend(request):
                path = request.url.path
                if path == "/":
                    return httpx.Response(200, text=(assets / "index.html").read_text())
                if path == "/auth/captcha":
                    return httpx.Response(
                        200, text=(assets / "captcha.html").read_text()
                    )
                return httpx.Response(401, json={"detail": "old version missing asset"})

            with httpx.Client(transport=httpx.MockTransport(backend)) as client:
                with self.assertRaisesRegex(RuntimeError, "asset"):
                    verify_assets(client, "https://accounts.test", assets)

    def test_previous_hashed_assets_are_retained_without_changing_current_html(self):
        import subprocess
        import hashlib
        from scripts.ops.build_assets import build, ROOT

        ref = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
        ).strip()
        old = subprocess.check_output(
            ["git", "show", ref + ":accounts/static/app.js"], cwd=ROOT
        )
        filename = "app." + hashlib.sha256(old).hexdigest()[:16] + ".js"
        with tempfile.TemporaryDirectory() as folder:
            assets = build(Path(folder) / "portal", previous_ref=ref)
            self.assertEqual((assets / "static" / filename).read_bytes(), old)
            self.assertNotIn("legacy/accounts", (assets / "index.html").read_text())

    def test_migration_rehearsal_rejects_lost_account_ids(self):
        from scripts.ops.release_checks import rehearse_migrations, pending_migrations

        with tempfile.TemporaryDirectory() as folder:
            backup = Path(folder) / "backup.sql"
            backup.write_text(
                "CREATE TABLE users(id INTEGER PRIMARY KEY);INSERT INTO users VALUES(1);CREATE TABLE d1_migrations(name TEXT);INSERT INTO d1_migrations VALUES('0001.sql');"
            )
            migrations = Path(folder) / "migrations"
            migrations.mkdir()
            migration = migrations / "0002.sql"
            migration.write_text("DELETE FROM users;")
            self.assertEqual(pending_migrations(backup, migrations), [migration])
            with self.assertRaisesRegex(RuntimeError, "protected"):
                rehearse_migrations(backup, [migration])

    def test_restart_decision_excludes_portal_only_changes(self):
        from unittest.mock import patch
        from scripts.ops.release_checks import restart_required

        with patch(
            "scripts.ops.release_checks.subprocess.check_output",
            return_value="accounts/static/style.css\ncloudflare/src/worker.mjs\n",
        ):
            self.assertFalse(restart_required(".", "old"))
        with patch(
            "scripts.ops.release_checks.subprocess.check_output",
            return_value="gateway/auth.py\n",
        ):
            self.assertTrue(restart_required(".", "old"))
