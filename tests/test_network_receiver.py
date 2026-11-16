"""Synthetic diagnostic receiver authenticates before exposing allowlisted metadata."""

import secrets
import time
import unittest
import httpx
from gateway.app import create_app
from gateway.settings import Settings
from gateway.network_diagnostics import PATH, signature


class NetworkReceiverTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.secret = "test-diagnostic-service-credential" * 2
        self.app = create_app(
            Settings(
                accounts_worker_url="https://accounts.test",
                edge_only=True,
                accounts_worker_secret=self.secret,
            )
        )
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app, client=("127.0.0.1", 12500)),
            base_url="https://api.hilex.me",
        )

    async def asyncTearDown(self):
        await self.client.aclose()

    def headers(self, offset=0):
        stamp, nonce = str(int(time.time()) + offset), secrets.token_hex(24)
        return {
            "X-Diagnostic-Time": stamp,
            "X-Diagnostic-Nonce": nonce,
            "X-Diagnostic-Signature": signature(self.secret, stamp, nonce),
        }

    async def test_missing_signature_expiry_and_wrong_signature_rejected(self):
        self.assertEqual((await self.client.get(PATH)).status_code, 401)
        self.assertEqual(
            (await self.client.get(PATH, headers=self.headers(-120))).status_code, 401
        )
        headers = self.headers()
        headers["X-Diagnostic-Signature"] = "bad"
        self.assertEqual(
            (await self.client.get(PATH, headers=headers)).status_code, 401
        )

    async def test_allowlist_redacts_credentials_and_prevents_replay(self):
        headers = {
            **self.headers(),
            "cf-ipcountry": "JP",
            "cf-ray": "abc-NRT",
            "cf-worker": "hilex.me",
            "cf-connecting-ip": "203.0.113.9",
            "Authorization": "Bearer PRIVATE_SENTINEL",
            "Cookie": "secret=PRIVATE_COOKIE",
            "X-Custom": "PRIVATE_CUSTOM",
        }
        response = await self.client.get(PATH, headers=headers)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["headers"]["cf-ipcountry"], "JP")
        self.assertEqual(data["scope"], "same_zone_tunnel")
        self.assertFalse(data["observes_worker_tcp_source"])
        self.assertTrue(data["sensitive_headers_present"]["authorization"])
        self.assertNotIn("PRIVATE_", response.text)
        self.assertEqual(
            (await self.client.get(PATH, headers=headers)).status_code, 409
        )

    async def test_remote_peer_cannot_use_even_a_valid_signature(self):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app, client=("203.0.113.1", 12345)),
            base_url="https://api.hilex.me",
        ) as client:
            self.assertEqual(
                (await client.get(PATH, headers=self.headers())).status_code, 401
            )
