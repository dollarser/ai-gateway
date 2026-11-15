"""Validate documented MTP deployment, real speculative decoding and four-way service."""

import asyncio
import json
import secrets
import time
from pathlib import Path
import httpx
from accounts.store import Store
from scripts.smoke.test_qwen_tp2_live import validate

ROOT = Path(__file__).resolve().parents[2]


def main():
    with httpx.Client(trust_env=False, timeout=20) as client:
        response = client.get("http://127.0.0.1:30007/server_info")
        response.raise_for_status()
        args = response.json()
        expected = {
            "speculative_algorithm": "EAGLE",
            "speculative_num_steps": 3,
            "speculative_eagle_topk": 1,
            "speculative_num_draft_tokens": 4,
            "tp_size": 2,
            "context_length": 131072,
            "max_running_requests": 4,
        }
        for name, value in expected.items():
            assert args.get(name) == value, (name, args.get(name))
        assert args["speculative_draft_model_path"] == args["model_path"]
    store = Store(ROOT / "accounts/data/accounts.db", recover_leases=False)
    admin = next(u for u in store.users() if u["username"] == "admin" and u["enabled"])
    user = store.create_user(
        "mtp-smoke-" + str(int(time.time())),
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
            user["id"], "mtp-validation", ["qwen"], 1, actor=admin["id"]
        )
        result = asyncio.run(validate(key))
        result["speculative_config"] = expected
        with httpx.Client(trust_env=False, timeout=20) as client:
            response = client.get("http://127.0.0.1:30007/metrics")
            response.raise_for_status()
            metrics = {}
            for line in response.text.splitlines():
                if line.startswith("sglang:") and any(
                    word in line.split("{")[0] for word in ["spec", "accept"]
                ):
                    name = line.split("{")[0].split(" ")[0]
                    try:
                        value = float(line.rsplit(" ", 1)[1])
                    except ValueError:
                        continue
                    metrics[name] = max(metrics.get(name, 0), value)
            result["speculative_metrics"] = metrics
        offset = int((ROOT / ".runtime/qwen-mtp-log-offset").read_text())
        with (ROOT / "logs/llm-backend-background.log").open("rb") as source:
            source.seek(offset)
            lines = source.read().decode(errors="replace").splitlines()
        result["startup_evidence"] = {
            "mtp_weights_loaded": any(
                "Load weight end" in line and "MTP" in line for line in lines
            ),
            "draft_decode_graph_captured": any(
                "Capture draft decode CUDA graph end" in line for line in lines
            ),
        }
        assert result["startup_evidence"]["mtp_weights_loaded"], (
            "No loaded MTP model evidence"
        )
        assert any(value > 0 for name, value in metrics.items() if "accept" in name), (
            "No speculative acceptance observed"
        )
        (ROOT / "artifacts/qwen-mtp-validation.json").write_text(
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
