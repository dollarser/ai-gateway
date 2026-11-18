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
account = None
fail_send = False
MOCK = """window.mockRenders=[];window.mockRemoved=0;window.turnstile={render(container,options){window.mockOptions=options;window.mockRenders.push({size:options.size,width:container.clientWidth,action:options.action,retry:options.retry,expired:options['refresh-expired'],timeout:options['refresh-timeout']});const widget=document.createElement('div');widget.style.width=options.size==='compact'?'150px':'100%';widget.style.minWidth=options.size==='compact'?'150px':'300px';widget.style.height=options.size==='compact'?'140px':'65px';widget.id='mock-widget';const button=document.createElement('button');button.id='mock-solve';button.textContent='Local test verification';button.onclick=()=>options.callback('mock-token-'+options.action);widget.append(button);container.append(widget);return 'mock-widget';},remove(){window.mockRemoved++;}};"""


def handle(route):
    url = urlsplit(route.request.url)
    path = url.path
    if url.hostname == "challenges.cloudflare.com":
        return route.fulfill(body=MOCK, content_type="text/javascript")
    if path == "/account/me":
        return (
            route.fulfill(json={"user": account, "csrf": "test-csrf"})
            if account
            else route.fulfill(status=401, json={"detail": "请重新登录"})
        )
    if path == "/account/usage-snapshot":
        return route.fulfill(
            json={"usage": {"today": "2026-11-18", "totals": [], "requests": []}}
        )
    if path == "/account/notices/unread-count":
        return route.fulfill(json={"unread": 0})
    if path == "/auth/registration-info":
        return route.fulfill(
            json={
                "registration_enabled": True,
                "email_verification": True,
                "defaults": {"daily_requests": 100},
            }
        )
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
    if path in {
        "/auth/password-reset/code",
        "/auth/registration-code",
        "/account/email/code",
    }:
        calls.append(route.request.post_data_json)
        action = {
            "/auth/password-reset/code": "password_reset_code",
            "/auth/registration-code": "registration_code",
            "/account/email/code": "email_binding_code",
        }[path]
        assert calls[-1]["captcha_token"] == "mock-token-" + action
        if fail_send:
            return route.fulfill(
                status=400, json={"detail": "模拟发送失败，需重新验证"}
            )
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
    page.locator("#verify-password-reset").click()
    expect(page.locator("#captcha-dialog")).to_be_visible()
    assert calls == []
    page.locator("#captcha-cancel").click()
    expect(page.locator("#captcha-dialog")).to_be_hidden()
    expect(page.locator("#send-password-reset-code")).to_be_disabled()
    assert calls == []
    page.locator("#verify-password-reset").click()
    expect(page.locator("#mock-solve")).to_be_visible()
    page.locator("#mock-solve").click()
    expect(page.locator("#send-password-reset-code")).to_be_enabled()
    assert calls == []
    page.locator("#send-password-reset-code").click()
    expect(page.locator("#message")).to_have_text("request accepted")
    assert len(calls) == 1
    for purpose, opener, form_id in (
        ("registration", "show-register", "register-form"),
        ("password-reset", "show-password-reset", "password-reset-form"),
        ("binding", "open-email-binding", "email-binding-form"),
    ):
        account = (
            {
                "id": 7,
                "display_name": "owner@example.net",
                "role": "user",
                "services": ["qwen"],
                "daily_requests": 100,
                "rpm": 30,
                "concurrency": 2,
                "must_change": 0,
                "email_binding_required": True,
            }
            if purpose == "binding"
            else None
        )
        flow = browser.new_page()
        flow.route("**/*", handle)
        flow.on("pageerror", lambda error: errors.append(str(error)))
        flow.clock.install()
        flow.goto("https://accounts.test/")
        flow.locator("#" + opener).click()
        form = flow.locator("#" + form_id)
        form.locator("[name=email]").fill("owner@example.net")
        verify = flow.locator("#verify-" + purpose)
        send = flow.locator("#send-" + purpose + "-code")
        before = len(calls)
        expect(send).to_be_disabled()

        def solve():
            verify.click()
            expect(flow.locator("#mock-solve")).to_be_visible()
            flow.locator("#mock-solve").click()
            expect(send).to_be_enabled()

        solve()
        assert len(calls) == before
        form.locator("[name=email]").fill("changed@example.net")
        expect(send).to_be_disabled()
        solve()
        flow.clock.fast_forward(240001)
        expect(send).to_be_disabled()
        solve()
        # Re-verification discards the previous proof even if cancelled.
        verify.click()
        flow.locator("#captcha-cancel").click()
        expect(send).to_be_disabled()
        solve()
        if purpose == "binding":
            flow.locator("#defer-email-binding").click()
        elif purpose == "registration":
            flow.locator("#show-login").click()
        else:
            flow.locator("#reset-back-login").click()
        flow.locator("#" + opener).click()
        expect(send).to_be_disabled()
        form.locator("[name=email]").fill("retry@example.net")
        solve()
        fail_send = True
        send.click()
        expect(flow.locator("#message")).to_contain_text("模拟发送失败")
        expect(send).to_be_disabled()
        fail_send = False
        solve()
        send.click()
        expect(flow.locator("#message")).to_have_text("request accepted")
        assert len(calls) == before + 2
        expect(send).to_be_disabled()
        flow.clock.fast_forward(61000)
        expect(send).to_be_disabled()
        expect(verify).to_be_enabled()
        solve()
        # Page lifecycle and a changed email during an active challenge invalidate it.
        flow.evaluate("window.dispatchEvent(new Event('pagehide'))")
        expect(send).to_be_disabled()
        verify.click()
        expect(flow.locator("#mock-solve")).to_be_visible()
        flow.evaluate(
            """formId => {
          window.staleSolve=window.mockOptions.callback;
          const email=document.getElementById(formId).elements.email;
          email.value='late@example.net';email.dispatchEvent(new Event('input'));
          window.staleSolve('stale-proof');
        }""",
            form_id,
        )
        expect(flow.locator("#captcha-dialog")).to_be_hidden()
        expect(send).to_be_disabled()
        assert len(calls) == before + 2
        flow.close()
    account = None
    web_mail_count = len(calls)
    page.add_init_script(
        "window.nativeMessages=[];window.HelixCaptcha={postMessage(value){window.nativeMessages.push(JSON.parse(value));}};"
    )
    page.add_init_script("""window.modalOpens=0;const show=HTMLDialogElement.prototype.showModal;
      HTMLDialogElement.prototype.showModal=function(){window.modalOpens++;return show.call(this)};""")
    page.goto("https://accounts.test/auth/captcha?action=password_reset_code")
    expect(page.locator("#mock-solve")).to_be_visible()
    expect(page.locator("#captcha-page-start")).to_be_hidden()
    assert page.evaluate("window.mockRenders.length") == 1
    page.locator("#mock-solve").click()
    page.wait_for_function("window.nativeMessages.length===1")
    assert page.evaluate("window.nativeMessages[0]") == {
        "type": "captcha-completed",
        "action": "password_reset_code",
        "token": "mock-token-password_reset_code",
    }
    expect(page.locator("#captcha-page-start")).to_be_hidden()
    # Hosted verification never initiates mail delivery itself.
    assert len(calls) == web_mail_count
    for action in ("registration_code", "email_binding_code"):
        page.goto("https://accounts.test/auth/captcha?action=" + action)
        expect(page.locator("#mock-solve")).to_be_visible()
        assert page.evaluate("window.mockRenders[0].action") == action
        page.locator("#captcha-cancel").click()
        expect(page.locator("#captcha-dialog")).to_be_hidden()
        assert page.evaluate("window.nativeMessages") == [
            {"type": "captcha-cancelled", "action": action}
        ]
        page.evaluate("window.mockOptions.callback('stale-after-cancel')")
        assert page.evaluate("window.nativeMessages.length") == 1
        assert page.locator("main").count() == 0

    for callback, label in (
        ("error-callback", "失败"),
        ("expired-callback", "过期"),
        ("timeout-callback", "超时"),
    ):
        page.goto("https://accounts.test/auth/captcha?action=password_reset_code")
        expect(page.locator("#mock-solve")).to_be_visible()
        # Keep the old callback to check that a removed widget cannot finish a retry.
        page.evaluate("() => { window.oldSolve=window.mockOptions.callback; }")
        page.evaluate("name => window.mockOptions[name]()", callback)
        expect(page.locator("#captcha-page-status")).to_contain_text(label)
        expect(page.locator("#captcha-dialog")).to_be_visible()
        assert page.evaluate("window.modalOpens") == 1
        expect(page.locator("#captcha-page-start")).to_be_enabled()
        page.wait_for_timeout(200)
        assert page.evaluate("window.mockRenders.length") == 1
        assert page.evaluate("window.nativeMessages.length") == 0
        page.locator("#captcha-page-start").click()
        expect(page.locator("#mock-solve")).to_be_visible()
        page.evaluate("window.oldSolve('stale-proof')")
        assert page.evaluate("window.modalOpens") == 1
        expect(page.locator("#captcha-dialog")).to_be_visible()
        assert page.evaluate("window.nativeMessages.length") == 0
        page.locator("#mock-solve").click()
        page.wait_for_function("window.nativeMessages.length===1")
        assert page.evaluate("window.nativeMessages[0].token") != "stale-proof"

    for width, height, large_font in (
        (280, 640, False),
        (320, 640, False),
        (390, 844, False),
        (320, 240, True),
    ):
        page.set_viewport_size({"width": width, "height": height})
        page.goto("https://accounts.test/auth/captcha?action=password_reset_code")
        expect(page.locator("#mock-solve")).to_be_visible()
        if large_font:
            page.evaluate("document.documentElement.style.fontSize='30px'")
        geometry = page.evaluate("""() => {
          const d=document.querySelector('#captcha-dialog'),w=document.querySelector('#captcha-widget'),child=document.querySelector('#mock-widget'),r=d.getBoundingClientRect();
          return {left:r.left,right:r.right,height:r.height,scroll:d.scrollHeight,client:d.clientHeight,overflow:getComputedStyle(d).overflowY,container:w.clientWidth,widgetRight:child.getBoundingClientRect().right,containerRight:w.getBoundingClientRect().right,size:window.mockRenders[0].size};
        }""")
        assert geometry["left"] >= 0 and geometry["right"] <= width, geometry
        assert geometry["height"] <= height - 23, geometry
        assert geometry["widgetRight"] <= geometry["containerRight"] + 1, geometry
        assert geometry["size"] == (
            "compact" if geometry["container"] < 300 else "flexible"
        ), geometry
        assert geometry["overflow"] == "auto", geometry
        if large_font:
            assert geometry["scroll"] > geometry["client"], geometry
        options = page.evaluate("window.mockRenders[0]")
        assert options["retry"] == options["expired"] == options["timeout"] == "never"
        page.keyboard.press("Escape")
        expect(page.locator("#captcha-dialog")).to_be_hidden()
        assert page.evaluate("window.nativeMessages[0].type") == "captcha-cancelled"
        assert page.evaluate("document.documentElement.scrollWidth") <= width
    # Keyboard/panning can resize only the visual viewport, not innerHeight.
    visual = browser.new_page(viewport={"width": 320, "height": 740})
    visual.route("**/*", handle)
    visual.add_init_script("""window.nativeMessages=[];window.HelixCaptcha={postMessage(v){window.nativeMessages.push(JSON.parse(v))}};
      const viewport=new EventTarget();Object.assign(viewport,{width:320,height:740,offsetTop:0,offsetLeft:0});
      Object.defineProperty(window,'visualViewport',{value:viewport});""")
    visual.goto("https://accounts.test/auth/captcha?action=password_reset_code")
    expect(visual.locator("#mock-solve")).to_be_visible()
    for height, top, left, event in (
        (240, 0, 0, "resize"),
        (240, 180, 0, "scroll"),
        (180, 260, 12, "resize"),
        (740, 0, 0, "resize"),
    ):
        visual.evaluate(
            """({height,top,left,event})=>{
          Object.assign(visualViewport,{height,offsetTop:top,offsetLeft:left});
          visualViewport.dispatchEvent(new Event(event));
        }""",
            dict(height=height, top=top, left=left, event=event),
        )
        rect = visual.locator("#captcha-dialog").bounding_box()
        assert (
            rect["y"] >= top - 1 and rect["y"] + rect["height"] <= top + height + 1
        ), rect
        assert rect["x"] >= left - 1 and rect["x"] + rect["width"] <= left + 320 + 1, (
            rect
        )
        assert visual.evaluate("innerHeight") == 740
    visual.keyboard.press("Escape")
    assert visual.evaluate("window.nativeMessages[0].type") == "captcha-cancelled"
    visual.close()
    assert len(calls) == web_mail_count
    page.goto("https://accounts.test/auth/captcha?action=evil")
    expect(page.locator("#captcha-page-start")).to_be_disabled()
    assert page.evaluate("window.mockRenders?.length || 0") == 0
    assert page.evaluate("window.nativeMessages.length") == 0
    # A native bridge must exist before the automatic attempt obtains any proof.
    plain = browser.new_page()
    plain.route("**/*", handle)
    plain.goto("https://accounts.test/auth/captcha?action=password_reset_code")
    expect(plain.locator("#captcha-page-status")).to_contain_text("安全验证窗口")
    expect(plain.locator("#captcha-page-start")).to_be_enabled()
    assert plain.evaluate("window.mockRenders?.length || 0") == 0
    plain.close()
    # A hung configuration request must unlock manual retry without auto retry.
    page.add_init_script("""const originalFetch=window.fetch;window.fetch=(url,options)=>{
      if(String(url)==='/auth/captcha-info'&&location.search.includes('hang_config')){
        window.configStarted=true;
        return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));
      }return originalFetch(url,options);
    };""")
    page.clock.install()
    page.goto(
        "https://accounts.test/auth/captcha?action=password_reset_code&hang_config=1"
    )
    page.wait_for_function("window.configStarted===true")
    assert page.locator("main").count() == 0
    expect(page.locator("#captcha-dialog")).to_be_visible()
    page.locator("#captcha-cancel").click()
    assert page.evaluate("window.nativeMessages") == [
        {"type": "captcha-cancelled", "action": "password_reset_code"}
    ]
    page.clock.fast_forward(15001)
    assert page.evaluate("window.mockRenders?.length || 0") == 0
    assert page.evaluate("window.nativeMessages.length") == 1
    page.goto(
        "https://accounts.test/auth/captcha?action=password_reset_code&hang_config=1"
    )
    page.wait_for_function("window.configStarted===true")
    page.clock.fast_forward(15001)
    expect(page.locator("#captcha-page-status")).to_contain_text("超时")
    expect(page.locator("#captcha-page-start")).to_be_enabled()
    assert page.evaluate("window.mockRenders?.length || 0") == 0
    assert page.evaluate("window.nativeMessages.length") == 0
    assert not errors, errors
    browser.close()
print(
    "PASS: all three web flows require separate verification/manual send; email change/expiry/cancel/navigation/send failure clear proofs; cooldown never restores proof; automatic hosted challenge for all actions; hosted cancellation closes native flow; error/expiry/timeout retry in the same card; stale callbacks ignored; compact/flexible sizing and large-font scrolling; bridge proof only, no hosted mail; invalid actions rejected"
)
