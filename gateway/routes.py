"""Canonical inference routes, independent of the public hostname."""

from dataclasses import dataclass
from accounts.store import Denied

from gateway.settings import settings
from gateway.deployments import MODEL_DEPLOYMENTS

API_HOST = settings.api_host
UPSTREAMS = {"qwen": settings.llm_url, "asr": settings.asr_url, "tts": settings.tts_url}


@dataclass(frozen=True)
class Route:
    service: str
    upstream: str
    method: str = "POST"
    public: bool = True


HTTP_ROUTES = {
    "/v1/models": Route("qwen", UPSTREAMS["qwen"] + "/v1/models", "GET"),
    **{
        path: Route(deployment.service, deployment.upstream + path)
        for deployment in MODEL_DEPLOYMENTS
        for path in deployment.paths
    },
    "/v1/audio/transcriptions": Route(
        "asr", UPSTREAMS["asr"] + "/v1/audio/transcriptions"
    ),
    "/v1/audio/transcriptions/vibevoice": Route(
        "asr", settings.vibevoice_url + "/v1/audio/transcriptions", public=False
    ),
    "/v1/audio/speech": Route("tts", UPSTREAMS["tts"] + "/v1/audio/speech"),
}
WS_SERVICES = {"/ws/asr": "asr", "/ws/tts": "tts"}


def require_inference_host(host, local):
    if not local and host != API_HOST:
        raise Denied(404, f"模型推理仅使用 {API_HOST}")


def http_route(host, path, method, local=False):
    require_inference_host(host, local)
    route = HTTP_ROUTES.get(path)
    if route is None or route.method != method or (not local and not route.public):
        raise Denied(404, "未开放该接口")
    return route


def ws_service(host, path, local=False):
    require_inference_host(host, local)
    service = WS_SERVICES.get(path)
    if not service:
        raise Denied(404, "WebSocket 路径错误")
    return service
