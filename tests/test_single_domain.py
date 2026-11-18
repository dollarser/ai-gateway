import unittest
import test_accounts as baseline
from legacy.accounts.store import Denied
from gateway.routes import http_route, ws_service


class SingleDomainTests(unittest.TestCase):
    setUp = baseline.HTTPTests.setUp
    tearDown = baseline.HTTPTests.tearDown
    login = baseline.HTTPTests.login
    key = baseline.HTTPTests.key
    post = baseline.HTTPTests.post

    def test_removed_hosts_and_account_domain_cannot_serve_inference(self):
        headers = {
            "Authorization": "Bearer " + self.tokens["access_token"],
            "X-Client-ID": self.app.state.backend_id,
        }
        for host in [
            "asr.sunlingzhang.com",
            "tts.sunlingzhang.com",
            "accounts.hilex.me",
        ]:
            r = self.client.post(
                "https://" + host + "/v1/audio/transcriptions", headers=headers
            )
            self.assertEqual(r.status_code, 404, (host, r.text))
        for path in [
            "/",
            "/auth/login",
            "/account/me",
            "/admin/users",
            "/static/app.js",
            "/docs",
            "/openapi.json",
        ]:
            self.assertEqual(
                self.client.get("https://api.hilex.me" + path).status_code,
                404,
                path,
            )

    def test_path_permissions_are_independent_of_shared_domain(self):
        headers = {"X-API-Key": self.key(["qwen"])["key"]}
        self.assertEqual(
            self.client.post(
                "https://api.hilex.me/v1/embeddings",
                json={"input": "test"},
                headers=headers,
            ).status_code,
            200,
        )
        self.assertEqual(
            self.client.post(
                "https://api.hilex.me/v1/audio/transcriptions", headers=headers
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                "https://api.hilex.me/v1/audio/speech",
                json={"input": "test"},
                headers=headers,
            ).status_code,
            403,
        )

    def test_only_supported_routes_are_exposed(self):
        self.assertEqual(
            http_route(
                "api.hilex.me", "/v1/audio/transcriptions", "POST"
            ).service,
            "asr",
        )
        self.assertEqual(
            http_route("api.hilex.me", "/v1/audio/speech", "POST").service,
            "tts",
        )
        self.assertEqual(
            http_route("api.hilex.me", "/v1/embeddings", "POST").service, "qwen"
        )
        self.assertEqual(ws_service("api.hilex.me", "/ws/tts"), "tts")
        with self.assertRaises(Denied):
            http_route(
                "api.hilex.me", "/v1/audio/transcriptions/vibevoice", "POST"
            )
        self.assertEqual(
            http_route(
                "127.0.0.1", "/v1/audio/transcriptions/vibevoice", "POST", local=True
            ).service,
            "asr",
        )
        for path in ["/v1/rerank", "/v1/score", "/flush_cache", "/v1/audio/unknown"]:
            with self.assertRaises(Denied):
                http_route("api.hilex.me", path, "POST")
        with self.assertRaises(Denied):
            ws_service("tts.sunlingzhang.com", "/ws/tts")
