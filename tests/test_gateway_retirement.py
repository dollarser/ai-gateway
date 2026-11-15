"""Regression coverage for retained gateway protections and correlation metadata."""

import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from accounts.store import Store, Denied
from gateway.auth import authorize_inference, source_ip
from gateway.tracking import safe_id
from gateway.usage import UsageTracker
import test_accounts as baseline


class FailureLimitTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "test.db"
        self.store = Store(self.path)
        self.app = SimpleNamespace(
            state=SimpleNamespace(store=self.store, backend_id="test-client")
        )
        self.scope = {"client": ("203.0.113.5", 1111), "server": ("127.0.0.1", 18900)}

    def tearDown(self):
        self.store.db.close()
        self.tmp.cleanup()

    def attempt(self, headers=None):
        try:
            authorize_inference(
                self.app, headers or {}, "qwen", "/v1/models", scope=self.scope
            )
        except Denied as exc:
            return exc.status
        return 200

    def test_persistent_limit_expiry_and_source_isolation(self):
        for _ in range(60):
            self.assertEqual(self.attempt(), 401)
        self.assertEqual(self.attempt(), 429)
        self.store.db.close()
        self.store = Store(self.path)
        self.app.state.store = self.store
        self.assertEqual(self.attempt(), 429)
        self.scope["client"] = ("203.0.113.6", 1111)
        self.assertEqual(self.attempt(), 401)
        self.scope["client"] = ("203.0.113.5", 1111)
        now = time.time()
        with patch("accounts.store.time.time", return_value=now + 61):
            self.assertEqual(self.attempt(), 401)
        stored = self.store.db.execute(
            "SELECT ip_hash FROM inference_auth_failures"
        ).fetchall()
        self.assertTrue(
            all(row[0] not in {"203.0.113.5", "203.0.113.6"} for row in stored)
        )

    def test_permission_failures_do_not_count_and_keys_keep_normal_limits(self):
        admin = self.store.create_user(
            "manager", "password-test", role="admin", must_change=False
        )
        user = self.store.create_user(
            "alice", "password-test", services=["asr"], must_change=False
        )
        key, _ = self.store.create_key(user["id"], "asr", ["asr"], 1, actor=admin["id"])
        for _ in range(65):
            self.assertEqual(self.attempt({"authorization": "Bearer " + key}), 403)
        self.assertEqual(
            self.store.db.execute(
                "SELECT count(*) FROM inference_auth_failures"
            ).fetchone()[0],
            0,
        )

    def test_untrusted_forwarding_cannot_change_source(self):
        self.assertEqual(
            source_ip(self.scope, {"cf-connecting-ip": "198.51.100.9"}), "203.0.113.5"
        )
        trusted = {"client": ("127.0.0.1", 1111), "server": ("127.0.0.1", 18900)}
        self.assertEqual(
            source_ip(trusted, {"cf-connecting-ip": "198.51.100.9"}), "198.51.100.9"
        )


class CorrelationTests(unittest.TestCase):
    setUp = baseline.HTTPTests.setUp
    tearDown = baseline.HTTPTests.tearDown
    login = baseline.HTTPTests.login
    key = baseline.HTTPTests.key

    def test_success_and_denial_have_server_request_ids_and_persist_safe_metadata(self):
        key = self.key(["qwen"])["key"]
        response = self.client.get(
            "https://api.hilex.me/v1/models",
            headers={
                "Authorization": "Bearer " + key,
                "X-Request-ID": "client-request-1",
                "X-Helix-Turn-ID": "turn-1",
            },
        )
        self.assertEqual(response.status_code, 200)
        request_id = response.headers["x-request-id"]
        self.assertNotEqual(request_id, "client-request-1")
        row = self.db.db.execute(
            "SELECT * FROM requests WHERE request_id=?", (request_id,)
        ).fetchone()
        self.assertEqual(row["client_request_id"], "client-request-1")
        self.assertEqual(row["helix_turn_id"], "turn-1")
        denied = self.client.get("https://api.hilex.me/v1/models")
        self.assertEqual(denied.status_code, 401)
        self.assertTrue(denied.headers["x-request-id"])

    def test_split_sse_response_ids_and_safe_id_validation(self):
        tracker = UsageTracker(streaming=True)
        body = b'data: {"id":"chatcmpl-test","usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n'
        for byte in body:
            tracker.feed(bytes([byte]))
        self.assertEqual(tracker.response_id, "chatcmpl-test")
        self.assertEqual(tracker.result(), (2, 3, True))
        for invalid in ["unsafe\nvalue", "中文", "a" * 129, None]:
            self.assertIsNone(safe_id(invalid))
