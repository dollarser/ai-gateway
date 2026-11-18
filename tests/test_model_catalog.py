"""Deployment-backed discovery and OpenRouter model filtering contracts."""

import asyncio
from dataclasses import replace
import unittest
import httpx
from legacy.accounts.store import Denied
from gateway.catalog import build_catalog, discover_models, parse_output_modalities
from gateway.deployments import MODEL_DEPLOYMENTS
from gateway.routes import HTTP_ROUTES
import test_accounts as baseline


class CatalogTests(unittest.TestCase):
    def test_metadata_preserved_and_shared_ids_merge_real_modalities(self):
        chat, embedding = MODEL_DEPLOYMENTS
        item = {
            "id": "multi-purpose",
            "object": "model",
            "created": 123,
            "owned_by": "owner",
        }
        result = build_catalog(
            [(chat, {"data": [item]}), (embedding, {"data": [item]})]
        )
        self.assertEqual(len(result["data"]), 1)
        model = result["data"][0]
        self.assertEqual(model["created"], 123)
        self.assertEqual(model["owned_by"], "owner")
        self.assertEqual(
            model["architecture"],
            {
                "input_modalities": ["text"],
                "output_modalities": ["text", "embeddings"],
                "modality": "text->text+embeddings",
            },
        )
        self.assertNotIn("architecture", item)
        self.assertNotIn("capabilities", model)
        self.assertNotIn("supports_vision", model)

    def test_routing_and_discovery_share_deployments(self):
        for deployment in MODEL_DEPLOYMENTS:
            for path in deployment.paths:
                self.assertEqual(HTTP_ROUTES[path].upstream, deployment.upstream + path)
                self.assertEqual(HTTP_ROUTES[path].service, deployment.service)
        embedding = build_catalog(
            [(MODEL_DEPLOYMENTS[1], {"data": [{"id": "embed-id"}]})]
        )["data"][0]
        self.assertNotIn("supported_reasoning_efforts", embedding)
        self.assertNotIn("created", embedding)

    def test_filter_validation(self):
        self.assertEqual(parse_output_modalities(), {"text"})
        self.assertIsNone(parse_output_modalities("all"))
        self.assertEqual(
            parse_output_modalities("text, embeddings"), {"text", "embeddings"}
        )
        for value in ["", "chat", "all,text", "text,,audio", "text,", "a" * 257]:
            with self.assertRaises(Denied):
                parse_output_modalities(value)

    def test_discovery_uses_actual_backend_ids_and_preserves_full_architecture(self):
        async def run():
            calls = []

            async def backend(request):
                calls.append(request.url.port)
                return httpx.Response(200, json={"data": [{"id": "real-id"}]})

            async with httpx.AsyncClient(
                transport=httpx.MockTransport(backend)
            ) as client:
                catalog, _ = await discover_models(client, {}, {"embeddings"})
            self.assertEqual(set(calls), {30007, 18771})
            self.assertEqual(catalog["data"][0]["id"], "real-id")
            self.assertEqual(
                catalog["data"][0]["architecture"]["output_modalities"],
                ["text", "embeddings"],
            )

        asyncio.run(run())

    def test_backend_failure_isolation_and_all_failed_error(self):
        async def run():
            for failure in ("connect", "timeout", "invalid", "slow", "all"):

                async def backend(request):
                    if request.url.port == 30007 or failure == "all":
                        if failure in {"connect", "all"}:
                            raise httpx.ConnectError("private backend", request=request)
                        if failure == "timeout":
                            raise httpx.ReadTimeout("private backend", request=request)
                        if failure == "slow":
                            await asyncio.sleep(5)
                        return httpx.Response(200, json={"data": [None]})
                    return httpx.Response(
                        200, json={"data": [{"id": "embedding-live"}]}
                    )

                async with httpx.AsyncClient(
                    transport=httpx.MockTransport(backend)
                ) as client:
                    unavailable = []
                    if failure == "all":
                        with self.assertRaises(Denied) as raised:
                            await discover_models(
                                client, {}, None, unavailable=unavailable
                            )
                        self.assertEqual(raised.exception.status, 502)
                    else:
                        catalog, window = await discover_models(
                            client, {}, None, unavailable=unavailable
                        )
                        self.assertEqual(
                            [m["id"] for m in catalog["data"]], ["embedding-live"]
                        )
                        self.assertEqual(window, 0)
                        self.assertEqual(unavailable, ["chat"])

        asyncio.run(run())

    def test_inactive_deployments_and_unsupported_modalities_are_absent(self):
        deployment = MODEL_DEPLOYMENTS[0]
        self.assertEqual(
            build_catalog([(deployment, {"data": [{"id": "chat-only"}]})], {"rerank"})[
                "data"
            ],
            [],
        )
        rerank = replace(
            MODEL_DEPLOYMENTS[1],
            name="rerank",
            paths=("/v1/rerank",),
            output_modalities=("rerank",),
        )
        model = build_catalog([(rerank, {"data": [{"id": "ranker"}]})], {"rerank"})[
            "data"
        ][0]
        self.assertEqual(model["architecture"]["modality"], "text->rerank")

    def test_malformed_catalog_is_an_explicit_error(self):
        for payload in [
            None,
            {},
            {"data": {}},
            {"data": [None]},
            {"data": [{"id": ""}]},
        ]:
            with self.assertRaises(Denied) as raised:
                build_catalog([(MODEL_DEPLOYMENTS[0], payload)])
            self.assertEqual(raised.exception.status, 502)


class CatalogHTTPTests(unittest.TestCase):
    setUp = baseline.HTTPTests.setUp
    tearDown = baseline.HTTPTests.tearDown
    login = baseline.HTTPTests.login
    key = baseline.HTTPTests.key

    def test_default_text_all_embedding_and_csv_filters(self):
        key = self.key(["qwen"])["key"]
        for suffix, outputs in [
            ("", ["text"]),
            ("?output_modalities=all", ["text", "embeddings"]),
            ("?output_modalities=embeddings", ["embeddings"]),
            ("?output_modalities=text,embeddings", ["text", "embeddings"]),
            ("?output_modalities=rerank", []),
        ]:
            r = self.client.get(
                "https://api.hilex.me/v1/models" + suffix,
                headers={"X-API-Key": key},
            )
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(
                [m["architecture"]["output_modalities"][0] for m in r.json()["data"]],
                outputs,
            )
            self.assertTrue(r.headers["x-request-id"])
        for suffix in [
            "?output_modalities=chat",
            "?output_modalities=",
            "?output_modalities=text&output_modalities=embeddings",
        ]:
            r = self.client.get(
                "https://api.hilex.me/v1/models" + suffix,
                headers={"X-API-Key": key},
            )
            self.assertEqual(r.status_code, 400)

    def test_failed_embedding_preserves_chat_and_settles_quota(self):
        key = self.key(["qwen"])["key"]

        async def backend(request):
            if request.url.port == 18771:
                return httpx.Response(503, text="private backend detail")
            return httpx.Response(200, json={"data": [{"id": "chat"}]})

        mock = httpx.AsyncClient(transport=httpx.MockTransport(backend))
        self.app.state.client = mock
        try:
            response = self.client.get(
                "https://api.hilex.me/v1/models?output_modalities=all",
                headers={"X-API-Key": key},
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual([m["id"] for m in response.json()["data"]], ["chat"])
            self.assertEqual(
                response.headers["X-Model-Catalog-Partial"], "local_unavailable"
            )
            self.assertNotIn("private backend detail", response.text)
            self.assertNotIn("18771", response.text)
            row = self.db.db.execute(
                "SELECT ended,status FROM requests ORDER BY started DESC LIMIT 1"
            ).fetchone()
            self.assertIsNotNone(row["ended"])
            self.assertEqual(row["status"], 200)
        finally:
            self.client.portal.call(mock.aclose)
            self.app.state.client = self.mock
