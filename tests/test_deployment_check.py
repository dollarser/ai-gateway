import unittest
import httpx
from scripts.smoke.check_deployment import check


class ReadOnlyDeploymentTests(unittest.TestCase):
    def client(self, models_status=401, storage="d1"):
        def handle(request):
            if request.url.path == "/healthz":
                return httpx.Response(
                    200,
                    json={"storage": storage}
                    if request.url.host == "accounts.test"
                    else {"service": "inference-gateway"},
                )
            if request.url.path == "/v1/models":
                return httpx.Response(models_status, json={"data": []})
            if request.url.path == "/internal/check-auth":
                return httpx.Response(401, json={"detail": "denied"})
            self.fail(
                "Deployment check must never create or modify accounts: "
                + request.url.path
            )

        return httpx.Client(transport=httpx.MockTransport(handle))

    def test_default_checks_are_read_only(self):
        with self.client() as client:
            self.assertEqual(
                check(client, "https://accounts.test", "https://api.test")[
                    "authentication"
                ],
                "enforced",
            )

    def test_open_api_is_not_mistaken_for_a_healthy_gateway(self):
        with (
            self.client(models_status=200) as client,
            self.assertRaisesRegex(RuntimeError, "401"),
        ):
            check(client, "https://accounts.test", "https://api.test")

    def test_local_sqlite_is_not_accepted_as_production_accounts(self):
        with (
            self.client(storage="sqlite") as client,
            self.assertRaisesRegex(RuntimeError, "D1"),
        ):
            check(client, "https://accounts.test", "https://api.test")

    def test_remote_plaintext_origins_are_rejected(self):
        with self.client() as client, self.assertRaises(ValueError):
            check(client, "http://accounts.test", "https://api.test")
