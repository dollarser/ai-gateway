"""Own inference HTTP clients and either a local store or Worker account adapter."""

import fcntl
import json
import os
import threading
from contextlib import asynccontextmanager, ExitStack
import httpx
from accounts.store import Store
from gateway.remote_store import RemoteStore


@asynccontextmanager
async def lifespan(app):
    settings = app.state.settings
    os.umask(0o077)
    with ExitStack() as stack:
        if settings.accounts_worker_url:
            store = RemoteStore(
                settings.accounts_worker_url, settings.accounts_worker_secret
            )
            stack.callback(store.close)
        else:
            settings.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            lock = stack.enter_context((settings.data_dir / "instance.lock").open("a"))
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            store = Store(settings.data_dir / "accounts.db")
            stack.callback(store.db.close)
            if not store.users():
                bootstrap = json.loads(
                    (settings.data_dir / "bootstrap-admin.json").read_text()
                )
                store.create_user(
                    bootstrap["username"],
                    bootstrap["password"],
                    role="admin",
                    must_change=True,
                )
        app.state.store = store
        app.state.llm_slots = threading.BoundedSemaphore(settings.llm_concurrency)
        app.state.llm_model_max_len = 0
        allowed_ids = json.loads(settings.client_ids_file.read_text())
        if (
            not isinstance(allowed_ids, list)
            or not allowed_ids
            or any(
                not isinstance(v, str) or not v or not v.isascii() or len(v) > 256
                for v in allowed_ids
            )
        ):
            raise ValueError(
                "Client ID allowlist must be a nonempty list of ASCII identifiers"
            )
        app.state.backend_id = os.environ.get(
            "GATEWAY_BACKEND_CLIENT_ID", allowed_ids[0]
        )
        app.state.allowed_client_ids = tuple(v.encode() for v in allowed_ids)
        async with httpx.AsyncClient(
            trust_env=False,
            timeout=httpx.Timeout(90, connect=5),
            limits=httpx.Limits(max_connections=32),
        ) as client:
            app.state.client = client
            yield
