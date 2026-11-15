"""Verify public-origin failure throttling and metadata without persisting test credentials."""

import json
import secrets
import time
from pathlib import Path
import httpx
from accounts.store import Store, digest

ROOT = Path(__file__).resolve().parents[2]


def main():
    store = Store(ROOT / "accounts/data/accounts.db", recover_leases=False)
    admin = next(u for u in store.users() if u["username"] == "admin" and u["enabled"])
    user = store.create_user(
        "gateway-protection-smoke-" + str(int(time.time())),
        secrets.token_urlsafe(32),
        must_change=False,
    )
    key = kid = None
    ip = "198.51.100.231"
    results = {}
    try:
        key, kid = store.create_key(
            user["id"], "retirement-smoke", ["qwen"], 1, actor=admin["id"]
        )
        with httpx.Client(trust_env=False, timeout=30) as client:
            headers = {"Host": "api.hilex.me", "CF-Connecting-IP": ip}
            for _ in range(60):
                r = client.get("http://127.0.0.1:18900/v1/models", headers=headers)
                assert r.status_code == 401
                assert r.headers.get("x-request-id")
            r = client.get("http://127.0.0.1:18900/v1/models", headers=headers)
            assert r.status_code == 429 and r.headers.get("retry-after") == "60"
            results["failure_limit_60_then_429"] = True
            r = client.get("http://127.0.0.1:18901/v1/models")
            assert r.status_code == 200
            results["local_bypass_unaffected"] = True
            headers.update(
                {
                    "CF-Connecting-IP": "198.51.100.232",
                    "Authorization": "Bearer " + key,
                    "X-Request-ID": "retirement-client-1",
                    "X-Helix-Turn-ID": "retirement-turn-1",
                }
            )
            r = client.get("http://127.0.0.1:18900/v1/models", headers=headers)
            r.raise_for_status()
            row = store.db.execute(
                "SELECT client_request_id,helix_turn_id FROM requests WHERE request_id=?",
                (r.headers["x-request-id"],),
            ).fetchone()
            assert tuple(row) == ("retirement-client-1", "retirement-turn-1")
            results["correlation_ids_persisted"] = True
            r = client.post(
                "http://127.0.0.1:18900/v1/audio/speech", headers=headers, json={}
            )
            assert r.status_code == 403
            assert (
                store.db.execute(
                    "SELECT count(*) FROM inference_auth_failures WHERE ip_hash=?",
                    (digest("198.51.100.232"),),
                ).fetchone()[0]
                == 0
            )
            results["permission_failure_not_counted"] = True
        (ROOT / "artifacts/gateway-retirement-protections-live.json").write_text(
            json.dumps(results, indent=2) + "\n"
        )
        print(json.dumps(results))
    finally:
        if kid is not None:
            store.revoke_key(admin["id"], kid, admin=True)
        store.update_user(admin["id"], user["id"], {"enabled": False})
        with store.transaction() as db:
            db.execute(
                "DELETE FROM inference_auth_failures WHERE ip_hash IN (?,?)",
                (digest(ip), digest("198.51.100.232")),
            )
        store.db.close()


if __name__ == "__main__":
    main()
