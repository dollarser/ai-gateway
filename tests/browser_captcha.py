"""Synthetic Turnstile UI/Android bridge tests; no real challenge or mail request."""

import sys
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playwright.sync_api import sync_playwright, expect
from scripts.ops.build_assets import CSP, build

ROOT = Path(__file__).resolve().parents[1]
assets = build()
calls = []
MOCK = """window.turnstile={render(container,options){const button=document.createElement('button');button.id='mock-solve';button.textContent='Local test verification';button.onclick=()=>options.callback('mock-token-'+options.action);container.append(button);return 'mock-widget';},remove(){}};"""


def handle(route):
    url = urlsplit(route.request.url)
    path = url.path
    if url.hostname == "challenges.cloudflare.com":
        return route.fulfill(body=MOCK, content_type="text/javascript")
    if path == "/account/me":
        return route.fulfill(status=401, json={"detail": "请重新登录"})
    if path == "/auth/captcha-info":
        return route.fulfill(
            json={
                "enabled": True,
                "provider": "turnstile",
                "site_key": "local-test-key",
                "actions": [
                    "registration_code",
                    "password_reset_code",
                    "email_binding_code",
                ],
            }
        )
    if path == "/auth/password-reset/code":
        calls.append(route.request.post_data_json)
        assert calls[-1]["captcha_token"] == "mock-token-password_reset_code"
        return route.fulfill(
            json={"message": "request accepted", "expires_in": 600, "retry_after": 60}
        )
    file = assets / (
        "index.html"
        if path == "/"
        else "captcha.html"
        if path == "/auth/captcha"
        else path.lstrip("/")
    )
    assert file.is_file(), path
    return route.fulfill(
        path=str(file),
        headers={"Content-Security-Policy": CSP} if file.suffix == ".html" else {},
        content_type="text/html"
        if file.suffix == ".html"
        else "text/javascript"
        if file.suffix == ".js"
        else "text/css",
    )


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    page = browser.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("**/*", handle)
    page.goto("https://accounts.test/")
    page.locator("#show-password-reset").click()
    page.locator("#password-reset-form [name=email]").fill("owner@example.net")
    page.locator("#send-password-reset-code").click()
    expect(page.locator("#captcha-dialog")).to_be_visible()
    assert calls == []
    page.locator("#captcha-cancel").click()
    expect(page.locator("#captcha-dialog")).to_be_hidden()
    expect(page.locator("#send-password-reset-code")).to_be_enabled()
    assert calls == []
    page.locator("#send-password-reset-code").click()
    expect(page.locator("#mock-solve")).to_be_visible()
    page.locator("#mock-solve").click()
    expect(page.locator("#message")).to_have_text("request accepted")
    assert len(calls) == 1
    page.add_init_script(
        "window.nativeMessages=[];window.HelixCaptcha={postMessage(value){window.nativeMessages.push(JSON.parse(value));}};"
    )
    page.goto("https://accounts.test/auth/captcha?action=password_reset_code")
    page.locator("#captcha-page-start").click()
    page.locator("#mock-solve").click()
    page.wait_for_function("window.nativeMessages.length===1")
    assert page.evaluate("window.nativeMessages[0]") == {
        "type": "captcha-completed",
        "action": "password_reset_code",
        "token": "mock-token-password_reset_code",
    }
    page.goto("https://accounts.test/auth/captcha?action=evil")
    expect(page.locator("#captcha-page-start")).to_be_disabled()
    assert not errors, errors
    browser.close()
print(
    "PASS: verification required before mail, cancellation sends no mail, proof attached once, trusted hosted page returns action/token to Android bridge, invalid actions rejected"
)
