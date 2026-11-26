"""Composition, public health privacy and failed startup recovery."""

import tempfile
import unittest
from pathlib import Path
from fastapi.testclient import TestClient
from gateway.app import create_app
from gateway.settings import Settings


class LifecycleTests(unittest.TestCase):
    def test_health_exposes_no_backend_details_on_either_host(self):
        app = create_app()
        client = TestClient(app)
        for host in ["accounts.hilex.me", "api.hilex.me"]:
            response = client.get("https://" + host + "/healthz")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(set(response.json()), {"ready", "service", "auth_modes"})

    def test_failed_initialization_can_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder)
            ids = data / "ids.json"
            ids.write_text("[]")
            config = Settings(
                client_ids_file=ids,
                accounts_worker_url="https://accounts.example.com",
                accounts_worker_secret="x" * 40,
            )
            with self.assertRaisesRegex(ValueError, "Client ID allowlist"):
                with TestClient(create_app(config)):
                    pass
            ids.write_text('["test-client"]')
            with TestClient(create_app(config)) as client:
                self.assertEqual(client.get("/healthz").status_code, 200)
                self.assertEqual(client.app.state.backend_id, "test-client")
