"""Host isolation, portal body limits and browser response policy."""

import secrets
from fastapi.responses import JSONResponse


async def security(request, call_next):
    from gateway.edge_origin import edge_request_id

    request.state.gateway_request_id = edge_request_id(
        request.app, request.headers, request.scope
    ) or secrets.token_hex(16)
    settings = request.app.state.settings
    PORTAL_HOST = settings.portal_host
    ORIGIN = "https://" + PORTAL_HOST
    host = request.url.hostname
    if host not in {
        PORTAL_HOST,
        settings.api_host,
        "127.0.0.1",
        "localhost",
        "testserver",
    }:
        return JSONResponse({"detail": "该域名不再提供服务"}, status_code=404)
    if host == settings.api_host and not (
        request.url.path.startswith("/v1/")
        or request.url.path == "/healthz"
        or request.url.path.startswith("/__codec/")
        or request.url.path.startswith("/__openai/")
        or request.url.path == "/__diagnostics/network"
    ):
        return JSONResponse(
            {"detail": f"账号和管理功能请使用 {PORTAL_HOST}"},
            status_code=404,
        )
    # Portal bodies are deliberately small; inference uploads have a separate cap.
    if request.url.path.startswith(("/auth/", "/account/", "/admin/")):
        if request.url.hostname not in {
            PORTAL_HOST,
            "127.0.0.1",
            "localhost",
            "testserver",
        }:
            return JSONResponse({"detail": "unknown account host"}, status_code=404)
        if request.method not in {"GET", "HEAD"}:
            origin = request.headers.get("origin")
            if origin and origin != ORIGIN:
                return JSONResponse({"detail": "origin denied"}, status_code=403)
            body = bytearray()
            async for piece in request.stream():
                body.extend(piece)
                if len(body) > 16384:
                    return JSONResponse(
                        {"detail": "request body too large"}, status_code=413
                    )
            request._body = bytes(body)
    response = await call_next(request)
    response.headers["X-Request-ID"] = request.state.gateway_request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    if request.url.hostname in {PORTAL_HOST, "127.0.0.1", "localhost", "testserver"}:
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        )
    return response
