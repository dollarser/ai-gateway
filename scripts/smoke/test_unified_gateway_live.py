"""Live local/public acceptance; credentials remain in memory; test identities disabled."""

import asyncio
import json
import secrets
import socket
import sys
import time
from pathlib import Path
import httpx
import websockets

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from accounts.store import Store

ROOT = Path(__file__).resolve().parents[2]
portal = "https://accounts.sunlingzhang.com"
api = "https://api.sunlingzhang.com/v1"
cid = json.loads((ROOT / "deploy/client_ids.json").read_text())[0]
stamp = str(int(time.time()))
username = f"unified-smoke-{stamp}@example.com"
password = secrets.token_urlsafe(24)
store = Store(ROOT / "accounts/data/accounts.db", recover_leases=False)
primary = next(u for u in store.users() if u["role"] == "admin" and u["enabled"])
manager = store.create_user(
    "smoke-manager-" + stamp,
    secrets.token_urlsafe(32),
    role="admin",
    must_change=False,
    actor=primary["id"],
)
uid = kid = None
results = {}
try:
    with httpx.Client(
        trust_env=False,
        timeout=180,
        headers={"User-Agent": "unified-platform-test/1.0"},
    ) as c:
        r = c.post(
            portal + "/auth/register", json={"email": username, "password": password}
        )
        r.raise_for_status()
        r = c.post(
            portal + "/auth/login", json={"username": username, "password": password}
        )
        r.raise_for_status()
        identity = r.json()
        uid = identity["user"]["id"]
        token = identity["access_token"]
        refresh = identity["refresh_token"]
        c.cookies.clear()
        key, kid = store.create_key(
            uid, "acceptance", ["qwen", "asr", "tts"], 1, actor=manager["id"]
        )
        account = {"Authorization": "Bearer " + token, "X-Client-ID": cid}
        key_header = {"X-API-Key": key}
        for label, headers in [
            ("none", {}),
            ("client_only", {"X-Client-ID": cid}),
            ("token_only", {"Authorization": "Bearer " + token}),
            (
                "wrong_client",
                {"Authorization": "Bearer " + token, "X-Client-ID": "invalid"},
            ),
            (
                "spoofed_local",
                {"X-Forwarded-For": "127.0.0.1", "X-Forwarded-Port": "18901"},
            ),
            ("bad_key", {"X-API-Key": "sk-acct-invalid"}),
        ]:
            r = c.get(api + "/models", headers=headers)
            assert r.status_code == 401, (label, r.status_code)
            results[label] = 401
        r = c.get(api + "/models?output_modalities=all", headers=account)
        r.raise_for_status()
        models = r.json()["data"]
        assert any(x["id"] == "Qwen/Qwen3-Embedding-0.6B" for x in models)
        llm = next(x for x in models if x["id"] != "Qwen/Qwen3-Embedding-0.6B")
        assert llm["supported_reasoning_efforts"]
        results["models_and_capabilities"] = True
        payload = {
            "model": llm["id"],
            "messages": [
                {"role": "developer", "content": "Reply only with OK."},
                {"role": "user", "content": "Confirm receipt."},
            ],
            "max_tokens": 64,
            "reasoning_effort": "low",
            "chat_template_kwargs": {"enable_thinking": False},
        }
        r = c.post(api + "/chat/completions", headers=account, json=payload)
        r.raise_for_status()
        answer = r.json()
        assert answer["choices"]
        results["account_llm"] = {
            "status": r.status_code,
            "usage": answer.get("usage"),
            "request_id": r.headers.get("x-request-id"),
        }
        r = c.post(
            api + "/chat/completions",
            headers=key_header,
            json={**payload, "stream": True},
        )
        r.raise_for_status()
        assert "[DONE]" in r.text
        results["api_key_only_sse"] = True
        r = c.post(
            api + "/embeddings",
            headers=key_header,
            json={
                "model": "Qwen/Qwen3-Embedding-0.6B",
                "input": "知识整理",
                "dimensions": 64,
            },
        )
        r.raise_for_status()
        assert len(r.json()["data"][0]["embedding"]) == 64
        results["api_key_only_embedding"] = True
        with (ROOT / "models/paraformer/example/asr_example.wav").open("rb") as f:
            r = c.post(
                "https://api.sunlingzhang.com/v1/audio/transcriptions",
                headers={"Authorization": "Bearer " + key},
                files={"file": ("sample.wav", f, "audio/wav")},
            )
        r.raise_for_status()
        assert r.json().get("text")
        results["api_key_only_asr"] = True
        r = c.post(
            "https://api.sunlingzhang.com/v1/audio/speech",
            headers=key_header,
            json={"input": "你好。"},
        )
        r.raise_for_status()
        assert len(r.content) > 44
        results["api_key_only_tts"] = True
        for path, payload in [
            ("/v1/models", None),
            ("/v1/embeddings", {"input": "本机访问", "dimensions": 64}),
            ("/v1/chat/completions", payload),
        ]:
            r = (
                c.get("http://127.0.0.1:18901" + path)
                if payload is None
                else c.post("http://127.0.0.1:18901" + path, json=payload)
            )
            r.raise_for_status()
        results["local_unauthenticated_models_embedding_llm"] = True
        r = c.get("http://127.0.0.1:18901/admin/users")
        assert r.status_code == 401
        results["local_admin_still_authenticated"] = True

        async def ws_ready():
            for url, headers in [
                ("ws://127.0.0.1:18901/ws/asr", {}),
                ("wss://api.sunlingzhang.com/ws/asr", key_header),
            ]:
                async with websockets.connect(
                    url, extra_headers=headers, open_timeout=30
                ) as ws:
                    event = json.loads(await asyncio.wait_for(ws.recv(), 30))
                    assert event["type"] == "ready"

        asyncio.run(ws_ready())
        results["local_and_key_only_public_websocket"] = True
        usage = store.usage(uid)["requests"]
        assert any(
            r["prompt_tokens"] > 0
            and r["completion_tokens"] > 0
            and r["auth_type"] == "access_token"
            for r in usage
        )
        assert any(
            r["prompt_tokens"] > 0
            and r["completion_tokens"] > 0
            and r["auth_type"] == "api_key"
            for r in usage
        )
        results["unified_usage_records"] = True
        r = c.post(portal + "/auth/logout", json={"refresh_token": refresh})
        r.raise_for_status()
        assert c.get(api + "/models", headers=account).status_code == 401
        assert c.get(api + "/models", headers=key_header).status_code == 200
        results["logout_keeps_independent_key"] = True
        store.revoke_key(manager["id"], kid, admin=True)
        assert c.get(api + "/models", headers=key_header).status_code == 401
        results["key_revocation"] = True
        with socket.socket() as s:
            assert s.connect_ex(("127.0.0.1", 2233)) != 0
        results["legacy_gateway_stopped"] = True
        assert (
            c.post(
                api + "/audio/transcriptions/vibevoice", headers=key_header
            ).status_code
            == 404
        )
        results["vibevoice_not_public_even_with_key"] = True
        for host in ["asr.sunlingzhang.com", "tts.sunlingzhang.com"]:
            try:
                old = c.get("https://" + host + "/healthz")
                assert old.status_code == 404
            except httpx.ConnectError:
                pass
        assert (
            c.get("https://api.sunlingzhang.com/auth/registration-info").status_code
            == 404
        )
        assert c.get("https://api.sunlingzhang.com/").status_code == 404
        results["removed_voice_hosts_and_api_account_routes_rejected"] = True
    (ROOT / "artifacts/single-domain-live.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2) + "\n"
    )
    print(json.dumps(results, ensure_ascii=False, indent=2))
finally:
    if uid is not None:
        store.update_user(primary["id"], uid, {"enabled": False})
    store.update_user(primary["id"], manager["id"], {"enabled": False})
    store.db.close()
