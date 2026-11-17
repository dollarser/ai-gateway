"""Private fixed-destination relay. The Worker retains validation and accounting."""

import asyncio
import json
import httpx
import websockets
from fastapi import APIRouter, Request, WebSocket
from fastapi.responses import Response, StreamingResponse
from starlette.background import BackgroundTask
from gateway.edge_origin import edge_grant
from gateway.errors import Denied

router = APIRouter()
HTTP_PATHS = {"chat/completions", "responses", "embeddings", "audio/transcriptions"}


def provider_headers(headers):
    auth = headers.get("authorization", "")
    if not auth.startswith("Bearer ") or len(auth) < 10:
        raise Denied(401, "缺少提供方服务凭据")
    result = {"Authorization": auth}
    if headers.get("content-type"):
        result["Content-Type"] = headers["content-type"]
    return result


@router.post("/__openai/v1/{operation:path}")
async def relay(operation: str, request: Request):
    edge_grant(request.app, request.headers, request.scope)
    if operation not in HTTP_PATHS or request.url.query:
        raise Denied(404, "未知提供方操作")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > 26 * 1024 * 1024:
            raise Denied(413, "提供方请求体过大")
    client = request.app.state.client
    upstream_request = client.build_request(
        "POST",
        "https://api.openai.com/v1/" + operation,
        headers=provider_headers(request.headers),
        content=bytes(data),
        timeout=httpx.Timeout(850, connect=10),
    )
    try:
        upstream = await client.send(
            upstream_request, stream=True, follow_redirects=False
        )
    except httpx.HTTPError:
        return Response(
            json.dumps({"error": {"code": "relay_connect_failed"}}),
            status_code=502,
            headers={"X-OpenAI-Relay-Failure": "upstream_unknown"},
            media_type="application/json",
        )
    headers = {
        k: v
        for k, v in upstream.headers.items()
        if k in {"content-type", "x-request-id", "retry-after"}
    }

    for original, forwarded in (
        ("x-request-id", "X-OpenAI-Request-ID"),
        ("cf-ray", "X-OpenAI-CF-Ray"),
    ):
        if upstream.headers.get(original):
            headers[forwarded] = upstream.headers[original]

    async def stream():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()

    return StreamingResponse(
        stream(),
        status_code=upstream.status_code,
        headers=headers,
        background=BackgroundTask(upstream.aclose),
    )


class RealtimeProtocol(websockets.WebSocketClientProtocol):
    """Preserve bounded provider rejection JSON before the WS handshake raises."""

    rejection_body = b""

    async def read_http_response(self):
        status, headers = await super().read_http_response()
        if status != 101:
            try:
                length = int(headers.get("Content-Length", "0"))
                if 0 < length <= 16384:
                    self.rejection_body = await asyncio.wait_for(
                        self.reader.readexactly(length), 3
                    )
            except (ValueError, TimeoutError, asyncio.IncompleteReadError):
                pass
        return status, headers


@router.websocket("/__openai/v1/realtime")
async def realtime(ws: WebSocket):
    try:
        edge_grant(ws.app, ws.headers, ws.scope)
        headers = provider_headers(ws.headers)
    except Denied as exc:
        await ws.send_denial_response(Response(status_code=exc.status))
        return
    if dict(ws.query_params) != {"model": "gpt-realtime-2.1-mini"}:
        await ws.send_denial_response(Response(status_code=422))
        return
    protocols = []

    def protocol(*args, **kwargs):
        value = RealtimeProtocol(*args, **kwargs)
        protocols.append(value)
        return value

    try:
        backend = await websockets.connect(
            "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini",
            extra_headers=headers,
            create_protocol=protocol,
            open_timeout=15,
            max_size=16 * 1024 * 1024,
        )
    except websockets.InvalidStatusCode as exc:
        body = protocols[0].rejection_body if protocols else b""
        await ws.send_denial_response(
            Response(
                body or b'{"error":{"code":"relay_handshake_rejected"}}',
                status_code=exc.status_code,
                media_type="application/json",
                headers={"X-OpenAI-Request-ID": exc.headers.get("x-request-id", "")},
            )
        )
        return
    except (OSError, TimeoutError, websockets.InvalidHandshake):
        await ws.send_denial_response(
            Response(
                b'{"error":{"code":"relay_connect_failed"}}',
                status_code=502,
                headers={"X-OpenAI-Relay-Failure": "upstream_unknown"},
                media_type="application/json",
            )
        )
        return
    try:
        response_headers = []
        if backend.response_headers.get("x-request-id"):
            response_headers.append(
                (
                    b"x-openai-request-id",
                    backend.response_headers["x-request-id"].encode(),
                )
            )
        await ws.accept(headers=response_headers)

        async def upload():
            async for message in ws.iter_text():
                if len(message) > 2 * 1024 * 1024:
                    await ws.close(1009)
                    return
                await backend.send(message)

        async def download():
            async for message in backend:
                if isinstance(message, bytes):
                    await ws.send_bytes(message)
                else:
                    await ws.send_text(message)

        tasks = [asyncio.create_task(upload()), asyncio.create_task(download())]
        try:
            done, _ = await asyncio.wait(
                tasks, timeout=850, return_when=asyncio.FIRST_COMPLETED
            )
            for task in done:
                task.result()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    except (websockets.ConnectionClosed, RuntimeError):
        pass
    finally:
        await backend.close()
        if ws.application_state.name == "CONNECTED":
            await ws.close()
