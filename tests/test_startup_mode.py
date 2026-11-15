from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from gateway import run

ROOT = Path(__file__).resolve().parents[1]


class StartupModeTests(unittest.TestCase):
    def test_unconfigured_server_cannot_fall_back_to_sqlite(self):
        with (
            patch.object(
                run,
                "settings",
                SimpleNamespace(accounts_worker_url="", public_port=18900),
            ),
            patch.object(sys, "argv", ["gateway.run"]),
            patch.object(run.socket, "socket") as sock,
        ):
            with self.assertRaises(SystemExit) as error:
                run.main()
            self.assertEqual(error.exception.code, 2)
            sock.assert_not_called()

    def test_local_opt_in_cannot_be_combined_with_worker_mode(self):
        with (
            patch.object(
                run,
                "settings",
                SimpleNamespace(
                    accounts_worker_url="https://accounts.hilex.me", public_port=18900
                ),
            ),
            patch.object(sys, "argv", ["gateway.run", "--local-accounts"]),
            patch.object(run.socket, "socket") as sock,
        ):
            with self.assertRaises(SystemExit):
                run.main()
            sock.assert_not_called()

    def test_local_admin_requires_explicit_confirmation(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts/ops/accounts-admin.py"), "bootstrap"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("--local-only", result.stderr)

    def test_sqlite_export_requires_explicit_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "export.sql"
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "scripts.migrations.export_d1",
                    "--output",
                    str(output),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("--source", result.stderr)
            self.assertFalse(output.exists())
