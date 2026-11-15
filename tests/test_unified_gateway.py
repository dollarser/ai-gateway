import asyncio
import json
import unittest
import httpx
from accounts.store import Denied
from gateway.auth import is_local_listener
from gateway.usage import UsageTracker
import test_accounts as baseline


class UnifiedGatewayTests(unittest.TestCase):
    setUp = baseline.HTTPTests.setUp
    tearDown = baseline.HTTPTests.tearDown
    login = baseline.HTTPTests.login
    key = baseline.HTTPTests.key
    post = baseline.HTTPTests.post

    def test_api_key_header_alone_and_conflicting_credentials(self):
        key = self.key(["qwen"])["key"]
        url = "https://api.hilex.me/v1/models"
        for headers in [
            {"X-API-Key": key},
            {"Authorization": "Bearer " + key},
            {"Authorization": "Bearer " + key, "X-Client-ID": "wrong"},
        ]:
            self.assertEqual(self.client.get(url, headers=headers).status_code, 200)
        self.assertEqual(
            self.client.get(
                url,
                headers={
                    "X-API-Key": key,
                    "Authorization": "Bearer " + self.tokens["access_token"],
                },
            ).status_code,
            401,
        )
        self.assertEqual(
            self.client.get(
                url,
                headers={
                    "X-API-Key": self.tokens["access_token"],
                    "X-Client-ID": self.app.state.backend_id,
                },
            ).status_code,
            401,
        )

    def test_local_listener_only_bypasses_inference(self):
        async def run():
            transport = httpx.ASGITransport(app=self.app, client=("127.0.0.1", 12345))
            async with httpx.AsyncClient(transport=transport) as c:
                self.assertEqual(
                    (await c.get("http://127.0.0.1:18901/v1/models")).status_code, 200
                )
                self.assertEqual(
                    (await c.get("http://127.0.0.1:18901/admin/users")).status_code, 401
                )
                self.assertEqual(
                    (
                        await c.get(
                            "http://api.hilex.me:18900/v1/models",
                            headers={
                                "X-Forwarded-For": "127.0.0.1",
                                "X-Forwarded-Port": "18901",
                            },
                        )
                    ).status_code,
                    401,
                )
                r = await c.get(
                    "http://api.hilex.me:18900/v1/models",
                    headers={"Host": "localhost:18901"},
                )
                self.assertNotEqual(r.status_code, 200)

        asyncio.run(run())
        self.assertEqual(
            self.db.db.execute("SELECT count(*) FROM requests").fetchone()[0], 0
        )

    def test_local_peer_must_be_loopback(self):
        self.assertFalse(
            is_local_listener(
                {"server": ("127.0.0.1", 18901), "client": ("203.0.113.1", 1)}
            )
        )
        self.assertFalse(
            is_local_listener(
                {"server": ("127.0.0.1", 18900), "client": ("127.0.0.1", 1)}
            )
        )

    def test_chat_compat_retry_and_accounting(self):
        seen = []

        async def backend(request):
            if request.url.path == "/v1/models":
                return httpx.Response(
                    200, json={"data": [{"id": "qwen", "max_model_len": 8192}]}
                )
            self.assertEqual(
                str(request.url), "http://127.0.0.1:30007/v1/chat/completions"
            )
            self.assertNotIn("authorization", request.headers)
            body = json.loads(request.content)
            seen.append(body)
            if len(seen) == 1:
                return httpx.Response(
                    400,
                    json={
                        "message": "Requested token count exceeds the model's maximum context length of 8192 tokens. You requested a total of 8292 tokens: 8000 tokens from the input messages and 292 tokens for the completion."
                    },
                )
            return httpx.Response(
                200,
                json={
                    "model": "qwen",
                    "choices": [{"message": {"content": "ok"}}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 3},
                },
            )

        # Leave enough space after the 512-token safety margin.
        async def corrected(request):
            response = await backend(request)
            if response.status_code == 400:
                return httpx.Response(
                    400,
                    json={
                        "message": "Requested token count exceeds the model's maximum context length of 8192 tokens. You requested a total of 9000 tokens: 7000 tokens from the input messages and 2000 tokens for the completion."
                    },
                )
            return response

        mock = httpx.AsyncClient(transport=httpx.MockTransport(corrected))
        self.app.state.client = mock
        try:
            r = self.client.post(
                "https://api.hilex.me/v1/chat/completions",
                headers={
                    "Authorization": "Bearer " + self.tokens["access_token"],
                    "X-Client-ID": self.app.state.backend_id,
                },
                json={
                    "model": "qwen",
                    "messages": [
                        {"role": "developer", "content": "instruction"},
                        {"role": "user", "content": "hello"},
                    ],
                    "reasoning_effort": "high",
                    "max_tokens": 20000,
                },
            )
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(len(seen), 2)
            self.assertEqual(seen[0]["messages"][0]["role"], "system")
            self.assertEqual(
                seen[0]["chat_template_kwargs"]["reasoning_effort"], "xhigh"
            )
            self.assertEqual(seen[0]["max_tokens"], 8192)
            self.assertEqual(seen[1]["max_tokens"], 680)
            row = self.db.usage(self.tokens["user"]["id"])["requests"][0]
            self.assertEqual((row["prompt_tokens"], row["completion_tokens"]), (10, 3))
            self.assertTrue(self.app.state.llm_slots.acquire(blocking=False))
            self.app.state.llm_slots.release()
        finally:
            self.client.portal.call(mock.aclose)
            self.app.state.client = self.mock

    def test_stream_usage_and_slot_release(self):
        async def backend(request):
            if request.url.path == "/v1/models":
                return httpx.Response(200, json={"data": []})
            body = json.loads(request.content)
            self.assertTrue(body["stream_options"]["include_usage"])
            return httpx.Response(
                200,
                text='data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
                headers={"content-type": "text/event-stream"},
            )

        mock = httpx.AsyncClient(transport=httpx.MockTransport(backend))
        self.app.state.client = mock
        try:
            r = self.client.post(
                "https://api.hilex.me/v1/chat/completions",
                headers={"X-API-Key": self.key(["qwen"])["key"]},
                json={
                    "messages": [{"role": "user", "content": "hello"}],
                    "stream": True,
                },
            )
            self.assertEqual(r.status_code, 200)
            self.assertIn("[DONE]", r.text)
            row = self.db.usage(self.tokens["user"]["id"])["requests"][0]
            self.assertEqual((row["prompt_tokens"], row["completion_tokens"]), (7, 2))
            self.assertEqual(row["auth_type"], "api_key")
        finally:
            self.client.portal.call(mock.aclose)
            self.app.state.client = self.mock

    def test_legacy_token_budget_and_finish_idempotence(self):
        key = self.key(["qwen"])
        kid = key["id"]
        self.db.db.execute("UPDATE keys SET legacy_daily_tokens=10 WHERE id=?", (kid,))
        lease = self.db.acquire(key["key"], "qwen", "/v1/chat/completions")
        self.assertEqual(self.db.token_remaining(lease), 10)
        self.db.finish(lease, 200, 12, prompt_tokens=7, completion_tokens=3)
        self.db.finish(lease, 200, 12, prompt_tokens=1, completion_tokens=1)
        with self.assertRaises(Denied) as exc:
            self.db.acquire(key["key"], "qwen", "/v1/chat/completions")
        self.assertEqual(exc.exception.status, 429)


class UsageTests(unittest.TestCase):
    def test_split_sse_usage(self):
        tracker = UsageTracker(True)
        for chunk in [
            b"da",
            b'ta: {"usage":{"prompt_',
            b'tokens":8,"completion_tokens":4}}\n\n',
        ]:
            tracker.feed(chunk)
        self.assertEqual(tracker.result(), (8, 4, True))

    def test_malformed_optional_usage_does_not_break_stream(self):
        tracker = UsageTracker(True, input_characters=8)
        tracker.feed(
            b'data: {"choices":[null,{"delta":null}],"usage":{"prompt_tokens":null}}\n\n'
        )
        self.assertEqual(tracker.result(), (0, 0, True))
