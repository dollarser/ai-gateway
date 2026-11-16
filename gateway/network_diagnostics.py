"""Authenticated metadata receiver for synthetic same-zone Worker subrequests."""

import hashlib
import hmac
import ipaddress
import re
import time
from fastapi import APIRouter, Request
from gateway.errors import Denied

router = APIRouter()
_seen = {}
PATH = "/__diagnostics/network"


def signature(secret, timestamp, nonce):
    value = f"diag-v1\n{timestamp}\n{nonce}\nGET\n{PATH}"
    return hmac.new(secret.encode(), value.encode(), hashlib.sha256).hexdigest()


@router.get(PATH)
async def observe(request: Request):
    settings = request.app.state.settings
    peer = request.scope.get("client")
    if not settings.edge_only or not peer:
        raise Denied(401, "诊断接收端需要服务认证")
    try:
        if not ipaddress.ip_address(peer[0]).is_loopback:
            raise ValueError("not local tunnel")
    except ValueError:
        raise Denied(401, "诊断接收端需要服务认证") from None
    stamp = request.headers.get("x-diagnostic-time", "")
    nonce = request.headers.get("x-diagnostic-nonce", "")
    supplied = request.headers.get("x-diagnostic-signature", "")
    secret = settings.accounts_worker_secret
    if (
        not secret
        or not re.fullmatch(r"\d{10,12}", stamp)
        or not re.fullmatch(r"[a-f0-9]{48}", nonce)
        or abs(time.time() - int(stamp)) > 60
        or not hmac.compare_digest(signature(secret, stamp, nonce), supplied)
    ):
        raise Denied(401, "诊断签名无效或已过期")
    for key, expiry in list(_seen.items()):
        if expiry < time.time():
            del _seen[key]
    if nonce in _seen:
        raise Denied(409, "诊断请求不可重放")
    if len(_seen) >= 1024:
        raise Denied(429, "诊断接收端繁忙")
    _seen[nonce] = time.time() + 120
    headers = {}
    for key in ("cf-connecting-ip", "cf-connecting-ipv6", "x-real-ip"):
        value = request.headers.get(key)
        if value:
            try:
                headers[key] = str(ipaddress.ip_address(value))
            except ValueError:
                headers[key] = "invalid"
    for key, pattern in (
        ("cf-ipcountry", r"[A-Z0-9]{2}"),
        ("cf-ray", r"[a-zA-Z0-9-]{1,128}"),
        ("cf-worker", r"[a-zA-Z0-9.-]{1,253}"),
    ):
        value = request.headers.get(key)
        if value and re.fullmatch(pattern, value):
            headers[key] = value
    # Do not copy arbitrary headers, URLs, request bodies or credentials into output.
    return {
        "schema": "network-reference-v1",
        "scope": "same_zone_tunnel",
        "observed_at": int(time.time()),
        "transport_peer": "local_tunnel",
        "observes_worker_tcp_source": False,
        "headers": headers,
        "sensitive_headers_present": {
            key: key in request.headers
            for key in ("authorization", "cookie", "x-api-key", "x-client-id")
        },
    }
