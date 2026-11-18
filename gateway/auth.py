"""Remote account-token+Client-ID or API-key-only; local trust is listener-based."""

from gateway.credentials import bearer
import hmac
import ipaddress
from gateway.errors import Denied

from gateway.settings import settings

LOCAL_PORT = settings.local_port


def is_local_listener(scope):
    server = scope.get("server")
    peer = scope.get("client")
    if not server or server[1] != LOCAL_PORT or not peer:
        return False
    try:
        return ipaddress.ip_address(peer[0]).is_loopback
    except ValueError:
        return False


def _authorize_inference(app, headers, service, path, protocols=(), scope=None):
    raw = bearer(headers, protocols)
    api = headers.get("x-api-key", "").strip()
    if api and raw and not hmac.compare_digest(api.encode(), raw.encode()):
        raise Denied(401, "不能同时提供不同的 Authorization 和 X-API-Key")
    raw = raw or api
    if raw.startswith("ai-at-"):
        if api:
            raise Denied(401, "X-API-Key 仅接受 API Key；登录令牌请使用 Authorization")
        supplied = headers.get("x-client-id", "").strip()
        if not supplied:
            supplied = next(
                (
                    p[len("client-id.") :]
                    for p in protocols
                    if p.startswith("client-id.")
                ),
                "",
            )
        if not supplied or not any(
            hmac.compare_digest(supplied.encode(), value)
            for value in app.state.allowed_client_ids
        ):
            raise Denied(401, "账号调用必须同时提供有效的 X-Client-ID")
    elif not raw.startswith(("sk-acct-", "sk-qw-")):
        raise Denied(401, "需要账号 Bearer access_token + X-Client-ID，或 API Key")
    if hasattr(app.state.store, "acquire_with_metadata"):
        lease = app.state.store.acquire_with_metadata(
            raw, service, path, inference_metadata(scope, headers)
        )
    else:
        lease = app.state.store.acquire(raw, service, path)
    return lease, {"X-Client-ID": app.state.backend_id}


def source_ip(scope, headers):
    peer = (scope or {}).get("client")
    if not peer:
        return None
    try:
        ip = ipaddress.ip_address(peer[0])
        # Forwarded identity is trusted only from the local tunnel origin listener.
        if (
            ip.is_loopback
            and (scope.get("server") or (None, None))[1] == settings.public_port
        ):
            forwarded = headers.get("cf-connecting-ip", "")
            if forwarded:
                return str(ipaddress.ip_address(forwarded))
        return str(ip)
    except ValueError:
        return None


def authorize_inference(app, headers, service, path, protocols=(), scope=None):
    if getattr(
        getattr(app.state, "settings", None), "edge_only", False
    ) and not is_local_listener(scope or {}):
        from gateway.edge_origin import edge_grant

        return edge_grant(app, headers, scope)
    ip = source_ip(scope, headers)
    if ip:
        app.state.store.check_inference_auth(ip)
    try:
        return _authorize_inference(app, headers, service, path, protocols, scope)
    except Denied as exc:
        if ip and exc.status == 401:
            app.state.store.record_inference_auth_failure(ip)
        raise


def inference_metadata(scope, headers):
    """Only trust Cloudflare IP on a loopback tunnel connection; ignore XFF."""
    ip = source_ip(scope, headers)
    if ip and ipaddress.ip_address(ip).is_loopback:
        ip = None
    return {
        "client_ip": ip,
        "user_agent": headers.get("user-agent", "")[:512],
        "client_version": headers.get("x-client-version", "")[:128],
        "device_id": headers.get("x-device-id", "")[:128],
    }
