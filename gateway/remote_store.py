"""Account/lease adapter for the Cloudflare Worker; never falls back to SQLite."""

import httpx
from urllib.parse import urlsplit
from gateway.errors import Denied


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
            result = response.json()
            if not isinstance(result, dict):
                raise ValueError("Invalid account service response")
            if response.status_code >= 400:
                detail = result.get("detail", "账号服务暂时不可用")
                if not isinstance(detail, str):
                    detail = "账号服务暂时不可用"
                raise Denied(
                    response.status_code
                    if response.status_code in {400, 401, 403, 404, 409, 422, 429}
                    else 503,
                    detail,
                )
            if operation == "acquire":
                value = result.get("lease")
                if not isinstance(value, str) or not value or len(value) > 128:
                    raise ValueError("Missing account lease")
            elif operation == "token-remaining":
                if "remaining" not in result:
                    raise ValueError("Missing token allowance")
                value = result["remaining"]
                if value is not None and (type(value) is not int or value < 0):
                    raise ValueError("Invalid token allowance")
            elif result.get("ok") is not True:
                raise ValueError("Missing account service acknowledgment")
            return result
        except (httpx.HTTPError, ValueError) as exc:
            raise Denied(503, "账号服务暂时不可用") from exc

    def acquire(self, raw, service, path):
        return self.call("acquire", raw=raw, service=service, path=path)["lease"]

    def acquire_with_metadata(self, raw, service, path, metadata):
        return self.call(
            "acquire", raw=raw, service=service, path=path, metadata=metadata
        )["lease"]

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
