"""Gateway integration fixture with an in-process Worker HTTP transport."""

import json
from pathlib import Path
import tempfile
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.remote_store import RemoteStore
from gateway.settings import Settings


class GatewayHTTPFixture:
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        ids = Path(temporary.name) / "client-ids.json"
        ids.write_text('["test-backend-client"]')
        config = Settings(
            client_ids_file=ids,
            accounts_worker_url="https://accounts.hilex.me",
            accounts_worker_secret="test-worker-secret-" * 3,
        )
        self.tokens = {"access_token": "ai-at-test"}
        self.keys = {}
        self.requests = {}
        store = RemoteStore(
            config.accounts_worker_url,
            config.accounts_worker_secret,
            transport=httpx.MockTransport(self.worker),
        )
        self.app = create_app(config)
        self.client = TestClient(self.app, base_url=config.accounts_worker_url)
        with patch("gateway.lifecycle.RemoteStore", return_value=store):
            self.client.__enter__()
        self.original_client = self.app.state.client

        async def backend(request):
            if request.url.path == "/internal/openai-models":
                return httpx.Response(200, json={"data": []})
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
                )
            return httpx.Response(200, json={"text": "ok"})

        self.mock = httpx.AsyncClient(transport=httpx.MockTransport(backend))
        self.app.state.client = self.mock

    def tearDown(self):
        try:
            self.client.portal.call(self.mock.aclose)
        finally:
            self.app.state.client = self.original_client
            self.client.__exit__(None, None, None)

    def key(self, services=("asr",)):
        key = f"sk-acct-test-{len(self.keys) + 1}"
        self.keys[key] = set(services)
        return {"key": key}

    def worker(self, request):
        data = json.loads(request.content)
        operation = request.url.path.rsplit("/", 1)[-1]
        if operation == "acquire":
            raw = data["raw"]
            account = raw == self.tokens["access_token"]
            services = {"qwen", "asr", "tts"} if account else self.keys.get(raw, set())
            if not services:
                return httpx.Response(401, json={"detail": "invalid credential"})
            if data["service"] != "catalog" and data["service"] not in services:
                return httpx.Response(403, json={"detail": "service denied"})
            lease = f"{len(self.requests) + 1:048x}"
            self.requests[lease] = {"auth_type": "account" if account else "api_key"}
            return httpx.Response(200, json={"lease": lease})
        if operation == "token-remaining":
            return httpx.Response(200, json={"remaining": None})
        if operation == "finish":
            self.requests[data["lease"]].update(data)
        else:
            assert operation in {"check-auth", "record-auth-failure"}
        return httpx.Response(200, json={"ok": True})
