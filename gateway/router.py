"""Unified inference routes. Public and local listeners share one account store."""

import asyncio
import json
import time
import logging
import secrets
from async_timeout import timeout
import httpx
import websockets
from fastapi import APIRouter, Request, WebSocket
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.exceptions import HTTPException
from gateway.errors import Denied
from gateway.auth import authorize_inference, is_local_listener
from gateway import llm as llm_protocol
from gateway.usage import UsageTracker
from gateway.catalog import discover_models, parse_output_modalities
from gateway.tracking import safe_id
from gateway.edge_origin import trusted_edge, edge_request_id

router = APIRouter()
from gateway.routes import UPSTREAMS, http_route, ws_service

logger = logging.getLogger("uvicorn.error")


@router.api_route("/{path:path}", methods=["GET", "POST", "OPTIONS"])
async def inference(path: str, request: Request):
    local = is_local_listener(request.scope)
    edge = trusted_edge(request.app, request.headers, request.scope)
    if not edge:
        # Offline/legacy cloud bridge only; production edge requests never enter it.
        from gateway import worker_openai as openai_proxy
        from gateway import audio as audio_proxy
    path = "/" + path
    route = http_route(request.url.hostname, path, request.method, local)
    service = (
        "catalog"
        if path == "/v1/models"
        and hasattr(request.app.state.store, "acquire_with_metadata")
        else route.service
    )
    lease = None
    headers = {
        "User-Agent": "unified-ai-gateway/2.0",
        "X-Client-ID": request.app.state.backend_id,
    }
    if not local:
        lease, _ = await asyncio.to_thread(
            authorize_inference,
            request.app,
            request.headers,
            service,
            path,
            scope=request.scope,
        )
    request_id = getattr(
        request.state, "gateway_request_id", None
    ) or secrets.token_hex(16)
    headers["X-Request-ID"] = request_id
    trace = {
        "request_id": request_id,
        "provider": "local",
        "protocol": "http",
        "failure_stage": "validation",
    }
    request.state.inference_trace = trace
    for name, field in [
        ("x-client-request-id", "client_request_id"),
        ("x-helix-turn-id", "helix_turn_id"),
        ("x-helix-model-call-id", "helix_model_call_id"),
    ]:
        value = safe_id(
            request.headers.get(name)
            or (
                request.headers.get("x-request-id")
                if field == "client_request_id"
                else None
            )
        )
        if value:
            headers[name] = value
            trace[field] = value
    if request.headers.get("content-type"):
        headers["Content-Type"] = request.headers["content-type"]
    llm = service == "qwen" and path in {"/v1/chat/completions", "/v1/completions"}
    cap = 21 * 1024 * 1024 if service == "asr" else 4 * 1024 * 1024
    started = time.monotonic()
    upstream = None
    size, status = 0, 499
    transferred = False
    slot = False
    finished = False
    tracker = None

    async def finish():
        nonlocal finished
        if finished:
            return
        finished = True
        pt, ct, exact = tracker.result() if tracker else (0, 0, False)
        trace["duration_ms"] = round((time.monotonic() - started) * 1000)
        if status < 400:
            trace["failure_stage"] = None
        trace["upstream_response_id"] = tracker.response_id if tracker else None
        try:
            if lease and not edge:
                await asyncio.to_thread(
                    request.app.state.store.finish,
                    lease,
                    status,
                    size,
                    prompt_tokens=pt,
                    completion_tokens=ct,
                    trace=trace,
                )
        finally:
            if slot:
                request.app.state.llm_slots.release()
        logger.info(
            "inference request_id=%s service=%s path=%s local=%s status=%d bytes=%d prompt_tokens=%d completion_tokens=%d tokens_exact=%s seconds=%.4f trace=%s",
            request_id,
            service,
            path,
            local,
            status,
            size,
            pt,
            ct,
            exact,
            time.monotonic() - started,
            json.dumps(trace, ensure_ascii=True),
        )

    try:
        async with timeout(60):
            body = bytearray()
            async for block in request.stream():
                body.extend(block)
                if len(body) > cap:
                    raise Denied(413, "请求体超过服务限制")
        audio_request = None
        audio_format = None
        if (
            not edge
            and path == "/v1/audio/transcriptions"
            and request.headers.get("content-type", "").startswith(
                "multipart/form-data"
            )
        ):
            request.state.audio_lease = lease
            audio_request = await audio_proxy.prepare_asr(request, body)
        elif not edge and path == "/v1/audio/transcriptions":
            if (
                request.app.state.settings.accounts_worker_url
                and request.headers.get("x-inference-provider") != "local"
            ):
                trace["error_code"] = "invalid_audio_content_type"
                raise Denied(
                    422,
                    "语音识别需要 multipart/form-data，包含 model=gpt-transcribe 和 file 音频字段",
                )
        elif not edge and path == "/v1/audio/speech":
            prepared = await audio_proxy.prepare_tts(request, body, lease)
            if prepared:
                audio_request, audio_format = prepared
        if audio_request:
            trace["failure_stage"] = "provider_request"
            upstream = await request.app.state.client.send(audio_request, stream=True)
            status = upstream.status_code
            trace["upstream_status"] = int(
                upstream.headers.get("x-upstream-status", status)
            )
            if status >= 400:
                trace["error_code"] = (
                    safe_id(upstream.headers.get("x-error-code")) or "provider_rejected"
                )
            if audio_format and audio_format != "stream-pcm" and status == 200:
                pcm = await upstream.aread()
                if len(pcm) > 16 * 1024 * 1024 or len(pcm) % 2:
                    raise Denied(502, "无效的上游音频")
                result = pcm
                size = len(result)
                from fastapi.responses import Response

                return Response(
                    result,
                    media_type="audio/pcm",
                    headers={
                        "Cache-Control": "no-store",
                        "X-Request-ID": request_id,
                        "X-Audio-Sample-Rate": "24000",
                    },
                )

            async def audio_stream():
                nonlocal size, status
                try:
                    async with timeout(240):
                        async for chunk in upstream.aiter_bytes():
                            size += len(chunk)
                            yield chunk
                except asyncio.CancelledError:
                    status = 499
                    raise
                except (httpx.HTTPError, TimeoutError):
                    trace.update(
                        failure_stage="response_stream", error_code="stream_interrupted"
                    )
                    status = 504
                    raise
                finally:
                    try:
                        await upstream.aclose()
                    finally:
                        await finish()

            transferred = True
            return StreamingResponse(
                audio_stream(),
                status_code=status,
                headers={
                    "Content-Type": upstream.headers.get(
                        "content-type", "application/json"
                    ),
                    "Cache-Control": "no-store",
                    "X-Request-ID": request_id,
                    **({"Retry-After": "60"} if status == 429 else {}),
                    **(
                        {"X-Audio-Sample-Rate": "24000"}
                        if audio_format == "stream-pcm"
                        else {}
                    ),
                },
            )
        if service == "qwen" and path in {
            "/v1/chat/completions",
            "/v1/completions",
            "/v1/responses",
        }:
            try:
                candidate = json.loads(body)
            except (ValueError, UnicodeDecodeError):
                raise Denied(400, "无效的 JSON 请求")
            if not isinstance(candidate, dict):
                raise Denied(400, "JSON 请求必须为对象")
            if not edge and (
                candidate.get("model") == openai_proxy.LUNA_MODEL
                or path == "/v1/responses"
            ):
                trace.update(
                    model=candidate.get("model"),
                    provider="openai",
                    failure_stage="provider_request",
                    protocol="sse" if candidate.get("stream") else "http",
                )
                # The Worker reserves and settles the budget; the gateway never
                # receives OPENAI_API_KEY and never applies SGLang rewrites here.
                upstream = await request.app.state.client.send(
                    openai_proxy.proxy_request(request.app, lease, path, candidate),
                    stream=True,
                )
                status = upstream.status_code
                trace["upstream_status"] = int(
                    upstream.headers.get("x-upstream-status", status)
                )
                if status >= 400:
                    trace["error_code"] = (
                        safe_id(upstream.headers.get("x-error-code"))
                        or "provider_rejected"
                    )
                tracker = UsageTracker(
                    streaming=bool(candidate.get("stream")), input_characters=0
                )

                async def openai_stream():
                    nonlocal size, status
                    try:
                        async with timeout(890):
                            async for chunk in upstream.aiter_bytes():
                                size += len(chunk)
                                tracker.feed(chunk)
                                yield chunk
                    except asyncio.CancelledError:
                        status = 499
                        raise
                    except (TimeoutError, httpx.HTTPError):
                        status = 504
                        raise
                    finally:
                        try:
                            await upstream.aclose()
                        finally:
                            await finish()

                transferred = True
                return StreamingResponse(
                    openai_stream(),
                    status_code=status,
                    headers={
                        "Content-Type": upstream.headers.get(
                            "content-type", "application/json"
                        ),
                        "Cache-Control": "no-store",
                        "X-Request-ID": request_id,
                        **(
                            {"Retry-After": upstream.headers["retry-after"]}
                            if "retry-after" in upstream.headers
                            else {}
                        ),
                    },
                )
        if path == "/v1/models":
            values = request.query_params.getlist("output_modalities")
            if len(values) > 1:
                raise Denied(400, "output_modalities 请使用单个逗号分隔参数")
            selected = parse_output_modalities(values[0] if values else "text")
            luna, permissions = (
                await openai_proxy.catalog(request.app, lease, include_services=True)
                if not local and not edge
                else ([], ["qwen"])
            )
            if "qwen" not in permissions:
                catalog, window = {"object": "list", "data": []}, 0
            else:
                catalog, window = None, 0
            try:
                if catalog is None:
                    catalog, window = await discover_models(
                        request.app.state.client, headers, selected
                    )
            except Denied:
                if not luna:
                    raise
                catalog, window = {"object": "list", "data": []}, 0
            catalog["data"].extend(
                item
                for item in luna
                if selected is None
                or selected.intersection(
                    item.get("architecture", {}).get("output_modalities", ["text"])
                )
            )
            request.app.state.llm_model_max_len = window
            status = 200
            response = JSONResponse(catalog, headers={"X-Request-ID": request_id})
            size = len(response.body)
            return response
        first_timeout = 180 if service in {"asr", "tts"} else 90
        upstream_url = route.upstream
        payload = None
        if llm:
            if not request.app.state.llm_slots.acquire(blocking=False):
                raise Denied(503, "LLM 并发已满，请稍后重试")
            slot = True
            try:
                payload = json.loads(body)
            except (ValueError, UnicodeDecodeError):
                raise Denied(400, "无效的 JSON 请求")
            if not isinstance(payload, dict):
                raise Denied(400, "JSON 请求必须为对象")
            try:
                payload = llm_protocol.rewrite_payload(payload)
            except llm_protocol.UnsupportedReasoningEffort:
                raise Denied(400, "不支持该 reasoning_effort")
            window = request.app.state.llm_model_max_len
            if not window:
                try:
                    meta = await request.app.state.client.get(
                        UPSTREAMS["qwen"] + "/v1/models", headers=headers, timeout=5
                    )
                    if meta.status_code == 200:
                        window = llm_protocol.parse_model_max_len(meta.json())
                    request.app.state.llm_model_max_len = window
                except (httpx.HTTPError, ValueError):
                    pass
            for field in ["max_completion_tokens", "max_tokens"]:
                if (
                    window
                    and isinstance(payload.get(field), int)
                    and payload[field] > window
                ):
                    payload[field] = window
            remaining = (
                await asyncio.to_thread(request.app.state.store.token_remaining, lease)
                if lease
                else None
            )
            if remaining is not None:
                if remaining <= 0:
                    raise Denied(429, "API Key 每日 token 额度已用尽")
                field = (
                    "max_completion_tokens"
                    if "max_completion_tokens" in payload
                    else "max_tokens"
                )
                value = payload.get(field, remaining)
                if isinstance(value, int):
                    payload[field] = min(value, remaining)
            if payload.get("stream"):
                options = payload.get("stream_options")
                payload["stream_options"] = {
                    **(options if isinstance(options, dict) else {}),
                    "include_usage": True,
                }
            body = json.dumps(payload, ensure_ascii=False).encode()
        tracker = (
            UsageTracker(
                streaming=bool(payload and payload.get("stream")),
                input_characters=len(body) if llm else 0,
            )
            if service == "qwen"
            else None
        )

        async def send(content):
            req = request.app.state.client.build_request(
                request.method,
                upstream_url,
                content=bytes(content),
                headers=headers,
                timeout=httpx.Timeout(first_timeout, connect=5),
            )
            async with timeout(first_timeout):
                return await request.app.state.client.send(req, stream=True)

        trace["failure_stage"] = "upstream_connect"
        upstream = await send(body)
        if llm and upstream.status_code == 400:
            error = await upstream.aread()
            retry = llm_protocol.plan_context_retry(error, payload)
            if retry:
                await upstream.aclose()
                payload, _ = retry
                body = json.dumps(payload, ensure_ascii=False).encode()
                upstream = await send(body)
        status = upstream.status_code
        trace["upstream_status"] = status
        if status >= 400:
            trace["error_code"] = "upstream_rejected"
        outgoing = {
            k: v
            for k, v in upstream.headers.items()
            if k.lower()
            in {
                "content-type",
                "content-disposition",
                "retry-after",
                "www-authenticate",
            }
        }
        outgoing["X-Request-ID"] = request_id

        async def stream():
            nonlocal size, status
            try:
                async with timeout(max(0.01, 900 - (time.monotonic() - started))):
                    async for chunk in upstream.aiter_bytes():
                        size += len(chunk)
                        if tracker:
                            tracker.feed(chunk)
                        yield chunk
            except asyncio.CancelledError:
                status = 499
                raise
            except (TimeoutError, httpx.HTTPError):
                status = 504
                raise
            finally:
                try:
                    await upstream.aclose()
                finally:
                    await finish()

        transferred = True
        return StreamingResponse(stream(), status_code=status, headers=outgoing)
    except (httpx.HTTPError, TimeoutError):
        trace["error_code"] = "upstream_unavailable"
        status = 502
        raise Denied(502, "上游服务暂时不可用")
    except HTTPException as exc:
        status = exc.status_code
        trace.update(failure_stage="validation", error_code="invalid_request")
        raise
    except Denied as exc:
        trace.setdefault(
            "error_code",
            "invalid_request" if exc.status < 500 else "provider_unavailable",
        )
        status = exc.status
        raise
    finally:
        if not transferred:
            try:
                if upstream:
                    await upstream.aclose()
            finally:
                await finish()


@router.websocket("/ws/{mode}")
async def websocket(ws: WebSocket, mode: str):
    async def close(code=1000, reason=""):
        if (
            ws.application_state.name == "DISCONNECTED"
            or getattr(getattr(ws, "client_state", None), "name", None)
            == "DISCONNECTED"
        ):
            return
        try:
            await ws.close(code=code, reason=reason)
        except RuntimeError:
            # The transport may finish while a backend close is in flight.
            logger.debug("WebSocket transport already closed")

    request_id = edge_request_id(ws.app, ws.headers, ws.scope) or secrets.token_hex(16)
    diagnostic = {
        "request_id": request_id,
        "protocol": "websocket",
        "provider": "local",
        "failure_stage": "authentication",
    }

    async def deny(code, message, error):
        diagnostic["error_code"] = error
        if (
            ws.application_state.name == "CONNECTING"
            and "websocket.http.response" in ws.scope.get("extensions", {})
        ):
            await ws.send_denial_response(
                JSONResponse(
                    {"detail": message, "error_code": error, "request_id": request_id},
                    status_code=code,
                    headers={
                        "X-Request-ID": request_id,
                        **({"Retry-After": "30"} if code == 503 else {}),
                    },
                )
            )
        else:
            await close(code=1008 if code in {401, 403} else 1013, reason=message[:100])

    lease = None
    status, size = 499, 0
    try:
        local = is_local_listener(ws.scope)
        service = ws_service(ws.url.hostname, "/ws/" + mode, local)
        protocols = ws.scope.get("subprotocols", [])
        if local:
            headers = {"X-Client-ID": ws.app.state.backend_id}
        else:
            lease, headers = await asyncio.to_thread(
                authorize_inference,
                ws.app,
                ws.headers,
                service,
                "/ws/" + mode,
                protocols,
                scope=ws.scope,
            )
        if getattr(ws, "query_params", {}).get("model", "").startswith("gpt-"):
            diagnostic["failure_stage"] = "validation"
            raise Denied(
                422,
                "云语音请使用 /v1/audio/transcriptions 或 /v1/audio/speech HTTP 接口",
            )
        diagnostic["failure_stage"] = "upstream_connect"
        upstream = UPSTREAMS[service].replace("http://", "ws://") + "/ws/" + mode
        async with websockets.connect(
            upstream, extra_headers=headers, max_size=16 * 1024 * 1024
        ) as backend:
            await ws.accept(
                subprotocol="speech" if "speech" in protocols else None,
                headers=[(b"x-request-id", request_id.encode())],
            )
            status = 101

            async def upload():
                uploaded = 0
                while True:
                    msg = await ws.receive()
                    if msg["type"] == "websocket.disconnect":
                        return
                    payload = (
                        msg.get("bytes")
                        if msg.get("bytes") is not None
                        else msg.get("text", "")
                    )
                    uploaded += len(payload)
                    if uploaded > 21 * 1024 * 1024:
                        raise Denied(413, "WebSocket 输入超过限制")
                    await backend.send(payload)

            async def download():
                nonlocal size
                async for msg in backend:
                    size += len(msg)
                    if isinstance(msg, bytes):
                        await ws.send_bytes(msg)
                    else:
                        await ws.send_text(msg)

            download_task = asyncio.create_task(download())
            tasks = [asyncio.create_task(upload()), download_task]
            try:
                async with timeout(900):
                    done, _ = await asyncio.wait(
                        tasks, return_when=asyncio.FIRST_COMPLETED
                    )
                    for task in done:
                        task.result()
                    if download_task in done:
                        code = backend.close_code or 1000
                        await close(
                            code=code if code not in {1005, 1006, 1015} else 1011,
                            reason=backend.close_reason or "",
                        )
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        if ws.application_state.name != "DISCONNECTED":
            await close()
    except websockets.ConnectionClosed as exc:
        status = 503 if exc.code == 1013 else 502
        try:
            await close(
                code=exc.code if exc.code not in {1005, 1006, 1015} else 1011,
                reason=exc.reason or "",
            )
        except RuntimeError:
            pass
    except Denied as exc:
        status = exc.status
        await deny(
            exc.status,
            exc.detail,
            "authentication_failed"
            if exc.status == 401
            else "permission_denied"
            if exc.status == 403
            else "invalid_protocol",
        )
    except (TimeoutError, websockets.InvalidHandshake, OSError):
        status = 503
        try:
            await deny(
                503,
                "自建语音上游不可达；云语音请使用 HTTP 接口",
                "upstream_unavailable",
            )
        except RuntimeError:
            pass
    finally:
        logger.info(
            "websocket request_id=%s status=%s trace=%s",
            request_id,
            status,
            json.dumps(diagnostic),
        )
        if lease:
            if hasattr(ws.app.state.store, "acquire_with_metadata"):
                await asyncio.to_thread(
                    ws.app.state.store.finish, lease, status, size, trace=diagnostic
                )
            else:
                await asyncio.to_thread(ws.app.state.store.finish, lease, status, size)
