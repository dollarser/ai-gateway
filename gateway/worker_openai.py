"""Forward account-bound Luna requests to the Worker that owns the provider key."""

import json
import httpx
from accounts.store import Denied

LUNA_MODEL = "gpt-6-luna"
LUNA_MODEL_ENTRY = {
    "id": LUNA_MODEL,
    "object": "model",
    "owned_by": "openai",
    "architecture": {
        "input_modalities": ["text"],
        "output_modalities": ["text"],
        "modality": "text->text",
    },
}


def connection(app, lease):
    config = app.state.settings
    if not lease or not config.accounts_worker_url or not config.accounts_worker_secret:
        raise Denied(403, "Luna 需要使用 Worker 账号凭证，不能通过本地免认证端口调用")
    return config.accounts_worker_url.rstrip("/"), {
        "Authorization": "Bearer " + config.accounts_worker_secret,
        "Content-Type": "application/json",
        "X-Gateway-Lease": lease,
    }


async def catalog(app, lease):
    if not app.state.settings.accounts_worker_url:
        return []
    origin, headers = connection(app, lease)
    try:
        response = await app.state.client.post(
            origin + "/internal/luna-models",
            headers=headers,
            json={"lease": lease},
            timeout=httpx.Timeout(10, connect=3),
        )
        response.raise_for_status()
        data = response.json()["data"]
        if not isinstance(data, list) or any(
            item.get("id") != LUNA_MODEL for item in data
        ):
            raise ValueError("Invalid Luna catalog")
        return data
    except (httpx.HTTPError, ValueError, KeyError, AttributeError) as exc:
        raise Denied(503, "OpenAI 模型配置暂时不可用") from exc


def proxy_request(app, lease, path, payload):
    origin, headers = connection(app, lease)
    if path not in {"/v1/chat/completions", "/v1/responses"}:
        raise Denied(400, "Luna 请使用 Chat Completions 或 Responses 接口")
    operation = "responses" if path == "/v1/responses" else "chat-completions"
    return app.state.client.build_request(
        "POST",
        origin + "/internal/openai/" + operation,
        headers=headers,
        content=json.dumps(payload, ensure_ascii=False).encode(),
        timeout=httpx.Timeout(870, connect=5),
    )
