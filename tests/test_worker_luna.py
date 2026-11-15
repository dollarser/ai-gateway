"""Cloud model routing, authentication and protocol isolation."""

import json
import unittest
from dataclasses import replace
import httpx
import test_accounts as baseline
from gateway.usage import UsageTracker
from gateway.worker_openai import LUNA_MODEL_ENTRY


class LunaGatewayTests(unittest.TestCase):
    setUp = baseline.HTTPTests.setUp
    tearDown = baseline.HTTPTests.tearDown
    login = baseline.HTTPTests.login
    key = baseline.HTTPTests.key
    post = baseline.HTTPTests.post

    def configure(self, backend):
        self.app.state.settings = replace(
            self.app.state.settings,
            accounts_worker_url="https://accounts.hilex.me",
            accounts_worker_secret="internal-secret-test-" * 3,
        )
        self.client.portal.call(self.mock.aclose)
        self.mock = httpx.AsyncClient(transport=httpx.MockTransport(backend))
        self.app.state.client = self.mock

    def test_chat_and_responses_use_worker_lease_without_sglang_rewrites(self):
        seen = []

        async def backend(request):
            seen.append(request.url.path)
            self.assertEqual(request.url.host, "accounts.hilex.me")
            self.assertEqual(
                request.headers["authorization"],
                "Bearer " + self.app.state.settings.accounts_worker_secret,
            )
            self.assertTrue(request.headers["x-gateway-lease"])
            self.assertNotIn("x-client-id", request.headers)
            body = json.loads(request.content)
            self.assertEqual(body["model"], "gpt-6-luna")
            if "messages" in body:
                self.assertEqual(body["messages"][0]["role"], "developer")
                self.assertEqual(body["reasoning_effort"], "none")
                return httpx.Response(
                    200,
                    json={
                        "id": "chat-id",
                        "usage": {"prompt_tokens": 10, "completion_tokens": 2},
                        "choices": [],
                    },
                )
            return httpx.Response(
                200,
                json={
                    "id": "resp-id",
                    "usage": {"input_tokens": 11, "output_tokens": 3},
                    "output": [],
                },
            )

        self.configure(backend)
        headers = {"Authorization": "Bearer " + self.key(["qwen"])["key"]}
        for path, fields in [
            (
                "/v1/chat/completions",
                {
                    "messages": [{"role": "developer", "content": "hello"}],
                    "reasoning_effort": "none",
                },
            ),
            ("/v1/responses", {"input": "hello"}),
        ]:
            r = self.client.post(
                "https://api.hilex.me" + path,
                headers=headers,
                json={"model": "gpt-6-luna", **fields},
            )
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.headers["cache-control"], "no-store")
        self.assertEqual(
            seen, ["/internal/openai/chat-completions", "/internal/openai/responses"]
        )
        rows = self.db.usage(self.tokens["user"]["id"])["requests"]
        self.assertEqual(
            sorted((r["prompt_tokens"], r["completion_tokens"]) for r in rows),
            [(10, 2), (11, 3)],
        )

    def test_catalog_retains_luna_when_local_models_are_down_and_filters_modalities(
        self,
    ):
        async def backend(request):
            if request.url.path == "/internal/luna-models":
                return httpx.Response(200, json={"data": [LUNA_MODEL_ENTRY]})
            raise httpx.ConnectError("backend down")

        self.configure(backend)
        headers = {"Authorization": "Bearer " + self.key(["qwen"])["key"]}
        r = self.client.get("https://api.hilex.me/v1/models", headers=headers)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["data"], [LUNA_MODEL_ENTRY])
        r = self.client.get(
            "https://api.hilex.me/v1/models?output_modalities=embeddings",
            headers=headers,
        )
        self.assertEqual(r.json()["data"], [])

    def test_auth_required_and_local_bypass_cannot_use_cloud_budget(self):
        payload = {
            "model": "gpt-6-luna",
            "messages": [{"role": "user", "content": "hi"}],
        }
        self.assertEqual(
            self.client.post(
                "https://api.hilex.me/v1/chat/completions", json=payload
            ).status_code,
            401,
        )
        key = self.key(["asr"])["key"]
        self.assertEqual(
            self.client.post(
                "https://api.hilex.me/v1/chat/completions",
                json=payload,
                headers={"Authorization": "Bearer " + key},
            ).status_code,
            403,
        )
        import asyncio

        async def local():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=self.app, client=("127.0.0.1", 12345))
            ) as c:
                return await c.post(
                    "http://127.0.0.1:18901/v1/chat/completions", json=payload
                )

        self.assertEqual(asyncio.run(local()).status_code, 403)

    def test_responses_sse_usage_is_recorded_exactly(self):
        tracker = UsageTracker(streaming=True)
        value = json.dumps(
            {
                "type": "response.completed",
                "response": {
                    "id": "resp-sse",
                    "usage": {"input_tokens": 12, "output_tokens": 7},
                },
            }
        ).encode()
        for block in [b"data: " + value[:20], value[20:] + b"\n\n"]:
            tracker.feed(block)
        self.assertEqual(tracker.result(), (12, 7, True))
        self.assertEqual(tracker.response_id, "resp-sse")
