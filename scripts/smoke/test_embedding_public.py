"""Verify real Cloudflare embedding endpoint with a disposable account; no secrets saved."""

import json
import secrets
import subprocess
import sys
import time
import math
from pathlib import Path
import httpx

ROOT = Path(__file__).resolve().parents[2]
portal = "https://accounts.sunlingzhang.com"
base = "https://api.sunlingzhang.com/v1"
cid = json.loads((ROOT / "deploy/client_ids.json").read_text())[0]
username = f"embedding-smoke-{int(time.time())}@example.com"
password = secrets.token_urlsafe(24)
created = False
results = {"endpoint": base + "/embeddings"}
try:
    with httpx.Client(
        trust_env=False, timeout=90, headers={"User-Agent": "embedding-client/1.0"}
    ) as c:
        r = c.post(
            portal + "/auth/register", json={"email": username, "password": password}
        )
        r.raise_for_status()
        created = True
        r = c.post(
            portal + "/auth/login", json={"username": username, "password": password}
        )
        r.raise_for_status()
        token = r.json()["access_token"]
        refresh = r.json()["refresh_token"]
        c.cookies.clear()
        payload = {
            "model": "Qwen/Qwen3-Embedding-0.6B",
            "input": ["课程知识整理", "课程内容归纳"],
            "dimensions": 256,
        }
        for name, headers in [
            ("missing", {}),
            ("client_only", {"X-Client-ID": cid}),
            ("token_only", {"Authorization": "Bearer " + token}),
            (
                "wrong_client",
                {"Authorization": "Bearer " + token, "X-Client-ID": "invalid"},
            ),
            (
                "wrong_token",
                {"Authorization": "Bearer ai-at-invalid", "X-Client-ID": cid},
            ),
        ]:
            r = c.post(base + "/embeddings", json=payload, headers=headers)
            assert r.status_code == 401, (name, r.status_code)
            results[name] = r.status_code
        headers = {"Authorization": "Bearer " + token, "X-Client-ID": cid}
        started = time.monotonic()
        r = c.post(base + "/embeddings", json=payload, headers=headers)
        r.raise_for_status()
        body = r.json()
        assert len(body["data"]) == 2 and len(body["data"][0]["embedding"]) == 256
        norm = math.sqrt(sum(x * x for x in body["data"][0]["embedding"]))
        assert abs(norm - 1) < 1e-5
        results["embedding"] = {
            "status": r.status_code,
            "items": len(body["data"]),
            "dimensions": 256,
            "unit_norm": True,
            "seconds": round(time.monotonic() - started, 4),
            "usage": body["usage"],
        }
        r = c.get(base + "/models", headers=headers)
        r.raise_for_status()
        ids = [m["id"] for m in r.json()["data"]]
        assert "Qwen/Qwen3-Embedding-0.6B" in ids
        results["catalog_contains_embedding"] = True
        r = c.get(portal + "/account/usage", headers=headers)
        r.raise_for_status()
        rows = [x for x in r.json()["requests"] if x["path"] == "/v1/embeddings"]
        assert any(x["service"] == "qwen" and x["status"] == 200 for x in rows)
        results["qwen_quota_accounted"] = True
        r = c.post(portal + "/auth/logout", json={"refresh_token": refresh})
        r.raise_for_status()
        assert (
            c.post(base + "/embeddings", json=payload, headers=headers).status_code
            == 401
        )
        results["logout_revoked"] = True
    (ROOT / "artifacts/embedding-public.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2) + "\n"
    )
    print(json.dumps(results, ensure_ascii=False, indent=2))
finally:
    if created:
        subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/ops/accounts-admin.py"),
                "disable-user",
                "--username",
                username,
            ],
            check=True,
        )
