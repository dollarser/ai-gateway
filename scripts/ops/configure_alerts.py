"""Install a private generic HTTPS alert webhook as Worker secrets; never echo values."""

import argparse
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config", type=Path, required=True, help="private JSON: url, optional secret"
    )
    args = parser.parse_args()
    os.umask(0o077)
    args.config.chmod(0o600)
    info = json.loads(args.config.read_text())
    if set(info) - {"url", "secret"} or not isinstance(info.get("url"), str):
        raise SystemExit("Expected url and optional secret")
    url = urlsplit(info["url"])
    if (
        url.scheme != "https"
        or not url.hostname
        or url.username
        or url.password
        or url.fragment
        or url.hostname in {"localhost", "127.0.0.1"}
        or url.hostname.endswith((".localhost", ".local", ".internal"))
        or ":" in url.hostname
        or all(c.isdigit() or c == "." for c in url.hostname)
    ):
        raise SystemExit("Webhook must be a public HTTPS endpoint")
    if "secret" in info and (
        not isinstance(info["secret"], str) or len(info["secret"]) < 16
    ):
        raise SystemExit("Signing secret must contain at least 16 characters")
    env = os.environ.copy()
    node = Path.home() / ".local/tools/node/bin"
    if node.exists():
        env["PATH"] = str(node) + os.pathsep + env.get("PATH", "")
    values = {"ALERT_WEBHOOK_URL": info["url"]}
    if "secret" in info:
        values["ALERT_WEBHOOK_SECRET"] = info["secret"]
    for key, value in values.items():
        subprocess.run(
            [str(ROOT / "cloudflare/node_modules/.bin/wrangler"), "secret", "put", key],
            cwd=ROOT / "cloudflare",
            input=value + "\n",
            text=True,
            check=True,
            env=env,
        )
    print(
        "Webhook secrets installed. No notification has been sent; use the administrator test button."
    )


if __name__ == "__main__":
    main()
