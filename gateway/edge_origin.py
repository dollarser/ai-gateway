"""Protected origin services called by the edge Worker, never a public API."""

import hmac
import ipaddress
import re
from accounts.store import Denied
from gateway.tracking import safe_id


def trusted_edge(app, headers, scope):
    config = getattr(app.state, "settings", None)
    if not config or not config.edge_only:
        return False
    peer = (scope or {}).get("client")
    if not peer:
        return False
    try:
        if not ipaddress.ip_address(peer[0]).is_loopback:
            return False
    except ValueError:
        return False
    supplied = headers.get("x-edge-secret", "")
    return bool(
        config.accounts_worker_secret
        and supplied
        and hmac.compare_digest(supplied, config.accounts_worker_secret)
    )


def edge_grant(app, headers, scope):
    if not trusted_edge(app, headers, scope):
        raise Denied(401, "模型源站仅接受已认证的边缘 Worker 请求")
    lease = headers.get("x-edge-lease", "")
    if not re.fullmatch(r"[a-f0-9]{48}", lease):
        raise Denied(401, "缺少有效的边缘请求凭证")
    return lease, {"X-Client-ID": app.state.backend_id}


def edge_request_id(app, headers, scope):
    return (
        safe_id(headers.get("x-edge-request-id"))
        if trusted_edge(app, headers, scope)
        else None
    )
