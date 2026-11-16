"""Client error classification must not confuse provider failures with login expiry."""

import unittest
import httpx
from scripts.clients.errors import require_success, GatewayError


class ClientErrorsTests(unittest.TestCase):
    def test_region_and_provider_auth_do_not_trigger_login_or_retries(self):
        for code in (
            "provider_region_restricted",
            "provider_auth_failed",
            "global_budget_exhausted",
        ):
            response = httpx.Response(
                502,
                json={"error_code": code, "retryable": False},
                headers={"X-Request-ID": "request-123"},
            )
            with self.assertRaises(GatewayError) as caught:
                require_success(response)
            self.assertEqual(caught.exception.code, code)
            self.assertFalse(caught.exception.retryable)
            self.assertIn("request-123", str(caught.exception))

    def test_non_json_proxy_error_does_not_echo_body(self):
        with self.assertRaises(GatewayError) as caught:
            require_success(httpx.Response(502, text="PRIVATE_BODY"))
        self.assertNotIn("PRIVATE_BODY", str(caught.exception))

    def test_retry_after_is_a_hint_not_an_automatic_retry(self):
        with self.assertRaises(GatewayError) as caught:
            require_success(
                httpx.Response(
                    429,
                    json={"error_code": "provider_rate_limited", "retryable": True},
                    headers={"Retry-After": "12"},
                )
            )
        self.assertTrue(caught.exception.retryable)
        self.assertEqual(caught.exception.retry_after, 12)
