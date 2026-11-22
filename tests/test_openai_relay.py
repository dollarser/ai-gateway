"""Private relay authorization, provider errors, streaming and WS cancellation."""

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from gateway.errors import Denied
from fastapi.testclient import TestClient
from gateway.openai_relay import router


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(router)

        @self.app.exception_handler(Denied)
        async def denied(request, exc):
            return JSONResponse({"detail": exc.detail}, status_code=exc.status)

        self.app.state.backend_id = "server"
        self.app.state.settings = SimpleNamespace(
            edge_only=True, accounts_worker_secret="private"
        )
        self.headers = {
            "X-Edge-Secret": "private",
            "X-Edge-Lease": "a" * 48,
            "Authorization": "Bearer provider-key",
        }

    def call(self, operation="responses", headers=None, handler=None):
        async def run():
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(
                    handler or (lambda r: httpx.Response(200, json={"ok": True}))
                )
            ) as upstream:
                self.app.state.client = upstream
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(
                        app=self.app, client=("127.0.0.1", 1)
                    ),
                    base_url="http://localhost",
                ) as client:
                    return await client.post(
                        "/__openai/v1/" + operation,
                        headers=headers or self.headers,
                        content=b"input",
                    )

        return asyncio.run(run())

    def test_private_auth_and_fixed_destination(self):
        for headers in (
            {"Authorization": "Bearer user-key"},
            {**self.headers, "X-Edge-Secret": "forged"},
            {**self.headers, "X-Edge-Lease": "invalid"},
        ):
            self.assertEqual(self.call(headers=headers).status_code, 401)
        self.assertEqual(self.call(operation="files").status_code, 404)
        self.assertEqual(
            self.call(operation="responses?url=https://evil.test").status_code, 404
        )

    def test_costs_are_private_and_read_only(self):
        def upstream(request):
            self.assertEqual(request.method, "GET")
            self.assertEqual(request.url.host, "api.openai.com")
            self.assertEqual(request.url.path, "/v1/organization/costs")
            self.assertEqual(
                dict(request.url.params), {"start_time": "1", "page": "a+b"}
            )
            self.assertIsNone(request.headers.get("X-Edge-Secret"))
            return httpx.Response(200, json={"data": []})

        async def run():
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(upstream)
            ) as relay:
                self.app.state.client = relay
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(
                        app=self.app, client=("127.0.0.1", 1)
                    ),
                    base_url="http://localhost",
                ) as client:
                    path = "/__openai/v1/organization/costs"
                    self.assertEqual((await client.get(path)).status_code, 401)
                    self.assertEqual(
                        (await client.post(path, headers=self.headers)).status_code, 404
                    )
                    invalid = await client.get(
                        path + "?url=https://example.net", headers=self.headers
                    )
                    self.assertEqual(invalid.status_code, 422)
                    response = await client.get(
                        path + "?start_time=1&page=a%2Bb", headers=self.headers
                    )
                    self.assertEqual(response.json(), {"data": []})

        asyncio.run(run())

    def test_http_stream_and_safe_headers(self):
        def upstream(request):
            self.assertEqual(str(request.url), "https://api.openai.com/v1/responses")
            self.assertEqual(request.headers["authorization"], "Bearer provider-key")
            for name in (
                "x-edge-secret",
                "x-edge-lease",
                "cf-connecting-ip",
                "x-forwarded-for",
                "cookie",
            ):
                self.assertNotIn(name, request.headers)
            self.assertEqual(request.content, b"input")
            return httpx.Response(
                200,
                content=b"data: hello\n\n",
                headers={
                    "content-type": "text/event-stream",
                    "x-request-id": "upstream-1",
                    "set-cookie": "private",
                },
            )

        response = self.call(
            headers={
                **self.headers,
                "CF-Connecting-IP": "192.0.2.1",
                "Cookie": "private",
            },
            handler=upstream,
        )
        self.assertEqual(response.content, b"data: hello\n\n")
        self.assertEqual(response.headers["x-request-id"], "upstream-1")
        self.assertNotIn("set-cookie", response.headers)

    def test_rejection_preserves_provider_code_and_network_uncertainty_is_marked(self):
        response = self.call(
            handler=lambda r: httpx.Response(
                403, json={"error": {"code": "unsupported_country_region_territory"}}
            )
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(
            response.json()["error"]["code"], "unsupported_country_region_territory"
        )

        def failure(request):
            raise httpx.ReadTimeout("private", request=request)

        response = self.call(handler=failure)
        self.assertEqual(response.status_code, 502)
        self.assertIn("x-openai-relay-failure", response.headers)
        self.assertNotIn("private", response.text)

    def test_realtime_preserves_provider_handshake_rejection(self):
        from websockets import InvalidStatusCode
        from websockets.datastructures import Headers

        async def connect(url, **kwargs):
            protocol = kwargs["create_protocol"]()
            protocol.rejection_body = (
                b'{"error":{"code":"unsupported_country_region_territory"}}'
            )
            raise InvalidStatusCode(403, Headers())

        async def local(scope, receive, send):
            await self.app({**scope, "client": ("127.0.0.1", 1)}, receive, send)

        with patch("gateway.openai_relay.websockets.connect", connect):
            with TestClient(local) as client:
                from starlette.testclient import WebSocketDenialResponse

                with self.assertRaises(WebSocketDenialResponse) as caught:
                    with client.websocket_connect(
                        "/__openai/v1/realtime?model=gpt-realtime-2.1-mini",
                        headers=self.headers,
                    ):
                        pass
                self.assertEqual(caught.exception.status_code, 403)
                self.assertEqual(
                    caught.exception.json()["error"]["code"],
                    "unsupported_country_region_territory",
                )

    def test_realtime_relays_and_closes_upstream(self):
        backend = SimpleNamespace(response_headers={}, closed=False)
        queue = asyncio.Queue()

        async def send_message(message):
            await queue.put(message)

        async def messages():
            yield await queue.get()
            await asyncio.Future()

        async def close_backend():
            backend.closed = True

        backend.send = send_message
        backend.__aiter__ = messages
        backend.close = close_backend

        class Backend:
            response_headers = {}
            send = staticmethod(send_message)
            close = staticmethod(close_backend)

            def __aiter__(self):
                return messages()

        async def connect(url, **kwargs):
            self.assertTrue(url.startswith("wss://api.openai.com/"))
            self.assertEqual(
                kwargs["extra_headers"], {"Authorization": "Bearer provider-key"}
            )
            return Backend()

        async def local(scope, receive, send):
            scope = {**scope, "client": ("127.0.0.1", 1)}
            await self.app(scope, receive, send)

        with patch("gateway.openai_relay.websockets.connect", connect):
            with TestClient(local) as client:
                with client.websocket_connect(
                    "/__openai/v1/realtime?model=gpt-realtime-2.1-mini",
                    headers=self.headers,
                ) as ws:
                    ws.send_text("hello")
                    self.assertEqual(ws.receive_text(), "hello")
        self.assertTrue(backend.closed)
