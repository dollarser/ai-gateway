"""Compose account and inference routers into one application."""

import logging
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from gateway.errors import Denied
from gateway.lifecycle import lifespan
from gateway.middleware import security
from gateway.router import router as inference_router
from gateway.codec import router as codec_router
from gateway.network_diagnostics import router as diagnostic_router
from gateway.settings import Settings, settings


def create_app(config: Settings = settings) -> FastAPI:
    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = config
    app.middleware("http")(security)

    @app.exception_handler(Denied)
    async def denied(request, exc):
        logging.getLogger("uvicorn.error").log(
            logging.INFO if exc.status == 401 else logging.WARNING,
            "gateway_denied request_id=%s path=%s status=%d",
            getattr(request.state, "gateway_request_id", ""),
            request.url.path,
            exc.status,
        )
        return JSONResponse(
            {"detail": exc.detail},
            status_code=exc.status,
            headers={"Retry-After": "60" if exc.status == 429 else "2"}
            if exc.status in {429, 503}
            else {},
        )

    @app.get("/healthz")
    def health(request: Request):
        return {
            "ready": True,
            "service": "inference-gateway"
            if request.url.hostname == config.api_host
            else "accounts",
            "auth_modes": ["access_token + X-Client-ID", "API Key only"],
        }

    if not config.accounts_worker_url:
        from accounts.router import router as accounts_router

        app.include_router(accounts_router)
    app.include_router(codec_router)
    app.include_router(diagnostic_router)
    app.include_router(inference_router)
    return app


app = create_app()
