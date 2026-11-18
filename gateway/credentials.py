"""Extract credentials from HTTP headers or WebSocket subprotocols."""


def bearer(headers, protocols=()):
    value = headers.get("authorization", "")
    if value.lower().startswith("bearer "):
        return value[7:].strip()
    for prefix in ["access-token.", "api-key."]:
        token = next((p[len(prefix) :] for p in protocols if p.startswith(prefix)), "")
        if token:
            return token
    return ""
