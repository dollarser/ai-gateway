"""Account session and administrator dependencies."""

import hmac
from fastapi import Depends, Request
from accounts.store import Denied
from accounts.auth import bearer

COOKIE = "__Host-ai_session"


def store(request: Request):
    return request.app.state.store


def session(request: Request, db=Depends(store)):
    if request.headers.get("authorization"):
        raw = bearer(request.headers)
        if not raw.startswith("ai-at-"):
            raise Denied(401, "账号管理需要登录 access_token，不能使用 API Key")
        return db.access_user(raw)
    user, csrf = db.session(request.cookies.get(COOKIE, ""))
    if request.method not in {"GET", "HEAD"} and not hmac.compare_digest(
        request.headers.get("x-csrf-token", "").encode(), csrf.encode()
    ):
        raise Denied(403, "CSRF 校验失败，请刷新页面")
    return user


def admin(user=Depends(session)):
    if user["role"] != "admin" or user["must_change"]:
        raise Denied(403, "需要管理员权限；首次登录请先修改密码")
    return user
