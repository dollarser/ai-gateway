import os
import unittest
from unittest.mock import patch
from scripts.clients.client_auth import websocket_auth


def legacy_connect(url, extra_headers=None):
    pass


def modern_connect(url, additional_headers=None):
    pass


class ClientAuthenticationTests(unittest.TestCase):
    def test_api_key_does_not_read_a_private_client_id_file(self):
        with (
            patch.dict(os.environ, {"AI_API_KEY": "sk-acct-client-key"}, clear=True),
            patch(
                "scripts.clients.client_auth.client_id",
                side_effect=AssertionError("must not read server files"),
            ),
        ):
            result = websocket_auth(legacy_connect)
        self.assertEqual(
            result["extra_headers"], {"Authorization": "Bearer sk-acct-client-key"}
        )

    def test_login_token_includes_client_id_and_supports_new_websockets(self):
        with patch.dict(
            os.environ,
            {
                "AI_ACCESS_TOKEN": "ai-at-login-token",
                "SPEECH_CLIENT_ID": "client-for-user",
            },
            clear=True,
        ):
            result = websocket_auth(modern_connect)
        self.assertEqual(result["additional_headers"]["X-Client-ID"], "client-for-user")

    def test_missing_credentials_fail_before_connecting(self):
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(ValueError):
            websocket_auth(legacy_connect)
