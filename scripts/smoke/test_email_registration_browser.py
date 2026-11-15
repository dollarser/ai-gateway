"""Public self-registration smoke; no email is sent and no secrets enter artifacts."""

import json
import os
import secrets
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
email = "registration-smoke-" + str(int(time.time())) + "@example.com"
password = secrets.token_urlsafe(24)
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 1280, "height": 960})
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("https://accounts.sunlingzhang.com/", wait_until="networkidle")
    page.locator("#show-register").click()
    expect(page.locator("#register")).to_be_visible()
    expect(page.locator("#registration-quotas")).to_contain_text("默认额度")
    page.locator("#register-form input[name=email]").fill(email)
    page.locator("#register-form input[name=password]").fill(password)
    page.locator("#register-form input[name=confirm_password]").fill(password)
    page.screenshot(
        path=str(ROOT / "artifacts/email-registration-form.png"),
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
    expect(page.locator("#keys-panel")).to_be_visible()
    expect(page.locator("#admin-tab")).to_be_hidden()
    for service in ["qwen", "asr", "tts"]:
        expect(
            page.locator("#key-services input[value=" + service + "]")
        ).to_be_enabled()
        expect(
            page.locator("#key-services input[value=" + service + "]")
        ).to_be_checked()
    page.locator("#key-form input[name=name]").fill("email-registration-browser")
    page.locator("#key-form button").click()
    expect(page.locator("#key-secret")).to_be_visible()
    assert page.locator("#key-value").inner_text().startswith("sk-acct-")
    page.locator("#dismiss-key").click()
    row = page.locator("#keys-list tr").filter(has_text="email-registration-browser")
    page.once("dialog", lambda dialog: dialog.accept())
    row.get_by_role("button", name="撤销").click()
    expect(row).to_contain_text("已撤销")
    page.locator("#logout").click()
    expect(page.locator("#login")).to_be_visible()
    browser.close()
assert not errors, errors
path = ROOT / "accounts/data/registration-smoke.json"
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as file:
    json.dump({"username": email, "password": password}, file)
(ROOT / "artifacts/email-registration-browser.json").write_text(
    json.dumps(
        {
            "self_registration": True,
            "email_login": True,
            "all_three_services_available": True,
            "create_and_revoke_api_key": True,
            "administrator_approval_required": False,
            "page_errors": errors,
        },
        indent=2,
    )
)
print(
    "Public browser email registration, login, three service permissions and API key lifecycle passed"
)
