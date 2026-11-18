"""Synthetic password recovery browser flow; intercept all traffic, send no mail."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.ops.build_assets import build
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
assets = build()
calls = []


def respond(route):
    path = route.request.url.split("accounts.test", 1)[-1]
    if path == "/auth/captcha-info":
        return route.fulfill(json={"enabled": False})
    if path == "/account/me":
        return route.fulfill(status=401, json={"detail": "请重新登录"})
    if path == "/auth/password-reset/code":
        calls.append((path, route.request.post_data_json))
        return route.fulfill(
            json={
                "message": "若邮箱已验证，将收到重置验证码",
                "retry_after": 60,
                "expires_in": 600,
            }
        )
    if path == "/auth/password":
        calls.append((path, route.request.post_data_json))
        return route.fulfill(json={"ok": True, "message": "密码已修改，请重新登录"})
    if path == "/auth/password-reset":
        calls.append((path, route.request.post_data_json))
        return route.fulfill(
            json={
                "ok": True,
                "api_keys_revoked": route.request.post_data_json["revoke_api_keys"],
                "message": "密码已重置，请使用原登录名和新密码重新登录",
            }
        )
    file = assets / ("index.html" if path == "/" else path.lstrip("/"))
    if not file.is_file():
        raise AssertionError("Unexpected network request " + path)
    route.fulfill(
        path=str(file),
        content_type="text/html"
        if path == "/"
        else "text/javascript"
        if path.endswith(".js")
        else "text/css",
    )


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 1280, "height": 1000})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("**/*", respond)
    page.clock.install()
    page.goto("https://accounts.test/")
    page.locator("#login-form [name=email]").fill("owner@example.net")
    page.locator("#show-password-reset").click()
    form = page.locator("#password-reset-form")
    expect(page.locator("#password-reset")).to_be_visible()
    expect(form.locator("[name=email]")).to_have_value("owner@example.net")
    box = page.locator("#password-reset").bounding_box()
    assert abs(box["x"] + box["width"] / 2 - 640) < 3
    expect(page.locator(".client-download")).to_be_visible()
    expect(form.locator("[name=revoke_api_keys]")).not_to_be_checked()
    page.locator("#verify-password-reset").click()
    expect(page.locator("#send-password-reset-code")).to_be_enabled()
    page.locator("#send-password-reset-code").click()
    expect(page.locator("#send-password-reset-code")).to_be_disabled()
    expect(page.locator("#send-password-reset-code")).to_have_text("60 秒后重发")
    page.clock.run_for(61000)
    expect(page.locator("#send-password-reset-code")).to_be_disabled()
    form.locator("[name=code]").fill("012345")
    form.locator("[name=new_password]").fill("sixsix")
    form.locator("[name=confirm_password]").fill("mismatch")
    form.locator("button[type=submit],button:not([type])").click()
    expect(page.locator("#message")).to_contain_text("两次输入的密码不一致")
    assert len(calls) == 1
    form.locator("[name=confirm_password]").fill("sixsix")
    form.locator("summary").click()
    form.locator("[name=revoke_api_keys]").check()
    form.locator("button[type=submit],button:not([type])").click()
    expect(page.locator("#login")).to_be_visible()
    expect(page.locator("#password-reset")).to_be_hidden()
    expect(page.locator("#message")).to_contain_text("密码已重置")
    assert calls[-1][1] == {
        "email": "owner@example.net",
        "code": "012345",
        "new_password": "sixsix",
        "revoke_api_keys": True,
    }
    assert not errors, errors
    page.locator("#show-password-reset").click()
    expect(form.locator("[name=new_password]")).to_have_value("")
    expect(form.locator("[name=code]")).to_have_value("")
    page.locator("#reset-back-login").click()
    expect(page.locator("#login")).to_be_visible()
    out = ROOT / ".runtime/tests/browser/password-reset.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(out))
    page.locator("#show-password-reset").click()
    page.locator("#show-credential-password").click()
    credential = page.locator("#credential-password-form")
    expect(page.locator("#credential-password")).to_be_visible()
    credential.locator("[name=email]").fill("original-user@example.net")
    credential.locator("[name=current_password]").fill("old-pass")
    credential.locator("[name=new_password]").fill("new123")
    credential.locator("[name=confirm_password]").fill("new123")
    credential.locator("button").click()
    expect(page.locator("#login")).to_be_visible()
    assert calls[-1] == (
        "/auth/password",
        {
            "email": "original-user@example.net",
            "current_password": "old-pass",
            "new_password": "new123",
        },
    )
    assert not errors, errors
    browser.close()
print(
    "PASS: centered recovery form, download link, email/code request, cooldown, mismatch, six-character password, optional key revocation, return to login and secret clearing"
)
