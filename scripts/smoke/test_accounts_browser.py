"""Browser login/key/usage/logout smoke check, no plaintext secrets in artifacts."""

import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
creds = json.loads((ROOT / "accounts/data/smoke-user.json").read_text())
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 1280, "height": 960})
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("https://accounts.hilex.me/", wait_until="networkidle")
    page.locator("#login-form input[name=username]").fill(creds["username"])
    page.locator("#login-form input[name=password]").fill(creds["password"])
    page.locator("#login-form button").click()
    page.locator("#workspace").wait_for(state="visible")
    page.locator("#key-form input[name=name]").fill("browser-smoke")
    page.locator("#key-form button").click()
    page.locator("#key-secret").wait_for(state="visible")
    assert page.locator("#key-value").inner_text().startswith("sk-acct-")
    page.locator("#dismiss-key").click()
    assert page.locator("#key-value").inner_text() == ""
    row = page.locator("#keys-list tr").filter(has_text="browser-smoke").first
    page.once("dialog", lambda dialog: dialog.accept())
    row.get_by_role("button", name="撤销").click()
    expect(row).to_contain_text("已撤销")
    page.locator("[data-tab=usage]").click()
    page.locator("#usage-totals").wait_for(state="visible")
    expect(page.locator("#usage-totals")).to_contain_text("今日用量")
    page.screenshot(path=str(ROOT / "artifacts/accounts-portal.png"), full_page=True)
    page.locator("#logout").click()
    page.locator("#login").wait_for(state="visible")
    browser.close()
assert not errors, errors
(ROOT / "artifacts/accounts-browser.json").write_text(
    json.dumps(
        {
            "login": True,
            "create_key": True,
            "secret_hidden_after_dismiss": True,
            "revoke_key": True,
            "usage": True,
            "logout": True,
            "page_errors": errors,
        },
        indent=2,
    )
)
print("Browser login, key creation/revocation, usage and logout passed")
