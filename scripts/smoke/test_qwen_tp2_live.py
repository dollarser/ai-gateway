"""Validate TP=2 Qwen, observed execution concurrency and retained 128K window."""

import asyncio
import json
import secrets
import time
from pathlib import Path
from datetime import datetime, timezone
import httpx
from accounts.store import Store

ROOT = Path(__file__).resolve().parents[2]


def metric_values(text, name):
    return [
        float(line.rsplit(" ", 1)[1])
        for line in text.splitlines()
        if line.startswith("sglang:" + name + "{")
    ]


async def validate(key):
    result = {"verified_at_utc": datetime.now(timezone.utc).isoformat()}
    async with httpx.AsyncClient(
        trust_env=False, timeout=300, limits=httpx.Limits(max_connections=12)
    ) as client:
        info = (await client.get("http://127.0.0.1:30007/server_info")).json()
        args = info.get("server_args", info)
        for name in ["tp_size", "max_running_requests", "context_length"]:
            result[name] = args.get(name)
        assert result["tp_size"] == 2, result
        assert result["max_running_requests"] == 4, result
        assert result["context_length"] == 131072, result
        result["kv_cache_total_tokens"] = info.get("max_total_num_tokens")
        for port in [30007, 30008, 18901]:
            response = await client.get(f"http://127.0.0.1:{port}/v1/models")
            response.raise_for_status()
            model = next(m for m in response.json()["data"] if m["id"] == "Qwen3.8-27B")
            assert model["max_model_len"] == 131072
        headers = {"Authorization": "Bearer " + key}
        done = asyncio.Event()
        samples = []

        async def monitor():
            while not done.is_set():
                response = await client.get(
                    "http://127.0.0.1:30007/metrics", timeout=10
                )
                response.raise_for_status()
                running = max(metric_values(response.text, "num_running_reqs") or [0])
                queued = max(metric_values(response.text, "num_queue_reqs") or [0])
                samples.append({"running": running, "queued": queued})
                await asyncio.sleep(0.1)

        async def request(index):
            payload = {
                "model": "Qwen3.8-27B",
                "messages": [
                    {
                        "role": "user",
                        "content": f"Synthetic capacity test {index}. "
                        + ("alpha beta gamma delta " * 16)
                        + "\nIgnore the filler. Write the numbers from 1 to 1000, one per line, without commentary.",
                    }
                ],
                "max_tokens": 1024,
                "temperature": 0,
                "chat_template_kwargs": {"enable_thinking": False},
            }
            started = time.monotonic()
            response = await client.post(
                "https://api.sunlingzhang.com/v1/chat/completions",
                headers=headers,
                json=payload,
            )
            entry = {
                "status": response.status_code,
                "seconds": round(time.monotonic() - started, 3),
            }
            if response.status_code == 200:
                body = response.json()
                entry.update(
                    {
                        "usage": body.get("usage"),
                        "finish_reason": body["choices"][0].get("finish_reason"),
                    }
                )
            return entry

        monitoring = asyncio.create_task(monitor())
        started = time.monotonic()
        try:
            result["parallel_requests"] = await asyncio.gather(
                *(request(i) for i in range(4))
            )
        finally:
            done.set()
            await monitoring
        result["parallel_wall_seconds"] = round(time.monotonic() - started, 3)
        result["observed_peak_running_requests"] = max(s["running"] for s in samples)
        result["metrics_samples"] = len(samples)
        assert all(r["status"] == 200 for r in result["parallel_requests"]), result
        assert result["observed_peak_running_requests"] == 4, result
        print(
            "Four public requests passed; backend peak running requests = 4", flush=True
        )
        payload = {
            "model": "Qwen3.8-27B",
            "messages": [
                {
                    "role": "user",
                    "content": ("alpha beta gamma delta " * 32000)
                    + "\nEnd of filler. Reply with exactly OK.",
                }
            ],
            "max_tokens": 16,
            "temperature": 0,
            "chat_template_kwargs": {"enable_thinking": False},
        }
        started = time.monotonic()
        response = await client.post(
            "http://127.0.0.1:18901/v1/chat/completions", json=payload
        )
        response.raise_for_status()
        body = response.json()
        assert 120000 <= body["usage"]["prompt_tokens"] < 131072
        result["long_request"] = {
            "status": response.status_code,
            "usage": body["usage"],
            "seconds": round(time.monotonic() - started, 3),
            "finish_reason": body["choices"][0].get("finish_reason"),
        }
    return result


def main():
    store = Store(ROOT / "accounts/data/accounts.db", recover_leases=False)
    admin = next(u for u in store.users() if u["username"] == "admin" and u["enabled"])
    user = store.create_user(
        "tp2-smoke-" + str(int(time.time())),
        secrets.token_urlsafe(32),
        services=["qwen"],
        rpm=0,
        daily_requests=0,
        concurrency=4,
        must_change=False,
        actor=admin["id"],
    )
    kid = None
    try:
        key, kid = store.create_key(
            user["id"], "tp2-validation", ["qwen"], 1, actor=admin["id"]
        )
        result = asyncio.run(validate(key))
        (ROOT / "artifacts/qwen-tp2-validation.json").write_text(
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
