import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import httpx
from fastapi.testclient import TestClient
from gateway.errors import Denied
from gateway.remote_store import RemoteStore
from gateway.settings import Settings
from gateway.app import create_app


class WorkerStoreTests(unittest.TestCase):
    def test_service_secret_and_quota_errors_are_preserved(self):
        def handle(request):
            self.assertEqual(request.headers["authorization"], "Bearer " + "x" * 40)
            self.assertEqual(request.url.path, "/internal/acquire")
            self.assertEqual(json.loads(request.content)["service"], "asr")
            return httpx.Response(429, json={"detail": "quota"})

        store = RemoteStore(
            "https://accounts.example.com",
            "x" * 40,
            transport=httpx.MockTransport(handle),
        )
        with self.assertRaises(Denied) as error:
            store.acquire("sk-acct-test", "asr", "/v1/audio/transcriptions")
        self.assertEqual(error.exception.status, 429)
        store.close()

    def test_network_failures_fail_closed(self):
        def handle(request):
            raise httpx.ConnectError("unreachable", request=request)

        store = RemoteStore(
            "https://accounts.example.com",
            "x" * 40,
            transport=httpx.MockTransport(handle),
        )
        with self.assertRaises(Denied) as error:
            store.acquire("token", "asr", "/")
        self.assertEqual(error.exception.status, 503)
        store.close()

    def test_cloud_mode_does_not_open_or_create_a_local_database(self):
        with tempfile.TemporaryDirectory() as name:
            data = Path(name) / "must-not-exist"
            ids = Path(name) / "ids.json"
            ids.write_text('["test-client"]')
            config = Settings(
                client_ids_file=ids,
                accounts_worker_url="https://accounts.example.com",
                accounts_worker_secret="x" * 40,
            )
            app = create_app(config)
            self.assertNotIn("/auth/login", [r.path for r in app.routes])
            with patch.dict("os.environ", {"ACCOUNTS_DATA": str(data)}):
                with TestClient(app):
                    self.assertIsInstance(app.state.store, RemoteStore)
            self.assertFalse(data.exists())

    def test_plain_http_remote_origins_are_rejected(self):
        with self.assertRaises(ValueError):
            RemoteStore("http://accounts.example.com", "x" * 40)

    def test_malformed_success_cannot_grant_an_untracked_request(self):
        for payload in [[], {}, {"lease": None}, {"lease": ""}]:
            with self.subTest(payload=payload):
                store = RemoteStore(
                    "https://accounts.example.com",
                    "x" * 40,
                    transport=httpx.MockTransport(
                        lambda request: httpx.Response(200, json=payload)
                    ),
                )
                with self.assertRaises(Denied) as error:
                    store.acquire("key", "asr", "/")
                self.assertEqual(error.exception.status, 503)
                store.close()

    def test_malformed_token_allowance_is_not_treated_as_unlimited(self):
        for payload in [
            {},
            {"remaining": -1},
            {"remaining": True},
            {"remaining": "10"},
        ]:
            with self.subTest(payload=payload):
                store = RemoteStore(
                    "https://accounts.example.com",
                    "x" * 40,
                    transport=httpx.MockTransport(
                        lambda request: httpx.Response(200, json=payload)
                    ),
                )
                with self.assertRaises(Denied) as error:
                    store.token_remaining("lease")
                self.assertEqual(error.exception.status, 503)
                store.close()

    def test_missing_usage_acknowledgment_is_an_account_service_error(self):
        store = RemoteStore(
            "https://accounts.example.com",
            "x" * 40,
            transport=httpx.MockTransport(lambda request: httpx.Response(200, json={})),
        )
        with self.assertRaises(Denied) as error:
            store.finish("lease", 200)
        self.assertEqual(error.exception.status, 503)
        store.close()
