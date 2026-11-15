"""Account/lease adapter for the Cloudflare Worker; never falls back to SQLite."""

import httpx
from urllib.parse import urlsplit
from accounts.store import Denied


class RemoteStore:
    def __init__(self, url, secret, transport=None):
        parsed = urlsplit(url)
        if parsed.scheme != "https" and not (
            parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"}
        ):
            raise ValueError(
                "Account Worker URL must use HTTPS (localhost HTTP is allowed for development)"
            )
        if (
            not parsed.hostname
            or parsed.path.strip("/")
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("Account Worker URL must be an origin")
        if not secret or len(secret) < 32:
            raise ValueError(
                "ACCOUNTS_WORKER_SECRET must contain at least 32 characters"
            )
        self.client = httpx.Client(
            base_url=url.rstrip("/"),
            headers={"Authorization": "Bearer " + secret},
            timeout=httpx.Timeout(10, connect=3),
            trust_env=False,
            transport=transport,
        )

    def call(self, operation, **body):
        try:
            response = self.client.post("/internal/" + operation, json=body)
            if response.status_code >= 400:
                detail = response.json().get("detail", "账号服务暂时不可用")
                raise Denied(
                    response.status_code
                    if response.status_code in {400, 401, 403, 404, 409, 422, 429}
                    else 503,
                    detail,
                )
            return response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise Denied(503, "账号服务暂时不可用") from exc

    def acquire(self, raw, service, path):
        return self.call("acquire", raw=raw, service=service, path=path)["lease"]

    def token_remaining(self, lease):
        return self.call("token-remaining", lease=lease)["remaining"]

    def finish(
        self, lease, status, size=0, prompt_tokens=0, completion_tokens=0, trace=None
    ):
        self.call(
            "finish",
            lease=lease,
            status=status,
            size=size,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            trace=trace or {},
        )

    def check_inference_auth(self, ip):
        self.call("check-auth", ip=ip)

    def record_inference_auth_failure(self, ip):
        self.call("record-auth-failure", ip=ip)

    def close(self):
        self.client.close()
