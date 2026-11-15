"""OpenRouter-style architecture metadata and output-modality filtering."""

import asyncio
import logging
import httpx
from gateway.errors import Denied
from gateway.deployments import MODEL_DEPLOYMENTS
from gateway import llm

logger = logging.getLogger("uvicorn.error")
OUTPUT_MODALITIES = frozenset(
    {
        "text",
        "image",
        "embeddings",
        "audio",
        "video",
        "rerank",
        "decisions",
        "speech",
        "transcription",
    }
)


def parse_output_modalities(value="text"):
    if not isinstance(value, str) or len(value) > 256:
        raise Denied(400, "无效的 output_modalities")
    values = value.split(",")
    if any(not item.strip() for item in values):
        raise Denied(400, "output_modalities 不能包含空项")
    selected = frozenset(item.strip() for item in values)
    if selected == {"all"}:
        return None
    if not selected or not selected <= OUTPUT_MODALITIES:
        raise Denied(400, "output_modalities 请使用有效模态，或单独使用 all")
    return selected


def build_catalog(payloads, selected=None):
    models = {}
    for deployment, payload in payloads:
        if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
            raise Denied(502, "模型后端返回了无效的模型列表")
        if deployment.reasoning_metadata:
            payload = llm.add_reasoning_capabilities(payload)
        for item in payload["data"]:
            if (
                not isinstance(item, dict)
                or not isinstance(item.get("id"), str)
                or not item["id"]
            ):
                raise Denied(502, "模型后端返回了无效的模型条目")
            entry = models.setdefault(
                item["id"],
                {
                    **item,
                    "object": "model",
                    "architecture": {
                        "input_modalities": [],
                        "output_modalities": [],
                    },
                },
            )
            # Shared IDs may represent deployments exposing multiple task routes.
            for field, values in [
                ("input_modalities", deployment.input_modalities),
                ("output_modalities", deployment.output_modalities),
            ]:
                target = entry["architecture"][field]
                target.extend(value for value in values if value not in target)
            if deployment.reasoning_metadata:
                for field in [
                    "supported_reasoning_efforts",
                    "default_reasoning_effort",
                    "reasoning_effort_aliases",
                ]:
                    entry[field] = item[field]
    data = []
    for entry in models.values():
        architecture = entry["architecture"]
        architecture["modality"] = (
            "+".join(architecture["input_modalities"])
            + "->"
            + "+".join(architecture["output_modalities"])
        )
        if selected is None or selected.intersection(architecture["output_modalities"]):
            data.append(entry)
    return {"object": "list", "data": data}


async def discover_models(client, headers, selected, deployments=MODEL_DEPLOYMENTS):
    async def fetch(deployment):
        try:
            response = await client.get(
                deployment.upstream + "/v1/models",
                headers=headers,
                timeout=httpx.Timeout(10, connect=3),
            )
            response.raise_for_status()
            return deployment, response.json()
        except (httpx.HTTPError, ValueError) as exc:
            # Public responses contain neither backend URLs nor raw backend errors.
            logger.warning(
                "model_catalog_unavailable deployment=%s error=%s",
                deployment.name,
                type(exc).__name__,
            )
            raise Denied(502, "模型列表暂时不可用，请稍后重试") from exc

    # Await every outcome so a failed backend cannot leave background fetches behind.
    results = await asyncio.gather(
        *(fetch(deployment) for deployment in deployments), return_exceptions=True
    )
    for result in results:
        if isinstance(result, BaseException):
            raise result
    catalog = build_catalog(results, selected)
    window = next(
        (
            llm.parse_model_max_len(payload)
            for deployment, payload in results
            if deployment.reasoning_metadata
        ),
        0,
    )
    return catalog, window
