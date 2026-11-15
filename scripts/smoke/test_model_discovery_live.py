"""Validate deployed model discovery; ephemeral credentials stay in memory."""

import json
import secrets
import time
from pathlib import Path
import httpx
from accounts.store import Store

ROOT = Path(__file__).resolve().parents[2]


def main():
    store = Store(ROOT / "accounts/data/accounts.db", recover_leases=False)
    admin = next(u for u in store.users() if u["username"] == "admin" and u["enabled"])
    password = secrets.token_urlsafe(32)
    user = store.create_user(
        "catalog-smoke-" + str(int(time.time())),
        password,
        services=["qwen"],
        must_change=False,
    )
    kid = None
    result = {}
    try:
        key, kid = store.create_key(
            user["id"], "model-discovery-smoke", ["qwen"], 1, actor=admin["id"]
        )
        with httpx.Client(trust_env=False, timeout=30) as client:
            url = "https://api.hilex.me/v1/models"
            headers = {"X-API-Key": key}
            assert client.get(url + "?output_modalities=all").status_code == 401
            complete = client.get(url + "?output_modalities=all", headers=headers)
            complete.raise_for_status()
            models = complete.json()["data"]
            assert len(models) == 2
            direct_chat = client.get("http://127.0.0.1:30007/v1/models").json()["data"]
            direct_embed = client.get("http://127.0.0.1:18771/v1/models").json()["data"]
            assert {m["id"] for m in models} == {
                m["id"] for m in direct_chat + direct_embed
            }
            for suffix, expected in [
                ("", ["text"]),
                ("?output_modalities=embeddings", ["embeddings"]),
                ("?output_modalities=text,embeddings", ["text", "embeddings"]),
                ("?output_modalities=rerank", []),
            ]:
                response = client.get(url + suffix, headers=headers)
                response.raise_for_status()
                assert [
                    m["architecture"]["output_modalities"][0]
                    for m in response.json()["data"]
                ] == expected
            assert all("capabilities" not in model for model in models)
            assert "supported_reasoning_efforts" not in next(
                m
                for m in models
                if "embeddings" in m["architecture"]["output_modalities"]
            )
            assert (
                client.get(url + "?output_modalities=chat", headers=headers).status_code
                == 400
            )
            local = client.get("http://127.0.0.1:18901/v1/models?output_modalities=all")
            local.raise_for_status()
            assert [(m["id"], m["architecture"]) for m in local.json()["data"]] == [
                (m["id"], m["architecture"]) for m in models
            ]
            login = client.post(
                "https://accounts.hilex.me/auth/login",
                json={"username": user["username"], "password": password},
            )
            login.raise_for_status()
            tokens = login.json()
            account = {
                "Authorization": "Bearer " + tokens["access_token"],
                "X-Client-ID": json.loads(
                    (ROOT / "deploy/client_ids.json").read_text()
                )[0],
            }
            assert (
                client.get(url + "?output_modalities=all", headers=account).status_code
                == 200
            )
            client.post(
                "https://accounts.hilex.me/auth/logout",
                json={"refresh_token": tokens["refresh_token"]},
            ).raise_for_status()
            result = {
                "public_key_only": True,
                "public_account_and_client_id": True,
                "local_unauthenticated": True,
                "ids_from_actual_backends": True,
                "filters_and_invalid_values": True,
                "models": [
                    {"id": m["id"], "architecture": m["architecture"]} for m in models
                ],
            }
        (ROOT / "artifacts/model-discovery-live.json").write_text(
            json.dumps(result, indent=2) + "\n"
        )
        print(json.dumps(result, indent=2))
    finally:
        if kid is not None:
            store.revoke_key(admin["id"], kid, admin=True)
        store.update_user(admin["id"], user["id"], {"enabled": False})
        store.db.close()


if __name__ == "__main__":
    main()
