"""Browser regressions against synthetic data; all network requests intercepted."""

from pathlib import Path
import json
import urllib.parse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
defaults = dict(
    rpm=30,
    daily_requests=1000,
    concurrency=2,
    luna_monthly_tokens=10000000,
    openai_asr_daily_seconds=1800,
    openai_tts_daily_characters=500000,
)
users = [
    dict(
        id=i,
        username=name,
        role="admin" if i == 1 else "user",
        enabled=1,
        services=["qwen", "asr", "tts"],
        must_change=0,
        email_binding_required=True,
        email="admin@example.net" if i == 1 else None,
        last_request_ip="203.0.113.9",
        last_request_at=1794700000,
        day_requests=3,
        luna_used_tokens=1200,
        asr_used_ms=60000,
        tts_used_characters=100,
        **defaults,
    )
    for i, name in [(1, "admin"), (2, "demo")]
]
limits = {
    "cloud_enabled": True,
    "luna_monthly_usd": 200,
    "asr_daily_minutes": None,
    "tts_daily_characters": None,
}
policy = {"enabled": True, "ip_hourly": 5, "global_hourly": 100, "global_minute": 15}
alert_state = ["open"]
notification_enabled = [False]
notification_deliveries = []
site_notices = []
customer_notices = []
logged_in = [True]
mutations = []
errors = []
answers = []
ledger = {
    "kind": "audio",
    "lease": "test-lease",
    "username": "demo",
    "period": "2026-11-15",
    "settled": 0,
    "reserved_units": 3,
    "charged_units": 3,
    "request_id": "test-request",
    "response_id": "resp-test",
    "ended": 1,
    "adjustable_after": 2,
}


def handle(route):
    req = route.request
    path = urllib.parse.urlsplit(req.url).path
    if path == "/" or path.startswith("/static/"):
        file = (
            ROOT
            / "accounts/static"
            / ("index.html" if path == "/" else path.rsplit("/", 1)[1])
        )
        return route.fulfill(
            path=str(file),
            content_type="text/html"
            if path == "/"
            else "text/css"
            if path.endswith(".css")
            else "text/javascript",
        )

    def respond(body, status=200):
        route.fulfill(
            status=status, content_type="application/json", body=json.dumps(body)
        )

    data = req.post_data_json if req.method in ["POST", "PATCH"] else None
    if data is not None:
        mutations.append((path, data))
    if path == "/account/notices/unread-count":
        return respond(
            {
                "unread": sum(
                    n["state"] == "published" and not n.get("read_at")
                    for n in customer_notices
                )
            }
        )
    if path == "/account/notices/read":
        for n in customer_notices:
            if n["id"] in data["ids"]:
                n["read_at"] = 1794700100
        return respond({"ok": True})
    if path == "/account/notices":
        active = [n for n in customer_notices if n["state"] == "published"]
        unread = sum(not n.get("read_at") for n in active)
        state = urllib.parse.parse_qs(urllib.parse.urlsplit(req.url).query).get(
            "state", ["all"]
        )[0]
        return respond(
            {
                "items": [
                    n for n in active if state != "unread" or not n.get("read_at")
                ],
                "total": len(active),
                "unread": unread,
                "page": 1,
                "page_size": 30,
            }
        )
    if path == "/admin/notices":
        if req.method == "POST":
            n = dict(
                data,
                id="f" * 48,
                state="draft",
                version=1,
                published_at=1794700000,
                read_at=None,
            )
            customer_notices.append(n)
            return respond({"id": n["id"], "version": 1, "state": "draft"})
        return respond(
            {
                "items": customer_notices,
                "total": len(customer_notices),
                "page": 1,
                "page_size": 30,
            }
        )
    if path.startswith("/admin/notices/"):
        n = customer_notices[0]
        if path.endswith("/publish"):
            n["state"] = "published"
        elif path.endswith("/withdraw"):
            n["state"] = "withdrawn"
        else:
            n.update(data)
        n["version"] += 1
        return respond({"id": n["id"], "version": n["version"], "state": n["state"]})
    if path == "/account/email/code":
        return respond(
            {"message": "绑定验证码已发送", "expires_in": 600, "retry_after": 60}
        )
    if path == "/account/email/bind":
        assert data["code"] == "123456"
        users[0]["email"] = data["email"]
        users[0]["email_verified_at"] = 1794700100
        users[0]["email_binding_required"] = False
        return respond(
            {"user": users[0], "message": "邮箱已验证并绑定，原登录名和密码保持不变"}
        )
    if path == "/account/me":
        if not logged_in[0]:
            return respond({"detail": "需要登录"}, 401)
        return respond({"user": users[0], "csrf": "test-csrf"})
    if path == "/auth/registration-info":
        return respond(
            {"today": "2026-11-15", "defaults": defaults, "email_verification": True}
        )
    if path == "/auth/registration-code":
        return respond(
            {
                "message": "验证码已发送，请检查邮箱",
                "retry_after": 60,
                "expires_in": 600,
            }
        )
    if path == "/auth/register":
        assert data["code"] == "123456"
        return respond({"message": "注册成功，请登录"}, 201)
    if path == "/admin/operations":
        return respond(
            {
                "limits": limits,
                "notifications": {
                    "configured": True,
                    "external_configured": notification_enabled[0],
                    "destination_url": "https://accounts.hilex.me/#alerts",
                    "destination_host": "alerts.example.test",
                    "deliveries": notification_deliveries,
                },
                "month": "2026-11",
                "luna": {"used_usd": 1.2, "reserved_usd": 0.1, "remaining_usd": 198.8},
                "registration": policy,
                "alerts": [
                    {
                        "kind": "provider_region_restricted",
                        "state": alert_state[0],
                        "last_seen": 1794700000,
                        "details": '{"count":2}',
                    }
                ],
            }
        )
    if path == "/admin/global-limits":
        limits.update(data)
        return respond({})
    if path == "/admin/registration-policy":
        policy.update(data)
        return respond(policy)
    if path == "/admin/alerts/acknowledge":
        alert_state[0] = "acknowledged"
        return respond({"ok": True})
    if path == "/admin/network-stats":
        return respond(
            {
                "summary": {"requests": 4, "successful": 2, "region_restricted": 2},
                "groups": [
                    {
                        "country": "JP",
                        "colo": "NRT",
                        "model": "gpt-6-luna",
                        "protocol": "http",
                        "requests": 2,
                        "provider_attempts": 2,
                        "successful": 2,
                        "failed": 0,
                        "inflight": 0,
                        "success_rate": 1,
                        "region_error_rate": 0,
                        "last_seen": 1794700000,
                    },
                    {
                        "country": "HK",
                        "colo": "LAX",
                        "model": "gpt-6-luna",
                        "protocol": "sse",
                        "requests": 2,
                        "provider_attempts": 2,
                        "successful": 0,
                        "failed": 2,
                        "inflight": 0,
                        "success_rate": 0,
                        "region_error_rate": 1,
                        "last_seen": 1794700001,
                    },
                ],
                "observations": [],
                "truncated": False,
            }
        )
    if path == "/admin/network-probe":
        return respond(
            {
                "result": {
                    "controlled": {
                        "scope": "same_zone_tunnel",
                        "observes_worker_tcp_source": False,
                        "status": "observed_metadata",
                    }
                }
            }
        )
    if path == "/admin/diagnostic-bundle":
        return respond(
            {
                "schema": "provider-diagnostic-v1",
                "request": {"request_id": "test-request", "model": "gpt-6-luna"},
                "limitations": ["reference only"],
            }
        )
    if path == "/admin/notifications":
        state = urllib.parse.parse_qs(urllib.parse.urlsplit(req.url).query).get(
            "state", ["all"]
        )[0]
        unread = sum(n["read_at"] is None for n in site_notices)
        return respond(
            {
                "total": len(site_notices),
                "unread": unread,
                "page": 1,
                "page_size": 30,
                "items": [
                    n for n in site_notices if state != "unread" or n["read_at"] is None
                ],
            }
        )
    if path == "/admin/notifications/read":
        for notice in site_notices:
            if notice["id"] in data["ids"]:
                notice["read_at"] = 1794700000
        return respond({"ok": True})
    if path == "/admin/notifications/test":
        notification_deliveries.append(
            {"status": "sent", "kind": "test", "channel": "in_app"}
        )
        site_notices.append(
            {
                "id": "test-site-message",
                "kind": "test",
                "state": "open",
                "created": 1794700000,
                "read_at": None,
                "payload": {"details": {}, "kind": "test"},
            }
        )
        return respond({"id": "test-delivery"})
    if path == "/admin/requests":
        return respond(
            [
                {
                    "request_id": "test-request",
                    "failure_stage": "validation",
                    "error_code": "invalid_audio_model",
                }
            ]
        )
    if path == "/admin/quota-review":
        return respond([ledger])
    if path == "/admin/quota-adjustments":
        assert data["expected_units"] == ledger["charged_units"]
        ledger["charged_units"] = data["units"]
        ledger["settled"] = 1
        return respond({"ok": True})
    if path == "/admin/quota-defaults":
        if data:
            defaults.update(data)
        return respond(defaults)
    if path == "/admin/overview":
        return respond(
            {
                "summary": {
                    "users": {"total": 2},
                    "enabled_users": sum(u["enabled"] for u in users),
                    "total": 6,
                    "failed": 1,
                    "inflight": 0,
                    "asr_ms": 60000,
                    "tts_characters": 100,
                },
                "users": users,
                "matching": 2,
            }
        )
    if path == "/admin/users/bulk":
        for u in users:
            if u["id"] in data["ids"]:
                u.update(data["patch"])
        return respond({"ok": True, "updated": len(data["ids"])})
    if path.endswith("/details"):
        return respond(
            {
                "user": users[1],
                "audio": {"asr": {"remaining": 1740000}, "tts": {"remaining": 499900}},
                "ips": [
                    {"client_ip": "203.0.113.9", "requests": 3, "last_seen": 1794700000}
                ],
                "requests": [
                    {
                        "id": "req",
                        "started": 1794700000,
                        "service": "tts",
                        "path": "/v1/audio/speech",
                        "status": 200,
                        "luna_tokens": None,
                        "audio_kind": "tts",
                        "audio_units": 100,
                        "client_ip": "203.0.113.9",
                        "client_version": "1.2.3",
                        "device_id": "device-a",
                        "user_agent": "demo <script>alert(1)</script>",
                        "request_id": "request-id",
                    }
                ],
            }
        )
    if path.startswith("/admin/users/") and req.method == "PATCH":
        u = next(u for u in users if str(u["id"]) == path.rsplit("/", 1)[1])
        u.update(data)
        return respond(u)
    if path == "/admin/users" and req.method == "POST":
        return respond(
            {
                "user": dict(username=data["username"]),
                "temporary_password": "temporary-test",
                "message": "created",
            }
        )
    if path == "/admin/audit":
        return respond([{"action": "test"}])
    raise RuntimeError("Unexpected browser API path " + path)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on(
        "dialog",
        lambda d: d.accept(answers.pop(0)) if d.type == "prompt" else d.accept(),
    )
    page.route("https://accounts.test/**", handle)
    page.goto("https://accounts.test")
    page.locator("#users-list tr").nth(1).wait_for()
    assert page.locator("#admin-summary>div").count() == 6
    page.locator("#users-list tr").nth(1).get_by_role(
        "button", name="设置", exact=True
    ).click()
    page.locator("#edit-form [name=openai_tts_daily_characters]").fill("250000")
    page.locator(
        "#edit-form button[type=submit],#edit-form button:not([type])"
    ).first.click()
    page.wait_for_timeout(100)
    assert any(
        path == "/admin/users/2" and b["openai_tts_daily_characters"] == 250000
        for path, b in mutations
    )
    page.locator("#select-page").check()
    page.locator("#bulk-disable").click()
    page.wait_for_timeout(100)
    assert all(u["enabled"] == 0 for u in users)
    page.locator("#select-page").check()
    page.locator("#bulk-enable").click()
    page.wait_for_timeout(100)
    assert all(u["enabled"] == 1 for u in users)
    page.locator("#users-list tr").nth(1).get_by_role(
        "button", name="详情", exact=True
    ).click()
    page.locator("#details-requests").get_by_text("203.0.113.9", exact=True).wait_for()
    assert "<script>alert(1)</script>" in page.locator("#details-requests").inner_text()
    page.locator("#quota-defaults>summary").click()
    page.locator("#quota-defaults-form [name=openai_tts_daily_characters]").fill(
        "400000"
    )
    page.locator("#quota-defaults-form button").click()
    page.wait_for_timeout(100)
    assert defaults["openai_tts_daily_characters"] == 400000
    page.locator("#select-page").check()
    page.locator("#bulk-defaults").click()
    page.wait_for_timeout(100)
    assert all(u["openai_tts_daily_characters"] == 400000 for u in users)
    page.locator("#create-user>summary").click()
    page.locator("#user-form [name=username]").fill("browser-test")
    page.locator("#user-form button").click()
    page.locator("#user-secret").wait_for(state="visible")
    assert "temporary-test" in page.locator("#user-secret").inner_text()
    page.locator("#request-search>summary").click()
    page.locator("#request-search-form [name=request_id]").fill("test-request")
    page.locator("#request-search-form button").click()
    page.locator("#request-search-result").get_by_text(
        "invalid_audio_model", exact=False
    ).wait_for()
    page.locator("#quota-review>summary").click()
    page.locator("#quota-review-filter button").click()
    page.locator("#quota-review-list button").wait_for()
    answers.extend(["1", "verified provider test"])
    page.locator("#quota-review-list button").click()
    page.wait_for_timeout(100)
    assert ledger["charged_units"] == 1 and ledger["settled"] == 1
    page.locator("#operations-panel>summary").click()
    page.locator("#global-limits-form [name=luna_monthly_usd]").fill("200")
    page.locator("#global-limits-form button").click()
    page.wait_for_timeout(100)
    assert limits["luna_monthly_usd"] == 200 and limits["asr_daily_minutes"] is None
    page.locator("#registration-policy-form [name=global_minute]").fill("12")
    page.locator("#registration-policy-form button").click()
    page.wait_for_timeout(100)
    assert policy["global_minute"] == 12
    page.locator("#operational-alerts button").click()
    page.wait_for_timeout(100)
    assert alert_state[0] == "acknowledged"
    assert not page.locator("#test-notification").is_disabled()
    page.locator("#network-panel>summary").click()
    page.locator("#network-stats-form button").click()
    page.locator("#network-groups tr").nth(1).wait_for()
    assert (
        "JP / NRT" in page.locator("#network-groups").inner_text()
        and "HK / LAX" in page.locator("#network-groups").inner_text()
    )
    page.locator("#run-network-probe").click()
    page.locator("#network-probe-result").get_by_text(
        "same_zone_tunnel", exact=False
    ).wait_for()
    with page.expect_download() as download:
        page.locator("#download-diagnostic").click()
    artifact = ROOT / "artifacts/provider-diagnostic-test.json"
    artifact.parent.mkdir(exist_ok=True)
    download.value.save_as(artifact)
    assert json.loads(artifact.read_text())["schema"] == "provider-diagnostic-v1"
    notification_enabled[0] = True
    page.locator("#load-operations").click()
    page.wait_for_timeout(100)
    page.locator("#test-notification").click()
    page.wait_for_timeout(100)
    assert notification_deliveries and notification_deliveries[0]["status"] == "sent"
    page.locator("#alerts-tab").click()
    page.locator("#inbox-list article").wait_for()
    assert (
        page.url.endswith("#alerts")
        and "未读 1 条" in page.locator("#inbox-summary").inner_text()
    )
    page.locator("#inbox-list button").click()
    page.wait_for_timeout(100)
    assert "未读 0 条" in page.locator("#inbox-summary").inner_text()
    page.reload()
    page.locator("#alerts-panel").wait_for(state="visible")
    assert "未读 0 条" in page.locator("#inbox-summary").inner_text()
    page.locator('[data-tab="notices"]').click()
    page.locator("#notices-panel").wait_for(state="visible")
    page.locator("#notice-management>summary").click()
    page.locator("#notice-form [name=title]").fill("通告 <img src=x onerror=alert(1)>")
    page.locator("#notice-form [name=body]").fill("第一行\n<script>alert(1)</script>")
    page.locator("#notice-form button").first.click()
    page.locator("#notice-admin-items button").filter(has_text="发布").click()
    page.locator("#notice-items article").wait_for()
    assert "未读 1" in page.locator("#notice-summary").inner_text()
    assert page.locator("#notice-items script,#notice-items img").count() == 0
    page.locator("#notice-items button").click()
    page.wait_for_timeout(100)
    assert "未读 0" in page.locator("#notice-summary").inner_text()
    page.reload()
    page.locator("#notices-panel").wait_for(state="visible")
    page.locator("#notice-items article").wait_for()
    assert "已读" in page.locator("#notice-items").inner_text()
    page.locator("#notice-management>summary").click()
    page.locator("#notice-admin-items button").filter(has_text="撤回").click()
    page.get_by_text("暂无通告", exact=True).wait_for()
    users[0]["role"] = "user"
    customer_notices[0]["state"] = "published"
    page.reload()
    page.locator("#notices-panel").wait_for(state="visible")
    page.locator("#notice-items article").wait_for()
    assert page.locator("#notice-management").is_hidden()
    assert page.locator("#admin-tab").is_hidden()
    users[0]["role"] = "admin"
    page.reload()
    page.locator("#notices-panel").wait_for(state="visible")
    assert not errors, errors
    (ROOT / "artifacts").mkdir(exist_ok=True)
    page.screenshot(path=str(ROOT / "artifacts/admin-desktop.png"), full_page=True)
    page.set_viewport_size({"width": 390, "height": 844})
    page.screenshot(path=str(ROOT / "artifacts/admin-mobile.png"), full_page=True)
    assert page.evaluate("document.documentElement.scrollWidth") <= 390
    print(
        "Browser: settings, bulk ban/unban, bulk quotas, user creation, IP/details, safe rendering and mobile layout passed"
    )
    page.locator("#email-binding-reminder").wait_for(state="visible")
    page.locator("#open-email-binding").click()
    assert (
        page.locator("#email-binding-form [name=email]").input_value()
        == "admin@example.net"
    )
    page.locator("#defer-email-binding").click()
    assert page.locator("#email-binding-form").is_hidden()
    assert page.locator("#email-binding-reminder").is_visible()
    page.locator("#open-email-binding").click()
    page.locator("#send-binding-code").click()
    page.get_by_text("绑定验证码已发送", exact=True).wait_for()
    assert page.locator("#send-binding-code").is_disabled()
    page.locator("#email-binding-form [name=code]").fill("123456")
    page.locator("#email-binding-form button").filter(has_text="验证并绑定").click()
    page.locator("#email-binding-reminder").wait_for(state="hidden")
    page.reload()
    page.locator("#notices-panel").wait_for(state="visible")
    assert page.locator("#email-binding-reminder").is_hidden()
    logged_in[0] = False
    page.goto("https://accounts.test/")
    page.locator("#show-register").click()
    page.locator("#registration-code-fields").wait_for(state="visible")
    page.locator("#register-form [name=email]").fill("synthetic@example.net")
    page.locator("#send-registration-code").click()
    page.get_by_text("验证码已发送，请检查邮箱", exact=True).wait_for()
    assert page.locator("#send-registration-code").is_disabled()
    page.locator("#register-form [name=code]").fill("123456")
    page.locator("#register-form [name=password]").fill("test-password")
    page.locator("#register-form [name=confirm_password]").fill("test-password")
    page.locator("#register-form button").filter(has_text="注册账号").click()
    page.get_by_text("注册成功，请登录", exact=True).wait_for()
    assert any(
        path == "/auth/register" and b.get("code") == "123456" for path, b in mutations
    )
    assert not errors, errors
    browser.close()
