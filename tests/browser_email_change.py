"""Email change browser gate: synthetic proof/mail only; no production traffic."""

import sys
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import sync_playwright, expect
from scripts.ops.build_assets import build

ROOT = Path(__file__).resolve().parents[1]
ASSETS = build()
calls = []
logged_in = [True]
USER = dict(
    id=501,
    display_name="同名用户",
    email="old@example.net",
    email_verified_at=1,
    email_binding_required=False,
    services=["qwen"],
    daily_requests=100,
    rpm=30,
    concurrency=2,
    must_change=0,
)
MOCK = """window.renders=0;window.turnstile={render(container,o){window.renders++;const b=document.createElement('button');b.id='mock-solve';b.textContent='Verify';b.onclick=()=>o.callback('change-proof-'+window.renders);container.append(b);return 'mock';},remove(){}};"""


def handle(route):
    url = urlsplit(route.request.url)
    path = url.path
    if url.hostname == "challenges.cloudflare.com":
        return route.fulfill(body=MOCK, content_type="text/javascript")
    if path == "/account/me":
        return (
            route.fulfill(json={"user": USER, "csrf": "test-csrf"})
            if logged_in[0]
            else route.fulfill(status=401, json={"detail": "请登录"})
        )
    if path == "/account/usage-snapshot":
        return route.fulfill(
            json={"usage": {"today": "2026-11-19", "totals": [], "requests": []}}
        )
    if path == "/account/notices/unread-count":
        return route.fulfill(json={"unread": 0})
    if path == "/auth/captcha-info":
        return route.fulfill(
            json={
                "enabled": True,
                "site_key": "test",
                "actions": [
                    "registration_code",
                    "password_reset_code",
                    "email_binding_code",
                    "email_change_code",
                ],
            }
        )
    if path == "/account/email/change/code":
        body = route.request.post_data_json
        calls.append((path, body))
        assert body["captcha_token"].startswith("change-proof-")
        if body["current_password"] != "current-pass":
            return route.fulfill(status=403, json={"detail": "当前密码错误"})
        return route.fulfill(
            json={
                "message": "换绑验证码已发送至新邮箱",
                "retry_after": 60,
                "expires_in": 600,
            }
        )
    if path == "/account/email/change":
        body = route.request.post_data_json
        calls.append((path, body))
        assert set(body) == {"email", "code"}
        if body["code"] != "123456":
            return route.fulfill(status=400, json={"detail": "验证码无效"})
        logged_in[0] = False
        return route.fulfill(
            json={
                "ok": True,
                "email": body["email"],
                "api_keys_revoked": False,
                "message": "邮箱已更新，请使用新邮箱重新登录",
            }
        )
    file = ASSETS / ("index.html" if path == "/" else path.lstrip("/"))
    assert file.is_file(), path
    return route.fulfill(
        path=str(file),
        content_type="text/html"
        if file.suffix == ".html"
        else "text/javascript"
        if file.suffix == ".js"
        else "text/css",
    )


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 390, "height": 844})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("**/*", handle)
    page.clock.install()
    page.goto("https://accounts.test/")
    page.locator('[data-tab="profile"]').click()
    page.locator("#open-email-change").click()
    form = page.locator("#email-change-form")
    verify = page.locator("#verify-email-change")
    send = page.locator("#send-email-change-code")
    form.locator("[name=email]").fill("new@example.net")
    verify.click()
    expect(page.locator("#captcha-dialog")).to_be_hidden()
    assert calls == []
    form.locator("[name=current_password]").fill("current-pass")
    verify.click()
    page.locator("#mock-solve").click()
    expect(send).to_be_enabled()
    assert calls == []
    page.locator("#cancel-email-change").click()
    page.locator("#open-email-change").click()
    expect(send).to_be_disabled()
    expect(form.locator("[name=current_password]")).to_have_value("")
    form.locator("[name=email]").fill("new@example.net")
    form.locator("[name=current_password]").fill("wrong-pass")
    verify.click()
    page.locator("#mock-solve").click()
    send.click()
    expect(page.locator("#message")).to_have_text("当前密码错误")
    expect(send).to_be_disabled()
    expect(form.locator("[name=current_password]")).to_have_value("")
    form.locator("[name=current_password]").fill("current-pass")
    verify.click()
    page.locator("#mock-solve").click()
    expect(send).to_be_enabled()
    assert len(calls) == 1
    send.click()
    expect(page.locator("#message")).to_have_text("换绑验证码已发送至新邮箱")
    expect(form.locator("[name=current_password]")).to_have_value("")
    expect(send).to_be_disabled()
    assert len(calls) == 2
    form.locator("[name=code]").fill("999999")
    form.locator("button:not([type])").click()
    expect(page.locator("#message")).to_have_text("验证码无效")
    expect(form).to_be_visible()
    form.locator("[name=code]").fill("123456")
    assert page.evaluate("document.documentElement.scrollWidth") <= 390
    out = ROOT / ".runtime/tests/browser/email-change-390.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(out), full_page=True)
    form.locator("button:not([type])").click()
    expect(page.locator("#login")).to_be_visible()
    expect(page.locator("#workspace")).to_be_hidden()
    expect(page.locator("#login-form [name=email]")).to_have_value("new@example.net")
    assert page.evaluate(
        "Array.from(document.querySelectorAll('input[type=password]')).every(e=>e.value==='')"
    )
    assert not errors, errors
    browser.close()
print(
    "PASS: independent human proof/manual send, password cleared, cancel/failure invalidate proof, code errors preserve flow, success returns to email login and clears secrets"
)
