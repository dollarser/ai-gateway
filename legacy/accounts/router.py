"""Account portal, authentication and administration routes."""

import asyncio
import secrets
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from gateway.credentials import bearer
from legacy.accounts.dependencies import COOKIE, store, session, admin
from legacy.accounts.schemas import (
    Login,
    Register,
    RegistrationDefaults,
    Refresh,
    NewPassword,
    NewUser,
    UpdateUser,
    NewKey,
)
from legacy.accounts.store import Denied, SERVICES

router = APIRouter()


def validate_services(values):
    if not set(values).issubset(SERVICES):
        raise Denied(400, "未知服务权限")


@router.post("/auth/login")
async def login(body: Login, request: Request, db=Depends(store)):
    ip = request.headers.get("cf-connecting-ip") or request.client.host
    raw, csrf, user = await asyncio.to_thread(
        db.login, body.username, body.password, ip
    )
    tokens = db.issue_login_tokens(raw)
    response = JSONResponse({"user": user, "csrf": csrf, **tokens})
    response.set_cookie(
        COOKIE,
        raw,
        secure=True,
        httponly=True,
        samesite="strict",
        max_age=43200,
        path="/",
    )
    return response


@router.post("/auth/refresh")
def refresh(body: Refresh, db=Depends(store)):
    return db.refresh(body.refresh_token)


@router.get("/auth/registration-info")
def registration_info(db=Depends(store)):
    return {
        "services": sorted(SERVICES),
        "defaults": db.registration_defaults(),
        "email_verification": False,
    }


@router.post("/auth/register", status_code=201)
async def register(body: Register, request: Request, db=Depends(store)):
    ip = request.headers.get("cf-connecting-ip") or request.client.host
    user = await asyncio.to_thread(db.register, str(body.email), body.password, ip)
    return {"user": user, "message": "注册成功，请使用邮箱和密码登录"}


@router.get("/admin/registration-defaults")
def registration_defaults(user=Depends(admin), db=Depends(store)):
    return db.registration_defaults()


@router.patch("/admin/registration-defaults")
def update_registration_defaults(
    body: RegistrationDefaults, user=Depends(admin), db=Depends(store)
):
    return db.update_registration_defaults(user["id"], body.model_dump())


@router.post("/auth/logout")
def logout(request: Request, body: Refresh | None = None, db=Depends(store)):
    if body is not None:
        db.logout_refresh(body.refresh_token)
    elif request.headers.get("authorization"):
        db.logout_access(bearer(request.headers))
    else:
        session(request, db)  # Cookie logout still requires CSRF protection.
        db.logout(request.cookies.get(COOKIE, ""))
    response = JSONResponse({"ok": True})
    response.delete_cookie(
        COOKIE, secure=True, httponly=True, samesite="strict", path="/"
    )
    return response


@router.get("/account/me")
def me(request: Request, user=Depends(session), db=Depends(store)):
    csrf = (
        None
        if request.headers.get("authorization")
        else db.session(request.cookies.get(COOKIE, ""))[1]
    )
    return {"user": user, "csrf": csrf}


@router.post("/account/password")
async def password(body: NewPassword, user=Depends(session), db=Depends(store)):
    await asyncio.to_thread(
        db.change_password, user["id"], body.current_password, body.new_password
    )
    return {"ok": True, "message": "密码已修改，请重新登录"}


@router.get("/account/keys")
def keys(user=Depends(admin), db=Depends(store)):
    return db.keys(user["id"])


@router.post("/account/keys")
def new_key(body: NewKey, user=Depends(admin), db=Depends(store)):
    validate_services(body.services)
    raw, kid = db.create_key(user["id"], body.name, body.services, body.days)
    return {"key": raw, "id": kid, "message": "密钥仅显示一次，请立即保存"}


@router.delete("/account/keys/{kid}")
def revoke_key(kid: int, user=Depends(admin), db=Depends(store)):
    db.revoke_key(user["id"], kid)
    return {"ok": True}


@router.get("/account/usage")
def usage(user=Depends(session), db=Depends(store)):
    return db.usage(user["id"])


@router.get("/admin/users")
def users(user=Depends(admin), db=Depends(store)):
    return db.users()


@router.post("/admin/users")
async def create_user(body: NewUser, user=Depends(admin), db=Depends(store)):
    validate_services(body.services)
    temporary = secrets.token_urlsafe(18)
    record = await asyncio.to_thread(
        db.create_user, password=temporary, actor=user["id"], **body.model_dump()
    )
    return {
        "user": record,
        "temporary_password": temporary,
        "message": "首次登录必须修改密码",
    }


@router.patch("/admin/users/{uid}")
def update_user(uid: int, body: UpdateUser, user=Depends(admin), db=Depends(store)):
    changes = body.model_dump(exclude_none=True)
    if "services" in changes:
        validate_services(changes["services"])
    return db.update_user(user["id"], uid, changes)


@router.post("/admin/users/{uid}/reset-password")
async def reset(uid: int, user=Depends(admin), db=Depends(store)):
    value = await asyncio.to_thread(db.reset_password, user["id"], uid)
    return {
        "temporary_password": value,
        "message": "该账号的登录会话和所有 API Key 已撤销",
    }


@router.get("/admin/keys/{uid}")
def admin_keys(uid: int, user=Depends(admin), db=Depends(store)):
    return db.keys(uid)


@router.post("/admin/keys/{uid}")
def admin_create_key(uid: int, body: NewKey, user=Depends(admin), db=Depends(store)):
    validate_services(body.services)
    raw, kid = db.create_key(uid, body.name, body.services, body.days, actor=user["id"])
    return {"key": raw, "id": kid, "message": "密钥仅显示一次，请立即保存"}


@router.delete("/admin/keys/{kid}")
def admin_revoke(kid: int, user=Depends(admin), db=Depends(store)):
    db.revoke_key(user["id"], kid, admin=True)
    return {"ok": True}


@router.get("/admin/audit")
def admin_audit(user=Depends(admin), db=Depends(store)):
    with db.lock:
        return [
            dict(row)
            for row in db.db.execute("SELECT * FROM audit ORDER BY id DESC LIMIT 100")
        ]


@router.get("/admin/usage")
def admin_usage(user_id: int | None = None, user=Depends(admin), db=Depends(store)):
    return db.usage(user_id)
