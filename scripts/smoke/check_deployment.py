"""Non-provisioning deployment checks: never creates accounts, keys or model requests."""

import argparse
import os
from urllib.parse import urlsplit
import httpx


def origin(value):
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.path.strip("/")
        or parsed.query
        or parsed.fragment
        or parsed.username
    ):
        raise ValueError("Expected an HTTP(S) origin")
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1"}:
        raise ValueError("Remote deployment checks require HTTPS")
    return value.rstrip("/")


def check(client, accounts_url, api_url, api_key=None):
    accounts_url, api_url = origin(accounts_url), origin(api_url)
    accounts = client.get(accounts_url + "/healthz")
    if accounts.status_code != 200 or accounts.json().get("storage") != "d1":
        raise RuntimeError("Account service is not a healthy D1 deployment")
    gateway = client.get(api_url + "/healthz")
    if (
        gateway.status_code != 200
        or gateway.json().get("service") != "inference-gateway"
    ):
        raise RuntimeError("API gateway health check failed")
    if client.get(api_url + "/v1/models").status_code != 401:
        raise RuntimeError("Unauthenticated model discovery did not return 401")
    if (
        client.post(
            accounts_url + "/internal/check-auth", json={"ip": "192.0.2.1"}
        ).status_code
        != 401
    ):
        raise RuntimeError(
            "Worker internal endpoint did not reject an unauthenticated request"
        )
    result = {
        "accounts": "ready",
        "gateway": "ready",
        "authentication": "enforced",
        "internal_authentication": "enforced",
    }
    if api_key is not None:
        response = client.get(
            api_url + "/v1/models", headers={"Authorization": "Bearer " + api_key}
        )
        if response.status_code != 200 or not isinstance(
            response.json().get("data"), list
        ):
            raise RuntimeError(
                f"Authenticated model discovery failed (HTTP {response.status_code}); check model backends"
            )
        result["models"] = "ready"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accounts-url", default="https://accounts.hilex.me")
    parser.add_argument("--api-url", default="https://api.hilex.me")
    parser.add_argument(
        "--require-models",
        action="store_true",
        help="Also require AI_API_KEY and working model backends",
    )
    args = parser.parse_args()
    key = os.environ.get("AI_API_KEY") if args.require_models else None
    if args.require_models and not key:
        parser.error("Set AI_API_KEY in the environment, never on the command line")
    try:
        with httpx.Client(timeout=15, trust_env=False) as client:
            result = check(client, args.accounts_url, args.api_url, key)
    except (httpx.HTTPError, RuntimeError, ValueError) as exc:
        raise SystemExit(str(exc))
    for name, status in result.items():
        print(f"{name}: {status}")


if __name__ == "__main__":
    main()
