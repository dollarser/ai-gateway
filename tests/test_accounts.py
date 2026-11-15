import concurrent.futures
import json
import tempfile
import unittest
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from accounts.store import Denied, Store
from gateway.auth import authorize_inference
from gateway.settings import Settings
import gateway.app as web


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Store(Path(self.tmp.name) / "test.db")
        self.user = self.db.create_user("alice", "long-password-123", must_change=False)
        self.manager = self.db.create_user(
            "key-manager", "manager-password-123", role="admin", must_change=False
        )
        self.raw, self.kid = self.db.create_key(
            self.user["id"],
            "test",
            ["qwen", "asr", "tts"],
            30,
            actor=self.manager["id"],
        )

    def tearDown(self):
        self.db.db.close()
        self.tmp.cleanup()

    def login_tokens(self):
        cookie, _, _ = self.db.login("alice", "long-password-123", "token-ip")
        return cookie, self.db.issue_login_tokens(cookie)

    def test_legacy_request_migration_preserves_history(self):
        lease = self.db.acquire(self.raw, "asr", "/legacy")
        self.db.finish(lease, 200, 321)
        rows = [
            tuple(r)
            for r in self.db.db.execute(
                "SELECT id,user_id,key_id,service,path,started,day,ended,status,response_bytes FROM requests"
            )
        ]
        self.db.db.execute("DROP TABLE requests")
        self.db.db.execute("""CREATE TABLE requests(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),
            key_id INTEGER NOT NULL REFERENCES keys(id),service TEXT NOT NULL,path TEXT NOT NULL,
            started REAL NOT NULL,day TEXT NOT NULL,ended REAL,status INTEGER,response_bytes INTEGER NOT NULL DEFAULT 0)""")
        self.db.db.executemany("INSERT INTO requests VALUES(?,?,?,?,?,?,?,?,?,?)", rows)
        self.db.db.close()
        self.db = Store(Path(self.tmp.name) / "test.db")
        row = self.db.db.execute(
            "SELECT * FROM requests WHERE id=?", (lease,)
        ).fetchone()
        self.assertEqual(row["response_bytes"], 321)
        self.assertEqual(row["auth_type"], "api_key")
        _, tokens = self.login_tokens()
        newlease = self.db.acquire(tokens["access_token"], "qwen", "/v1/models")
        self.db.finish(newlease, 200)
        self.assertEqual(self.db.usage(self.user["id"])["totals"][0]["requests"], 1)

    def test_concurrent_refresh_has_one_rotation_and_revokes_on_reuse(self):
        _, tokens = self.login_tokens()

        def refresh(_):
            try:
                return self.db.refresh(tokens["refresh_token"])
            except Denied:
                return None

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(refresh, range(2)))
        valid = [result for result in results if result]
        self.assertEqual(len(valid), 1)
        with self.assertRaises(Denied):
            self.db.access_user(valid[0]["access_token"])

    def test_tokens_rotated_refresh_and_replay_revokes_family(self):
        cookie, tokens = self.login_tokens()
        self.assertEqual(
            self.db.access_user(tokens["access_token"])["id"], self.user["id"]
        )
        rotated = self.db.refresh(tokens["refresh_token"])
        self.assertNotEqual(rotated["refresh_token"], tokens["refresh_token"])
        self.assertEqual(
            self.db.access_user(rotated["access_token"])["id"], self.user["id"]
        )
        with self.assertRaises(Denied):
            self.db.refresh(tokens["refresh_token"])
        with self.assertRaises(Denied):
            self.db.access_user(rotated["access_token"])
        with self.assertRaises(Denied):
            self.db.refresh(rotated["refresh_token"])
        with self.assertRaises(Denied):
            self.db.session(cookie)

    def test_access_expiry_refresh_and_absolute_expiry(self):
        _, tokens = self.login_tokens()
        self.db.db.execute("UPDATE access_tokens SET expires=0")
        with self.assertRaises(Denied):
            self.db.access_user(tokens["access_token"])
        rotated = self.db.refresh(tokens["refresh_token"])
        self.db.access_user(rotated["access_token"])
        self.db.db.execute("UPDATE auth_families SET expires=0")
        with self.assertRaises(Denied):
            self.db.refresh(rotated["refresh_token"])
        with self.assertRaises(Denied):
            self.db.access_user(rotated["access_token"])

    def test_logout_cookie_and_access_invalidate_both_token_types(self):
        cookie, tokens = self.login_tokens()
        self.db.logout(cookie)
        with self.assertRaises(Denied):
            self.db.access_user(tokens["access_token"])
        with self.assertRaises(Denied):
            self.db.refresh(tokens["refresh_token"])
        cookie, tokens = self.login_tokens()
        self.db.logout_access(tokens["access_token"])
        with self.assertRaises(Denied):
            self.db.session(cookie)
        with self.assertRaises(Denied):
            self.db.refresh(tokens["refresh_token"])

    def test_password_change_disable_reset_revoke_tokens(self):
        _, tokens = self.login_tokens()
        self.db.change_password(
            self.user["id"], "long-password-123", "new-long-password-456"
        )
        with self.assertRaises(Denied):
            self.db.access_user(tokens["access_token"])
        with self.assertRaises(Denied):
            self.db.refresh(tokens["refresh_token"])
        cookie, _, _ = self.db.login("alice", "new-long-password-456", "token-ip")
        tokens = self.db.issue_login_tokens(cookie)
        self.db.update_user(0, self.user["id"], {"enabled": False})
        self.db.update_user(0, self.user["id"], {"enabled": True})
        with self.assertRaises(Denied):
            self.db.access_user(tokens["access_token"])
        with self.assertRaises(Denied):
            self.db.refresh(tokens["refresh_token"])
        cookie, _, _ = self.db.login("alice", "new-long-password-456", "token-ip")
        tokens = self.db.issue_login_tokens(cookie)
        self.db.reset_password(self.manager["id"], self.user["id"])
        with self.assertRaises(Denied):
            self.db.access_user(tokens["access_token"])
        with self.assertRaises(Denied):
            self.db.refresh(tokens["refresh_token"])

    def test_login_token_and_key_share_atomic_quota_without_hidden_key(self):
        _, tokens = self.login_tokens()
        count = self.db.db.execute("SELECT count(*) FROM keys").fetchone()[0]
        lease = self.db.acquire(tokens["access_token"], "qwen", "/v1/models")
        second = self.db.acquire(self.raw, "asr", "/test")
        with self.assertRaises(Denied):
            self.db.acquire(tokens["access_token"], "tts", "/test")
        self.db.finish(lease, 200)
        self.db.finish(second, 200)
        self.assertEqual(
            self.db.db.execute("SELECT count(*) FROM keys").fetchone()[0], count
        )
        row = self.db.db.execute(
            "SELECT key_id,auth_type FROM requests WHERE id=?", (lease,)
        ).fetchone()
        self.assertIsNone(row["key_id"])
        self.assertEqual(row["auth_type"], "access_token")
        self.db.update_user(0, self.user["id"], {"daily_requests": 2})
        with self.assertRaises(Denied):
            self.db.acquire(tokens["access_token"], "asr", "/test")

    def test_tokens_not_stored_plaintext_and_survive_restart(self):
        _, tokens = self.login_tokens()
        dump = "\n".join(self.db.db.iterdump())
        self.assertNotIn(tokens["access_token"], dump)
        self.assertNotIn(tokens["refresh_token"], dump)
        self.db.db.close()
        self.db = Store(Path(self.tmp.name) / "test.db")
        self.db.access_user(tokens["access_token"])
        self.db.refresh(tokens["refresh_token"])

    def test_only_administrators_can_create_or_revoke_keys(self):
        with self.assertRaises(Denied):
            self.db.create_key(self.user["id"], "blocked", ["asr"], 30)
        with self.assertRaises(Denied):
            self.db.revoke_key(self.user["id"], self.kid)
        self.db.revoke_key(self.manager["id"], self.kid)

    def test_registration_defaults_and_individual_overrides(self):
        first = self.db.register(
            "New.User@example.com", "long-password-123", "register-ip"
        )
        self.assertEqual(first["email"], "new.user@example.com")
        self.assertEqual(first["services"], ["asr", "qwen", "tts"])
        self.assertEqual(
            (first["rpm"], first["daily_requests"], first["concurrency"]), (30, 1000, 2)
        )
        self.assertFalse(first["must_change"])
        self.db.update_registration_defaults(
            0, {"rpm": 12, "daily_requests": 200, "concurrency": 1}
        )
        second = self.db.register(
            "second@example.com", "long-password-123", "register-ip"
        )
        self.assertEqual(
            (second["rpm"], second["daily_requests"], second["concurrency"]),
            (12, 200, 1),
        )
        self.db.update_user(
            0, first["id"], {"rpm": 40, "daily_requests": 3000, "concurrency": 3}
        )
        account = next(u for u in self.db.users() if u["id"] == first["id"])
        self.assertEqual(
            (account["rpm"], account["daily_requests"], account["concurrency"]),
            (40, 3000, 3),
        )
        self.db.db.close()
        self.db = Store(Path(self.tmp.name) / "test.db")
        self.assertEqual(self.db.registration_defaults()["rpm"], 12)
        self.assertEqual(
            next(u for u in self.db.users() if u["id"] == second["id"])["rpm"], 12
        )

    def test_registration_rate_limit_and_case_insensitive_duplicates(self):
        self.db.register("email@example.com", "long-password-123", "ip-registration")
        with self.assertRaises(Denied) as caught:
            self.db.register(
                "EMAIL@example.com", "long-password-123", "ip-registration"
            )
        self.assertEqual(caught.exception.status, 409)
        for n in range(3):
            self.db.register(
                f"user{n}@example.com", "long-password-123", "ip-registration"
            )
        with self.assertRaises(Denied) as caught:
            self.db.register(
                "excess@example.com", "long-password-123", "ip-registration"
            )
        self.assertEqual(caught.exception.status, 429)

    def test_password_and_session_invalidation(self):
        raw, csrf, user = self.db.login("alice", "long-password-123", "ip")
        self.assertEqual(self.db.session(raw)[0]["id"], user["id"])
        self.db.change_password(
            user["id"], "long-password-123", "new-long-password-456"
        )
        with self.assertRaises(Denied):
            self.db.session(raw)
        self.db.login("alice", "new-long-password-456", "ip")

    def test_disabled_user_immediately_denies_existing_key_and_session(self):
        raw, _, _ = self.db.login("alice", "long-password-123", "ip")
        self.db.update_user(0, self.user["id"], {"enabled": False})
        with self.assertRaises(Denied):
            self.db.acquire(self.raw, "asr", "/test")
        with self.assertRaises(Denied):
            self.db.session(raw)

    def test_revocation_expiry_and_permission(self):
        other, _ = self.db.create_key(
            self.user["id"], "asr", ["asr"], 30, actor=self.manager["id"]
        )
        with self.assertRaises(Denied):
            self.db.acquire(other, "tts", "/test")
        self.db.update_user(0, self.user["id"], {"services": ["tts"]})
        with self.assertRaises(Denied):
            self.db.acquire(self.raw, "qwen", "/test")
        self.db.revoke_key(self.manager["id"], self.kid)
        with self.assertRaises(Denied):
            self.db.acquire(self.raw, "tts", "/test")
        self.db.db.execute("UPDATE keys SET expires=0")
        with self.assertRaises(Denied):
            self.db.acquire(other, "asr", "/test")

    def test_initial_password_blocks_key_creation(self):
        u = self.db.create_user("newuser", "long-password-123")
        with self.assertRaises(Denied):
            self.db.create_key(u["id"], "key", ["asr"], 30, actor=self.manager["id"])

    def test_atomic_cross_service_concurrency(self):
        def request(n):
            try:
                return self.db.acquire(self.raw, ["qwen", "asr", "tts"][n % 3], "/test")
            except Denied:
                return None

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            leases = [x for x in pool.map(request, range(12)) if x]
        self.assertEqual(len(leases), 2)
        for lease in leases:
            self.db.finish(lease, 200)
        self.db.finish(self.db.acquire(self.raw, "qwen", "/test"), 200)

    def test_daily_and_rpm_limits_shared_across_keys(self):
        self.db.update_user(0, self.user["id"], {"daily_requests": 2})
        for service in ["qwen", "asr"]:
            self.db.finish(self.db.acquire(self.raw, service, "/test"), 200)
        key, _ = self.db.create_key(
            self.user["id"], "second", ["tts"], 30, actor=self.manager["id"]
        )
        with self.assertRaises(Denied) as caught:
            self.db.acquire(key, "tts", "/test")
        self.assertEqual(caught.exception.status, 429)
        self.db.update_user(0, self.user["id"], {"daily_requests": 100, "rpm": 2})
        with self.assertRaises(Denied):
            self.db.acquire(key, "tts", "/test")

    def test_key_ownership(self):
        bob = self.db.create_user("bob", "long-password-123", must_change=False)
        with self.assertRaises(Denied):
            self.db.revoke_key(bob["id"], self.kid)
        self.assertEqual(self.db.keys(bob["id"]), [])

    def test_login_rate_limited_and_no_raw_secrets_in_db(self):
        for n in range(10):
            with self.assertRaises(Denied):
                self.db.login("alice", "wrong", "ip")
        with self.assertRaises(Denied) as caught:
            self.db.login("alice", "long-password-123", "ip")
        self.assertEqual(caught.exception.status, 429)
        dump = "\n".join(self.db.db.iterdump())
        self.assertNotIn(self.raw, dump)
        self.assertNotIn("long-password-123", dump)

    def test_admin_reset_revokes_keys_and_sessions(self):
        token, _, _ = self.db.login("alice", "long-password-123", "ip")
        new = self.db.reset_password(999, self.user["id"])
        with self.assertRaises(Denied):
            self.db.acquire(self.raw, "qwen", "/test")
        with self.assertRaises(Denied):
            self.db.session(token)
        self.assertTrue(self.db.login("alice", new, "ip")[2]["must_change"])

    def test_last_admin_protection_and_persistence(self):
        admin = self.manager
        with self.assertRaises(Denied):
            self.db.update_user(admin["id"], admin["id"], {"enabled": False})
        lease = self.db.acquire(self.raw, "asr", "/test")
        self.db.finish(lease, 200, 123)
        self.db.db.close()
        self.db = Store(Path(self.tmp.name) / "test.db")
        self.assertEqual(self.db.usage(self.user["id"])["totals"][0]["requests"], 1)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = web.create_app(Settings(data_dir=Path(self.tmp.name)))
        (Path(self.tmp.name) / "bootstrap-admin.json").write_text(
            json.dumps({"username": "admin", "password": "long-password-123"})
        )
        self.client = TestClient(self.app, base_url="https://accounts.hilex.me")
        self.client.__enter__()
        self.db = self.app.state.store
        self.original_client = self.app.state.client

        async def backend(request):
            # The new account key must never reach existing model gateways.
            assert "authorization" not in request.headers
            assert request.headers["x-client-id"] == self.app.state.backend_id
            if request.url.path == "/v1/models":
                model = (
                    "Qwen/Qwen3-Embedding-0.6B"
                    if request.url.port == 18771
                    else "test-chat"
                )
                return httpx.Response(
                    200,
                    json={"object": "list", "data": [{"id": model, "object": "model"}]},
                    request=request,
                )
            return httpx.Response(200, json={"text": "ok"}, request=request)

        self.mock = httpx.AsyncClient(transport=httpx.MockTransport(backend))
        self.app.state.client = self.mock
        self.db.create_user("alice", "long-password-123", must_change=False)
        self.manager = self.db.create_user(
            "key-manager", "manager-password-123", role="admin", must_change=False
        )
        self.login("alice")

    def tearDown(self):
        self.client.portal.call(self.mock.aclose)
        self.app.state.client = self.original_client
        self.client.__exit__(None, None, None)
        self.tmp.cleanup()

    def login(self, username):
        r = self.client.post(
            "/auth/login", json={"username": username, "password": "long-password-123"}
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.csrf = r.json()["csrf"]
        self.tokens = r.json()

    def post(self, path, data, **kwargs):
        return self.client.post(
            path, json=data, headers={"X-CSRF-Token": self.csrf}, **kwargs
        )

    def key(self, services=["asr"]):
        uid = self.client.get("/account/me").json()["user"]["id"]
        raw, kid = self.db.create_key(
            uid, "test", services, 1, actor=self.manager["id"]
        )
        return {"id": kid, "key": raw}

    def test_inference_requires_both_account_and_client_id(self):
        token = self.tokens["access_token"]
        cid = self.app.state.backend_id
        for host, path, method in [
            ("api", "/v1/models", "GET"),
            ("api", "/v1/audio/transcriptions", "POST"),
            ("api", "/v1/audio/speech", "POST"),
        ]:
            for headers in [
                {},
                {"X-Client-ID": cid},
                {"Authorization": "Bearer " + token},
                {"Authorization": "Bearer " + token, "X-Client-ID": "wrong"},
                {"Authorization": "Bearer ai-at-invalid", "X-Client-ID": cid},
            ]:
                r = self.client.request(
                    method,
                    "https://" + host + ".hilex.me" + path,
                    headers=headers,
                )
                self.assertEqual(r.status_code, 401, (host, r.status_code))
        self.assertEqual(
            self.db.db.execute("SELECT count(*) FROM requests").fetchone()[0], 0
        )
        for host, path, method in [
            ("api", "/v1/models", "GET"),
            ("api", "/v1/audio/transcriptions", "POST"),
            ("api", "/v1/audio/speech", "POST"),
        ]:
            r = self.client.request(
                method,
                "https://" + host + ".hilex.me" + path,
                headers={"Authorization": "Bearer " + token, "X-Client-ID": cid},
            )
            self.assertEqual(r.status_code, 200)

    def test_embedding_uses_qwen_auth_quota_and_private_backend(self):
        url = "https://api.hilex.me/v1/embeddings"
        token = self.tokens["access_token"]
        cid = self.app.state.backend_id
        payload = {"model": "Qwen/Qwen3-Embedding-0.6B", "input": "example"}
        for headers in [{}, {"X-Client-ID": cid}, {"Authorization": "Bearer " + token}]:
            self.assertEqual(
                self.client.post(url, json=payload, headers=headers).status_code, 401
            )
        seen = []

        async def backend(request):
            seen.append(str(request.url))
            self.assertNotIn("authorization", request.headers)
            if request.url.path == "/v1/models":
                return httpx.Response(
                    200,
                    json={
                        "object": "list",
                        "data": [
                            {
                                "id": "Qwen/Qwen3-Embedding-0.6B"
                                if request.url.port == 18771
                                else "existing-llm",
                                "object": "model",
                            }
                        ],
                    },
                )
            self.assertEqual(json.loads(request.content), payload)
            return httpx.Response(
                200, json={"data": [{"index": 0, "embedding": [1.0, 0.0]}]}
            )

        mock = httpx.AsyncClient(transport=httpx.MockTransport(backend))
        self.app.state.client = mock
        try:
            headers = {"Authorization": "Bearer " + token, "X-Client-ID": cid}
            r = self.client.post(url, json=payload, headers=headers)
            self.assertEqual(r.status_code, 200)
            self.assertEqual(seen, ["http://127.0.0.1:18771/v1/embeddings"])
            rows = self.db.usage(self.tokens["user"]["id"])["requests"]
            self.assertEqual(rows[0]["service"], "qwen")
            self.assertEqual(rows[0]["path"], "/v1/embeddings")
            catalog = self.client.get(
                "https://api.hilex.me/v1/models?output_modalities=all",
                headers=headers,
            ).json()
            self.assertEqual(
                [m["id"] for m in catalog["data"]],
                ["existing-llm", "Qwen/Qwen3-Embedding-0.6B"],
            )
            self.db.db.execute(
                "UPDATE users SET services=? WHERE username=?",
                (json.dumps(["asr"]), "alice"),
            )
            self.assertEqual(
                self.client.post(url, json=payload, headers=headers).status_code, 403
            )
        finally:
            self.client.portal.call(mock.aclose)
            self.app.state.client = self.mock

    def test_vibevoice_is_not_public_even_with_valid_credentials(self):
        url = "https://api.hilex.me/v1/audio/transcriptions/vibevoice"
        token = self.tokens["access_token"]
        cid = self.app.state.backend_id
        for headers in [
            {},
            {"Authorization": "Bearer " + token, "X-Client-ID": cid},
            {"X-API-Key": self.key(["asr"])["key"]},
        ]:
            self.assertEqual(self.client.post(url, headers=headers).status_code, 404)
        self.assertEqual(
            self.db.db.execute("SELECT count(*) FROM requests").fetchone()[0], 0
        )

    def test_administrator_key_does_not_require_client_id(self):
        key = self.key(["qwen"])["key"]
        url = "https://api.hilex.me/v1/models"
        self.assertEqual(
            self.client.get(
                url, headers={"Authorization": "Bearer " + key}
            ).status_code,
            200,
        )
        self.assertEqual(
            self.client.get(
                url,
                headers={
                    "Authorization": "Bearer " + key,
                    "X-Client-ID": self.app.state.backend_id,
                },
            ).status_code,
            200,
        )

    def test_websocket_browser_protocol_requires_both_credentials(self):
        token = "access-token." + self.tokens["access_token"]
        cid = "client-id." + self.app.state.backend_id
        for protocols in [
            ["speech", token],
            ["speech", cid],
            ["speech", token, "client-id.invalid"],
        ]:
            with self.assertRaises(Denied):
                authorize_inference(self.app, {}, "asr", "/ws/asr", protocols)
        lease, _ = authorize_inference(
            self.app, {}, "asr", "/ws/asr", ["speech", token, cid]
        )
        self.db.finish(lease, 101)

    def test_invalid_or_expired_bearer_cannot_fallback_to_cookie(self):
        self.assertEqual(self.client.get("/account/me").status_code, 200)
        self.db.db.execute("UPDATE access_tokens SET expires=0")
        self.assertEqual(
            self.client.get(
                "/account/me",
                headers={"Authorization": "Bearer " + self.tokens["access_token"]},
            ).status_code,
            401,
        )
        self.assertEqual(
            self.client.get(
                "/account/me", headers={"Authorization": "Basic invalid"}
            ).status_code,
            401,
        )
        self.assertEqual(self.client.get("/account/me").status_code, 200)

    def test_android_login_without_cookies_calls_every_service(self):
        access = self.tokens["access_token"]
        self.client.cookies.clear()
        auth = {
            "Authorization": "Bearer " + access,
            "X-Client-ID": self.app.state.backend_id,
        }
        self.assertEqual(self.client.get("/account/me", headers=auth).status_code, 200)
        for host, path, method in [
            ("api", "/v1/models", "GET"),
            ("api", "/v1/audio/transcriptions", "POST"),
            ("api", "/v1/audio/speech", "POST"),
        ]:
            r = self.client.request(
                method, "https://" + host + ".hilex.me" + path, headers=auth
            )
            self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(
            self.client.get("/account/usage", headers=auth).status_code, 200
        )
        self.assertEqual(
            self.client.post(
                "/account/keys",
                json={"name": "blocked", "services": ["asr"]},
                headers=auth,
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.get("/account/keys", headers=auth).status_code, 403
        )
        self.assertEqual(
            self.client.post(
                "/admin/keys/1",
                json={"name": "blocked", "services": ["asr"]},
                headers=auth,
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.delete("/admin/keys/1", headers=auth).status_code, 403
        )

    def test_logout_with_refresh_still_works_when_access_expired(self):
        self.db.db.execute("UPDATE access_tokens SET expires=0")
        self.client.cookies.clear()
        self.assertEqual(
            self.client.post(
                "/auth/logout", json={"refresh_token": self.tokens["refresh_token"]}
            ).status_code,
            200,
        )
        self.assertEqual(
            self.client.post(
                "/auth/refresh", json={"refresh_token": self.tokens["refresh_token"]}
            ).status_code,
            401,
        )

    def test_refresh_and_logout_with_bearer_not_csrf(self):
        self.client.cookies.clear()
        rotated = self.client.post(
            "/auth/refresh", json={"refresh_token": self.tokens["refresh_token"]}
        )
        self.assertEqual(rotated.status_code, 200, rotated.text)
        payload = rotated.json()
        auth = {"Authorization": "Bearer " + payload["access_token"]}
        self.assertEqual(
            self.client.post("/auth/logout", headers=auth).status_code, 200
        )
        self.assertEqual(self.client.get("/account/me", headers=auth).status_code, 401)
        self.assertEqual(
            self.client.post(
                "/auth/refresh", json={"refresh_token": payload["refresh_token"]}
            ).status_code,
            401,
        )

    def test_refresh_token_is_not_inference_or_account_credential(self):
        auth = {
            "Authorization": "Bearer " + self.tokens["refresh_token"],
            "X-Client-ID": self.app.state.backend_id,
        }
        self.assertEqual(self.client.get("/account/me", headers=auth).status_code, 401)
        self.assertEqual(
            self.client.get(
                "https://api.hilex.me/v1/models", headers=auth
            ).status_code,
            401,
        )
        auth["Authorization"] = "Bearer ai-at-invalid"
        self.assertEqual(
            self.client.get(
                "https://api.hilex.me/v1/models", headers=auth
            ).status_code,
            401,
        )

    def test_administrator_creates_key_for_another_user(self):
        alice = self.client.get("/account/me").json()["user"]["id"]
        r = self.client.post(
            "/auth/login",
            json={"username": "key-manager", "password": "manager-password-123"},
        )
        auth = {
            "Authorization": "Bearer " + r.json()["access_token"],
            "X-Client-ID": self.app.state.backend_id,
        }
        r = self.client.post(
            "/admin/keys/" + str(alice),
            json={"name": "configured-by-admin", "services": ["asr"], "days": 30},
            headers=auth,
        )
        self.assertEqual(r.status_code, 200, r.text)
        key = r.json()
        self.assertEqual(
            self.client.post(
                "https://api.hilex.me/v1/audio/transcriptions",
                headers={
                    "Authorization": "Bearer " + key["key"],
                    "X-Client-ID": self.app.state.backend_id,
                },
            ).status_code,
            200,
        )
        self.assertEqual(
            self.client.get(
                "https://api.hilex.me/v1/models",
                headers={
                    "Authorization": "Bearer " + key["key"],
                    "X-Client-ID": self.app.state.backend_id,
                },
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.delete(
                "/admin/keys/" + str(key["id"]), headers=auth
            ).status_code,
            200,
        )
        self.assertEqual(
            self.client.post(
                "https://api.hilex.me/v1/audio/transcriptions",
                headers={
                    "Authorization": "Bearer " + key["key"],
                    "X-Client-ID": self.app.state.backend_id,
                },
            ).status_code,
            401,
        )

    def test_password_change_with_access_revokes_all_logins(self):
        auth = {
            "Authorization": "Bearer " + self.tokens["access_token"],
            "X-Client-ID": self.app.state.backend_id,
        }
        r = self.client.post(
            "/account/password",
            json={
                "current_password": "long-password-123",
                "new_password": "new-password-456",
            },
            headers=auth,
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.client.get("/account/me", headers=auth).status_code, 401)
        self.assertEqual(
            self.client.post(
                "/auth/refresh", json={"refresh_token": self.tokens["refresh_token"]}
            ).status_code,
            401,
        )

    def test_email_registration_login_and_full_service_access(self):
        r = self.client.post(
            "/auth/register",
            json={"email": "New.User@example.com", "password": "long-password-123"},
        )
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["user"]["role"], "user")
        self.assertEqual(r.json()["user"]["services"], ["asr", "qwen", "tts"])
        self.assertEqual(r.json()["user"]["daily_requests"], 1000)
        self.assertFalse(r.json()["user"]["must_change"])
        r = self.client.post(
            "/auth/login",
            json={"username": "NEW.USER@EXAMPLE.COM", "password": "long-password-123"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.csrf = r.json()["csrf"]
        self.assertEqual(self.client.get("/admin/users").status_code, 403)
        key = self.key(["asr", "qwen", "tts"])
        for host, path, method in [
            ("api", "/v1/models", "GET"),
            ("api", "/v1/audio/transcriptions", "POST"),
            ("api", "/v1/audio/speech", "POST"),
        ]:
            r = self.client.request(
                method,
                "https://" + host + ".hilex.me" + path,
                headers={
                    "Authorization": "Bearer " + key["key"],
                    "X-Client-ID": self.app.state.backend_id,
                },
            )
            self.assertEqual(r.status_code, 200, r.text)

    def test_six_character_password_boundary(self):
        r = self.client.post(
            "/auth/register", json={"email": "six@example.com", "password": "123456"}
        )
        self.assertEqual(r.status_code, 201, r.text)
        r = self.client.post(
            "/auth/login", json={"username": "six@example.com", "password": "123456"}
        )
        self.assertEqual(r.status_code, 200)
        auth = {
            "Authorization": "Bearer " + r.json()["access_token"],
            "X-Client-ID": self.app.state.backend_id,
        }
        r = self.client.post(
            "/account/password",
            json={"current_password": "123456", "new_password": "12345"},
            headers=auth,
        )
        self.assertEqual(r.status_code, 422)
        r = self.client.post(
            "/account/password",
            json={"current_password": "123456", "new_password": "abcdef"},
            headers=auth,
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            self.client.post(
                "/auth/login",
                json={"username": "six@example.com", "password": "abcdef"},
            ).status_code,
            200,
        )
        self.assertEqual(
            self.client.post(
                "/auth/register",
                json={"email": "five@example.com", "password": "12345"},
            ).status_code,
            422,
        )

    def test_registration_validation_and_no_privilege_or_quota_injection(self):
        for payload in [
            {"email": "not-email", "password": "long-password-123"},
            {"email": "new@example.com", "password": "short"},
            {
                "email": "new@example.com",
                "password": "long-password-123",
                "role": "admin",
            },
            {"email": "new@example.com", "password": "long-password-123", "rpm": 600},
        ]:
            self.assertEqual(
                self.client.post("/auth/register", json=payload).status_code, 422
            )
        payload = {"email": "new@example.com", "password": "long-password-123"}
        self.assertEqual(
            self.client.post(
                "/auth/register", json=payload, headers={"Origin": "https://evil.test"}
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post("/auth/register", json=payload).status_code, 201
        )
        payload["email"] = "NEW@example.com"
        self.assertEqual(
            self.client.post("/auth/register", json=payload).status_code, 409
        )

    def test_admin_changes_defaults_without_changing_existing_accounts(self):
        self.assertEqual(
            self.client.patch(
                "/admin/registration-defaults",
                json={"rpm": 20, "daily_requests": 100, "concurrency": 1},
                headers={"X-CSRF-Token": self.csrf},
            ).status_code,
            403,
        )
        self.login("admin")
        self.post(
            "/account/password",
            {
                "current_password": "long-password-123",
                "new_password": "new-password-456",
            },
        )
        r = self.client.post(
            "/auth/login", json={"username": "admin", "password": "new-password-456"}
        )
        self.csrf = r.json()["csrf"]
        r = self.client.patch(
            "/admin/registration-defaults",
            json={"rpm": 20, "daily_requests": 100, "concurrency": 1},
            headers={"X-CSRF-Token": self.csrf},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(
            self.client.get("/auth/registration-info").json()["defaults"][
                "daily_requests"
            ],
            100,
        )
        r = self.client.post(
            "/auth/register",
            json={"email": "later@example.com", "password": "long-password-123"},
        )
        self.assertEqual(r.json()["user"]["daily_requests"], 100)
        alice = next(
            u
            for u in self.client.get("/admin/users").json()
            if u["username"] == "alice"
        )
        self.assertEqual(alice["daily_requests"], 1000)
        r = self.client.patch(
            "/admin/users/" + str(alice["id"]),
            json={"daily_requests": 500},
            headers={"X-CSRF-Token": self.csrf},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["daily_requests"], 500)
        r = self.client.patch(
            "/admin/registration-defaults",
            json={"rpm": 0, "daily_requests": 100, "concurrency": 1},
            headers={"X-CSRF-Token": self.csrf},
        )
        self.assertEqual(r.status_code, 422)

    def test_csrf_and_origin(self):
        self.assertEqual(
            self.client.post(
                "/account/keys", json={"name": "test", "services": ["asr"]}
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                "/account/keys",
                headers={"Origin": "https://evil.test", "X-CSRF-Token": self.csrf},
                json={},
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post("/auth/login", content=b"x" * 20000).status_code, 413
        )

    def test_admin_and_user_isolation(self):
        self.assertEqual(self.client.get("/admin/users").status_code, 403)
        own = self.key()
        self.db.create_user("bob", "long-password-123", must_change=False)
        self.login("bob")
        self.assertEqual(self.client.get("/account/keys").status_code, 403)
        r = self.client.delete(
            "/account/keys/" + str(own["id"]), headers={"X-CSRF-Token": self.csrf}
        )
        self.assertEqual(r.status_code, 403)

    def test_initial_admin_change_password_then_create_user(self):
        self.login("admin")
        self.assertEqual(self.client.get("/admin/users").status_code, 403)
        r = self.post(
            "/account/password",
            {
                "current_password": "long-password-123",
                "new_password": "new-password-456",
            },
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.client.get("/account/me").status_code, 401)
        r = self.client.post(
            "/auth/login", json={"username": "admin", "password": "new-password-456"}
        )
        self.csrf = r.json()["csrf"]
        r = self.post("/admin/users", {"username": "created-user", "services": ["tts"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["user"]["must_change"])
        self.assertIn("temporary_password", r.json())

    def test_proxy_scope_forwarding_usage_and_revocation(self):
        key = self.key()
        url = "https://api.hilex.me/v1/audio/transcriptions"
        r = self.client.post(
            url,
            content=b"audio",
            headers={
                "Authorization": "Bearer " + key["key"],
                "X-Client-ID": self.app.state.backend_id,
            },
        )
        self.assertEqual(r.status_code, 200, r.text)
        usage = self.client.get("/account/usage").json()
        self.assertEqual(usage["totals"][0]["requests"], 1)
        self.assertEqual(usage["requests"][0]["status"], 200)
        self.assertGreater(usage["requests"][0]["response_bytes"], 0)
        r = self.client.post(
            "https://api.hilex.me/v1/audio/speech",
            json={},
            headers={
                "Authorization": "Bearer " + key["key"],
                "X-Client-ID": self.app.state.backend_id,
            },
        )
        self.assertEqual(r.status_code, 403)
        self.db.revoke_key(self.manager["id"], key["id"])
        self.assertEqual(
            self.client.post(
                url,
                headers={
                    "Authorization": "Bearer " + key["key"],
                    "X-Client-ID": self.app.state.backend_id,
                },
            ).status_code,
            401,
        )

    def test_unknown_key_cannot_downgrade_to_clientid(self):
        r = self.client.post(
            "https://api.hilex.me/v1/audio/transcriptions",
            headers={
                "Authorization": "Bearer sk-acct-invalid",
                "X-Client-ID": self.app.state.backend_id,
            },
        )
        self.assertEqual(r.status_code, 401)

    def test_only_inference_paths_exposed(self):
        key = self.key(["qwen"])
        r = self.client.post(
            "https://api.hilex.me/flush_cache",
            headers={
                "Authorization": "Bearer " + key["key"],
                "X-Client-ID": self.app.state.backend_id,
            },
        )
        self.assertEqual(r.status_code, 404)
        r = self.client.get(
            "https://api.hilex.me/v1/models",
            headers={
                "Authorization": "Bearer " + key["key"],
                "X-Client-ID": self.app.state.backend_id,
            },
        )
        self.assertEqual(r.status_code, 200, r.text)

    def test_secure_cookie_and_public_static(self):
        r = self.client.post(
            "/auth/login", json={"username": "alice", "password": "long-password-123"}
        )
        cookie = r.headers["set-cookie"]
        self.assertIn("HttpOnly", cookie)
        self.assertIn("Secure", cookie)
        self.assertIn("SameSite=strict", cookie)
        r = self.client.get("/")
        self.assertIn("frame-ancestors 'none'", r.headers["content-security-policy"])
        self.assertEqual(self.client.get("/static/app.js").status_code, 200)


if __name__ == "__main__":
    unittest.main()
