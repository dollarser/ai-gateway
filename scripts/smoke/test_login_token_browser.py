"""Public self-registration smoke; no email is sent and no secrets enter artifacts."""

import json
import os
import secrets
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
email = "login-smoke-" + str(int(time.time())) + "@example.com"
password = secrets.token_urlsafe(24)
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 1280, "height": 960})
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("https://accounts.hilex.me/", wait_until="networkidle")
    page.locator("#show-register").click()
    expect(page.locator("#register")).to_be_visible()
    expect(page.locator("#registration-quotas")).to_contain_text("默认额度")
    page.locator("#register-form input[name=email]").fill(email)
    page.locator("#register-form input[name=password]").fill(password)
    page.locator("#register-form input[name=confirm_password]").fill(password)
    page.screenshot(
        path=str(ROOT / "artifacts/login-token-registration.png"),
        full_page=True,
        mask=[
            page.locator("#register-form input[name=email]"),
            page.locator("#register-form input[name=password]"),
            page.locator("#register-form input[name=confirm_password]"),
        ],
    )
    page.locator("#register-form button").click()
    expect(page.locator("#login")).to_be_visible()
    expect(page.locator("#message")).to_contain_text("注册成功")
    expect(page.locator("#login-form input[name=username]")).to_have_value(email)
    page.locator("#login-form input[name=password]").fill(password)
    page.locator("#login-form button").click()
    expect(page.locator("#workspace")).to_be_visible()
    expect(page.locator("#home-panel")).to_be_visible()
    expect(page.locator("#admin-tab")).to_be_hidden()
    expect(page.locator("#keys-tab")).to_be_hidden()
    expect(page.locator("#account-access-summary")).to_contain_text("LLM")
    expect(page.locator("#account-access-summary")).to_contain_text("ASR")
    expect(page.locator("#account-access-summary")).to_contain_text("TTS")
    me = page.request.get("https://accounts.hilex.me/account/me").json()
    blocked = page.request.post(
        "https://accounts.hilex.me/account/keys",
        data={"name": "must-not-create", "services": ["asr"]},
        headers={"X-CSRF-Token": me["csrf"]},
    )
    assert blocked.status == 403
    assert (
        page.request.get("https://accounts.hilex.me/account/keys").status == 403
    )
    page.screenshot(
        path=str(ROOT / "artifacts/login-token-portal.png"),
        full_page=True,
        mask=[page.locator("#identity")],
    )
    page.locator("#logout").click()
    expect(page.locator("#login")).to_be_visible()
    browser.close()
assert not errors, errors
path = ROOT / "accounts/data/login-smoke.json"
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as file:
    json.dump({"username": email, "password": password}, file)
(ROOT / "artifacts/login-token-browser.json").write_text(
    json.dumps(
        {
            "self_registration": True,
            "email_login": True,
            "all_three_services_available": True,
            "ordinary_user_api_key_configuration_denied": True,
            "administrator_approval_required": False,
            "page_errors": errors,
        },
        indent=2,
    )
)
print(
    "Browser registration and login passed; ordinary user sees direct access and cannot manage API keys"
)
