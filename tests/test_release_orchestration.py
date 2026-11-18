"""Exercise release ordering/failure containment with external boundaries mocked."""

import json
import subprocess
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import httpx
from scripts.ops import release
from scripts.ops.release_checks import retry as real_retry


class ReleaseOrchestrationTests(unittest.TestCase):
    def scenario(self, *, pending=True, failure=None):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".runtime").mkdir()
            (root / "cloudflare/migrations").mkdir(parents=True)
            (root / "cloudflare/migrations/0001_add.sql").write_text(
                "ALTER TABLE users ADD COLUMN marker TEXT;"
            )
            state = {"maintenance": False, "sha": "a" * 40}
            commands = []

            def git_output(command, **kwargs):
                if command[1] == "status":
                    return b""
                if command[1] == "rev-parse":
                    return "b" * 40 + "\n"
                raise AssertionError(command)

            def run(command, **kwargs):
                commands.append(command)
                if "export" in command:
                    applied = (
                        ""
                        if pending
                        else "INSERT INTO d1_migrations VALUES('0001_add.sql');"
                    )
                    Path(command[command.index("--output") + 1]).write_text(
                        "CREATE TABLE users(id INTEGER PRIMARY KEY);INSERT INTO users VALUES(1);CREATE TABLE d1_migrations(name TEXT);"
                        + applied
                    )
                if "deploy" in command:
                    state.update(
                        maintenance="ACCOUNT_MAINTENANCE:true" in command, sha="b" * 40
                    )
                    kwargs["stdout"].write(
                        "Current Version ID: 12345678-1234-1234-1234-123456789012\n"
                    )
                if (
                    failure == "migration"
                    and "migrations" in command
                    and "apply" in command
                ):
                    raise subprocess.CalledProcessError(1, command)
                return subprocess.CompletedProcess(command, 0)

            def server(request):
                if request.url.path == "/healthz":
                    if request.url.host == "127.0.0.1":
                        return httpx.Response(200, json={"ready": True})
                    if state["maintenance"]:
                        return httpx.Response(
                            503,
                            json={"release": state["sha"], "error_code": "maintenance"},
                        )
                    return httpx.Response(
                        200,
                        json={
                            "release": state["sha"],
                            "ready": True,
                            "storage": "d1",
                            "service": "accounts"
                            if request.url.host.startswith("accounts")
                            else "inference-gateway",
                        },
                    )
                return httpx.Response(401, json={"detail": "login required"})

            client = httpx.Client(transport=httpx.MockTransport(server))

            def assets(*_):
                if failure == "assets":
                    raise RuntimeError("Asset has not propagated")
                return 1

            with ExitStack() as stack:
                stack.enter_context(patch.object(release, "ROOT", root))
                stack.enter_context(patch("sys.argv", ["release", "--deploy"]))
                stack.enter_context(
                    patch.object(
                        release.subprocess, "check_output", side_effect=git_output
                    )
                )
                stack.enter_context(
                    patch.object(release.subprocess, "run", side_effect=run)
                )
                stack.enter_context(
                    patch.object(release.httpx, "Client", return_value=client)
                )
                stack.enter_context(
                    patch.object(release, "build", return_value=root / "assets")
                )
                stack.enter_context(
                    patch.object(release, "verify_assets", side_effect=assets)
                )
                stack.enter_context(
                    patch.object(release, "restart_required", return_value=False)
                )
                stack.enter_context(
                    patch.object(
                        release,
                        "retry",
                        side_effect=lambda fn: real_retry(
                            fn, attempts=2, sleep=lambda _: None
                        ),
                    )
                )
                # main changes cwd intentionally; keep the test process outside the deleted directory.
                original = Path.cwd()
                try:
                    if failure:
                        with self.assertRaises(
                            (RuntimeError, subprocess.CalledProcessError)
                        ):
                            release.main()
                    else:
                        release.main()
                finally:
                    __import__("os").chdir(original)
            manifest = json.loads(
                next((root / ".runtime/releases").glob("*/release.json")).read_text()
            )
            return state, commands, manifest

    def test_pending_schema_uses_maintenance_and_then_returns_to_verified_release(self):
        state, commands, manifest = self.scenario()
        self.assertFalse(state["maintenance"])
        self.assertEqual(manifest["status"], "deployed_and_verified")
        names = manifest["steps"]
        self.assertLess(names.index("browser-tests"), names.index("maintenance-enable"))
        self.assertLess(names.index("maintenance-check"), names.index("migrations"))
        self.assertLess(names.index("migrations"), names.index("deploy"))
        self.assertIn("asset-propagation-check", names)
        self.assertFalse(any("restart" in command for command in commands))

    def test_migration_failure_keeps_maintenance_and_never_deploys_normal_mode(self):
        state, commands, manifest = self.scenario(failure="migration")
        self.assertTrue(state["maintenance"])
        self.assertEqual(manifest["status"], "failed")
        self.assertEqual(manifest["failed_step"], "migrations")
        self.assertFalse(
            any("ACCOUNT_MAINTENANCE:false" in command for command in commands)
        )

    def test_verification_failure_reenters_maintenance_after_cutover(self):
        state, _, manifest = self.scenario(failure="assets")
        self.assertTrue(state["maintenance"])
        self.assertEqual(manifest["status"], "failed")
        self.assertEqual(manifest["failed_step"], "asset-propagation-check")
        self.assertIn("maintenance-recovery", manifest["steps"])

    def test_static_release_does_not_enter_maintenance_or_restart_origin(self):
        state, commands, manifest = self.scenario(pending=False)
        self.assertFalse(state["maintenance"])
        self.assertFalse(manifest["maintenance_required"])
        self.assertNotIn("maintenance-enable", manifest["steps"])
        self.assertFalse(any("restart" in command for command in commands))
