"""Origin bypass is possible only for the trusted edge, never client headers."""

import asyncio
from dataclasses import replace
import httpx
from gateway_http_fixture import GatewayHTTPFixture
import unittest
from test_gateway_audio import wav_bytes


class EdgeOriginTests(GatewayHTTPFixture, unittest.TestCase):
    def set_edge(self):
        self.app.state.settings = replace(
            self.app.state.settings,
            edge_only=True,
            accounts_worker_secret="edge-secret-" * 4,
        )

    def call(self, path, headers=None, body=None):
        async def run():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=self.app, client=("127.0.0.1", 12345))
            ) as c:
                return await c.request(
                    "GET" if path == "/v1/models" else "POST",
                    "http://api.hilex.me:18900" + path,
                    headers=headers or {},
                    content=body,
                )

        return asyncio.run(run())

    def test_origin_refuses_normal_user_keys_and_forged_edge_headers(self):
        key = self.key(["qwen"])["key"]
        self.set_edge()
        self.assertEqual(
            self.call("/v1/models", {"Authorization": "Bearer " + key}).status_code, 401
        )
        self.assertEqual(
            self.call(
                "/v1/models", {"X-Edge-Secret": "forged", "X-Edge-Lease": "a" * 48}
            ).status_code,
            401,
        )
        headers = {
            "X-Edge-Secret": self.app.state.settings.accounts_worker_secret,
            "X-Edge-Lease": "a" * 48,
            "X-Edge-Request-ID": "edge-test-request",
        }
        r = self.call("/v1/models", headers)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["x-request-id"], "edge-test-request")
        self.assertEqual(len(self.requests), 0)

    def test_codec_is_private_and_decodes_without_provider_or_auth_rpc(self):
        self.set_edge()
        self.assertEqual(
            self.call("/__codec/decode", body=wav_bytes()).status_code, 401
        )
        r = self.call(
            "/__codec/decode",
            {"X-Edge-Secret": self.app.state.settings.accounts_worker_secret},
            wav_bytes(),
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.content[:4], b"RIFF")
        self.assertEqual(len(self.requests), 0)

    def test_removed_encoder_routes_return_not_found(self):
        self.set_edge()
        for operation in ("encode", "stream-encode"):
            r = self.call(
                "/__codec/" + operation,
                {"X-Edge-Secret": self.app.state.settings.accounts_worker_secret},
                b"\0" * 48000,
            )
            self.assertEqual(r.status_code, 404)
