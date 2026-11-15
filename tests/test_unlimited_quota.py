"""Unlimited request counts retain permissions, key expiry and in-flight limits."""

import tempfile
import unittest
from pathlib import Path
from accounts.store import Store, Denied
from accounts.schemas import NewUser, UpdateUser, RegistrationDefaults


class UnlimitedQuotaTests(unittest.TestCase):
    def test_unlimited_counts_with_four_concurrent_leases(self):
        with tempfile.TemporaryDirectory() as folder:
            store = Store(Path(folder) / "test.db")
            try:
                admin = store.create_user(
                    "manager", "long-password", role="admin", must_change=False
                )
                user = store.create_user(
                    "client",
                    "long-password",
                    rpm=0,
                    daily_requests=0,
                    concurrency=4,
                    services=["qwen"],
                    must_change=False,
                )
                key, kid = store.create_key(
                    user["id"], "month", ["qwen"], 30, actor=admin["id"]
                )
                # Exceed ordinary default RPM/day quotas without consuming concurrency.
                for _ in range(1001):
                    lease = store.acquire(key, "qwen", "/v1/embeddings")
                    store.finish(lease, 200)
                leases = [
                    store.acquire(key, "qwen", "/v1/chat/completions") for _ in range(4)
                ]
                with self.assertRaises(Denied) as rejected:
                    store.acquire(key, "qwen", "/v1/embeddings")
                self.assertEqual(rejected.exception.status, 429)
                store.finish(leases.pop(), 200)
                leases.append(store.acquire(key, "qwen", "/v1/embeddings"))
                for lease in leases:
                    store.finish(lease, 200)
                with self.assertRaises(Denied) as rejected:
                    store.acquire(key, "asr", "/v1/audio/transcriptions")
                self.assertEqual(rejected.exception.status, 403)
                store.db.execute("UPDATE keys SET expires=0 WHERE id=?", (kid,))
                with self.assertRaises(Denied) as expired:
                    store.acquire(key, "qwen", "/v1/models")
                self.assertEqual(expired.exception.status, 401)
            finally:
                store.db.close()

    def test_only_admin_account_configuration_accepts_unlimited(self):
        self.assertEqual(NewUser(username="client", rpm=0, daily_requests=0).rpm, 0)
        self.assertEqual(UpdateUser(rpm=0, daily_requests=0).daily_requests, 0)
        with self.assertRaises(ValueError):
            RegistrationDefaults(rpm=0, daily_requests=0, concurrency=4)
        with self.assertRaises(ValueError):
            UpdateUser(rpm=-1)
