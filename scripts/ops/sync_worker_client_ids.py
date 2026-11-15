"""Copy the private local Client-ID allowlist to a Worker secret without printing it."""

import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def main():
    ids = json.loads((ROOT / "deploy/client_ids.json").read_text())
    if (
        not isinstance(ids, list)
        or not ids
        or any(
            not isinstance(v, str) or not v.isascii() or not v or len(v) > 256
            for v in ids
        )
    ):
        raise SystemExit("Invalid private Client-ID allowlist")
    env = os.environ.copy()
    node = Path.home() / ".local/tools/node/bin"
    if node.exists():
        env["PATH"] = str(node) + os.pathsep + env.get("PATH", "")
    subprocess.run(
        ["npx", "wrangler", "secret", "put", "INFERENCE_CLIENT_IDS"],
        input=json.dumps(ids) + "\n",
        text=True,
        cwd=ROOT / "cloudflare",
        env=env,
        check=True,
    )


if __name__ == "__main__":
    main()
