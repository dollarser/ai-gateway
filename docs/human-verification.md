# 邮件发送前的人机验证

生产使用 Cloudflare Turnstile Managed 验证框，覆盖注册、找回密码、登录后绑定邮箱的验证码发送。服务端先验证 proof，再进入原有邮件发送预算和 SMTP 流程。登录、模型调用、最终提交邮件验证码不新增此验证，原有密码/验证码尝试限制继续生效。

## API 契约

`GET https://accounts.hilex.me/auth/captcha-info` 返回 provider=turnstile、enabled、公开 site_key、actions 和 challenge_url。公开 site_key 不是服务端 Secret。生产必须启用；配置缺失或 Siteverify 异常返回 503，不允许客户端跳过。

| 发送接口 | Turnstile action |
|---|---|
| POST /auth/registration-code | registration_code |
| POST /auth/password-reset/code | password_reset_code |
| POST /account/email/code | email_binding_code |

请求原 email 字段不变，新增必需的 `captcha_token`：

```json
{"email":"owner@example.net","captcha_token":"本次人机验证返回的token"}
```

前两个接口仍匿名；绑定邮箱接口仍使用账号认证。最终 `/auth/register`、`/auth/password-reset`、`/account/email/bind` 提交的是邮件中收到的 code，不传 Turnstile token。不要把两种验证码混用。

Turnstile proof 有效期五分钟，发送前新获取、每次只能使用一次。服务端检查 Siteverify success、hostname=accounts.hilex.me、对应 action，并在 D1 原子登记 token 摘要，避免跨节点并发重放。上游失败或邮件发送限频后同一个 proof 也不能重用，下一次手动发送须重新验证。不要自动重发整条发送请求。

| HTTP / error_code | 客户端处理 |
|---|---|
| 400 captcha_required | 缺少或格式错误的 proof，打开验证页 |
| 400 captcha_invalid | 验证失败、已用、过期或用途/域名不符，重新验证 |
| 429 captcha_rate_limited | 人机验证校验请求过多，遵守 Retry-After |
| 503 captcha_unavailable | 配置或校验服务暂不可用，提示稍后手动重试，不绕过 |
| 429 email_rate_limited | 人机验证通过但发送预算已耗尽，等待发送冷却后重新验证 |

网页发送按钮先打开验证对话框，成功后自动提交 token；取消不发送邮件。客户端不记录 proof、验证码、邮箱明文或完整请求体。验证码发送预算继续为同邮箱 60 秒间隔/每小时3次，同账号每小时3次；IP/全站发送额度以后台配置为准。

为限制伪造 token 对外部校验的开销，额外设置自然分钟桶：每 IP 最多20次、全站最多500次 Siteverify 校验尝试；数据库原子限制，超过时不调用外部服务。邮件限频和人机验证预算相互独立。D1 只保存 proof 的 SHA-256 及 IP 摘要；Cron 清理超过十分钟的 proof（每轮最多1000条）和过期分钟桶。不保存明文 proof 或 Secret。

人机验证不能代替邮件额度或边缘 DDoS 防护。该功能不是图片文字输入；Managed 模式按风险自动判断或要求点击验证框。

## 安卓原生接入

Turnstile 需要浏览器环境，安卓使用应用内 WebView 完成验证，再回到原生 HTTP 流程；无需将邮箱、密码或账号令牌放进 WebView。正式页面：

```text
https://accounts.hilex.me/auth/captcha?action=password_reset_code
```

注册和绑定换成表格中对应 action。页面不接收任意 return_url、不把 proof 放进 URL，也不通过自定义 scheme 回传。

1. 打开可信的上述 HTTPS 页面，启用 JavaScript、DOM storage，保持 WebView 默认且稳定的 UA。允许 challenges.cloudflare.com 的必要脚本/iframe/网络请求及其 about:blank、about:srcdoc 子文档；不要把主页面导航放开到任意域名。按官方要求允许此验证 WebView 使用 Cookie；不要在验证进行中清空存储。
2. 加载页面**之前**注册 AndroidX WebKit 的 WebViewCompat.addWebMessageListener，JS 对象名为 `HelixCaptcha`，allowedOriginRules 仅包含 `https://accounts.hilex.me`。先检查 WEB_MESSAGE_LISTENER 是否可用；不支持时提示升级 Android System WebView，不回退到对任意页面公开的 addJavascriptInterface。
3. 接收回调时必须检查 isMainFrame、sourceOrigin、type、action，以及 proof 为长度不超过2048的非空字符串。sourceOrigin 必须为 HTTPS、host=accounts.hilex.me、默认/443端口；action 必须等于本次请求用途。验证页面调用 `window.HelixCaptcha.postMessage(...)` 返回：

```json
{"type":"captcha-completed","action":"password_reset_code","token":"短期一次性proof"}
```

4. 关闭验证窗口，在原生客户端将 token 放入发送请求的 captcha_token，再处理邮件验证码。不要把 proof 当登录凭证或永久缓存；仅保存在内存。验证码发送接口不因为获得 proof 而需要 Authorization / X-Client-ID，绑定接口除外。
5. 用户返回/取消或加载失败时取消发送；proof 过期、被消费、超时结果不明确时，下次手动发送重新完成人机验证。收到 proof 后也不能在多个并发发送请求中复用。

桥接示意（沿用现有 AndroidX WebKit 依赖，省略页面生命周期）：

```kotlin
WebViewCompat.addWebMessageListener(
    webView, "HelixCaptcha", setOf("https://accounts.hilex.me")
) { _, message, sourceOrigin, isMainFrame, _ ->
    if (!isMainFrame || sourceOrigin.scheme != "https" ||
        sourceOrigin.host != "accounts.hilex.me" ||
        sourceOrigin.port !in listOf(-1, 443)) return@addWebMessageListener
    // 用现有 JSON 解析器读取 message.data；校验 type/action/token 后，
    // 交回当前找回流程。不要记录原始 message，也不要直接执行其中任何代码。
}
```

此页面不会回传新密码或发起邮件发送，只有一次性验证结果。安卓端的成功回调不能代替服务端校验。

## 部署与运维

Widget 名称 Helix account email verification，Managed 模式，仅允许 accounts.hilex.me。TURNSTILE_SECRET_KEY 只保存在 Worker Secret；TURNSTILE_SITE_KEY 也由 Worker 配置提供给公开发现接口。私有恢复副本 `.runtime/secrets/turnstile.json` 权限600、Git忽略。

```bash
# 仅从已备份的私有配置恢复 Secret，不输出内容。
cloudflare/node_modules/.bin/wrangler secret bulk .runtime/secrets/turnstile.json --config cloudflare/wrangler.jsonc
```

生产 wrangler.jsonc 的 CAPTCHA_ENABLED=true。false 仅用于隔离的本地测试，不应作为生产故障回退。0021 增量迁移增加 captcha_redemptions、captcha_attempts；发布顺序仍为备份验证、迁移、发布、验证。门户 CSP 只新增 challenges.cloudflare.com 的 script/connect/frame 权限，不增加任意来源或 unsafe-inline。

参考：[Cloudflare 服务端验证](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)、[安卓 WebView 接入](https://developers.cloudflare.com/turnstile/get-started/mobile-implementation/)。
