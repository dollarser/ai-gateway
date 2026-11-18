# 邮件发送前的人机验证

生产使用 Cloudflare Turnstile Managed 验证框，覆盖注册、找回密码、登录后绑定及更换邮箱的验证码发送。服务端先验证 proof，再进入原有邮件发送预算和 SMTP 流程。登录、模型调用、最终提交邮件验证码不新增此验证，原有密码/验证码尝试限制继续生效。

## API 契约

`GET https://accounts.hilex.me/auth/captcha-info` 返回 provider=turnstile、enabled、公开 site_key、actions 和 challenge_url。公开 site_key 不是服务端 Secret。生产必须启用；配置缺失或 Siteverify 异常返回 503，不允许客户端跳过。

| 发送接口 | Turnstile action |
|---|---|
| POST /auth/registration-code | registration_code |
| POST /auth/password-reset/code | password_reset_code |
| POST /account/email/code | email_binding_code |
| POST /account/email/change/code | email_change_code |

请求原 email 字段不变，新增必需的 `captcha_token`：

```json
{"email":"owner@example.net","captcha_token":"本次人机验证返回的token"}
```

前两个接口仍匿名；绑定及更换邮箱接口使用账号认证。最终 `/auth/register`、`/auth/password-reset`、`/account/email/bind`、`/account/email/change` 提交的是邮件中收到的 code，不传 Turnstile token。不要把两种验证码混用。

Turnstile proof 有效期五分钟，发送前新获取、每次只能使用一次。服务端检查 Siteverify success、hostname=accounts.hilex.me、对应 action，并在 D1 原子登记 token 摘要，避免跨节点并发重放。上游失败或邮件发送限频后同一个 proof 也不能重用，下一次手动发送须重新验证。不要自动重发整条发送请求。

| HTTP / error_code | 客户端处理 |
|---|---|
| 400 captcha_required | 缺少或格式错误的 proof，打开验证页 |
| 400 captcha_invalid | 验证失败、已用、过期或用途/域名不符，重新验证 |
| 429 captcha_rate_limited | 人机验证校验请求过多，遵守 Retry-After |
| 503 captcha_unavailable | 配置或校验服务暂不可用，提示稍后手动重试，不绕过 |
| 429 email_rate_limited | 人机验证通过但发送预算已耗尽，等待发送冷却后重新验证 |

网页注册、找回密码、绑定邮箱与安卓采用相同的两步交互：先点击“完成人机验证”，验证成功后仅解锁“发送验证码”；用户另行点击发送才提交 token。取消或验证失败不发送邮件。proof 只保存在内存并绑定当前邮箱、用途和账号；改邮箱、切换流程、隐藏/离开页面、账号变化及任何发送尝试后清除，失败也不能复用。网页在四分钟后保守地要求重新验证，短于服务端五分钟有效期。发送冷却结束只解锁验证操作，不恢复已消费 proof。客户端不记录 proof、验证码、邮箱明文或完整请求体。验证码发送预算继续为同邮箱 60 秒间隔/每小时3次，同账号每小时3次；IP/全站发送额度以后台配置为准。

为限制伪造 token 对外部校验的开销，额外设置自然分钟桶：每 IP 最多20次、全站最多500次 Siteverify 校验尝试；数据库原子限制，超过时不调用外部服务。邮件限频和人机验证预算相互独立。D1 只保存 proof 的 SHA-256 及 IP 摘要；Cron 清理超过十分钟的 proof（每轮最多1000条）和过期分钟桶。不保存明文 proof 或 Secret。

人机验证不能代替邮件额度或边缘 DDoS 防护。该功能不是图片文字输入；Managed 模式按风险自动判断或要求点击验证框。

## 安卓原生接入

Turnstile 需要浏览器环境，安卓使用应用内 WebView 完成验证，再回到原生 HTTP 流程；无需将邮箱、密码或账号令牌放进 WebView。正式页面：

```text
https://accounts.hilex.me/auth/captcha?action=password_reset_code
```

页面检查有效用途和原生消息桥后自动启动一次挑战，不需要再点击“开始验证”；失败、过期或超时后在同一验证卡内显示“重试”，取消回传客户端并结束本次窗口，不保留中间页。失败后，必须手动点击重试，不自动重复启动。验证弹窗按打开后的实际容器宽度选择 compact（小于 300px）或 flexible，并支持窄屏、字体放大和垂直滚动。尺寸依据 [Cloudflare 官方配置说明](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/)。

注册、绑定和更换邮箱换成表格中对应 action。页面不接收任意 return_url、不把 proof 放进 URL，也不通过自定义 scheme 回传。

1. 打开可信的上述 HTTPS 页面，启用 JavaScript、DOM storage，保持 WebView 默认且稳定的 UA。允许 challenges.cloudflare.com 的必要脚本/iframe/网络请求及其 about:blank、about:srcdoc 子文档；不要把主页面导航放开到任意域名。按官方要求允许此验证 WebView 使用 Cookie；不要在验证进行中清空存储。
2. 加载页面**之前**注册 AndroidX WebKit 的 WebViewCompat.addWebMessageListener，JS 对象名为 `HelixCaptcha`，allowedOriginRules 仅包含 `https://accounts.hilex.me`。先检查 WEB_MESSAGE_LISTENER 是否可用；不支持时提示升级 Android System WebView，不回退到对任意页面公开的 addJavascriptInterface。
3. 接收回调时必须检查 isMainFrame、sourceOrigin、type、action，以及 proof 为长度不超过2048的非空字符串。sourceOrigin 必须为 HTTPS、host=accounts.hilex.me、默认/443端口；action 必须等于本次请求用途。验证页面调用 `window.HelixCaptcha.postMessage(...)` 返回：

```json
{"type":"captcha-completed","action":"password_reset_code","token":"短期一次性proof"}
```

4. 关闭验证窗口，把 proof 交回原生页面；用户手动点击发送验证码后，在发送请求的 captcha_token 中提交，再处理邮件验证码。验证页不会自动发送邮件。不要把 proof 当登录凭证或永久缓存；仅保存在内存。验证码发送接口不因为获得 proof 而需要 Authorization / X-Client-ID，绑定及更换邮箱接口除外。
5. 用户返回/取消、加载失败、proof 过期、修改邮箱、切换用途或离开当前流程时立即丢弃内存中的 proof。账号上下文变化时也立即丢弃 proof。任何发送尝试后均清除 proof，即使发送失败或结果不明确，下次也必须重新验证。收到 proof 后也不能在多个并发发送请求中复用。

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

验证配置请求与 Turnstile 脚本加载分别设置 15 秒超时。无可信原生消息桥时不启动挑战、不获取 proof；页面只显示错误及手动重试入口。网页用户取消通过受信消息桥回传 `{"type":"captcha-cancelled","action":"本次用途"}`，客户端按同源、主框架、固定 URL 和用途校验后关闭窗口，不接受迟到 proof。

网页使用同一套 `email-verification.js` 状态管理三个用途；异步验证期间改邮箱或离页会取消当前挑战，迟到回调不能恢复失效 proof。原生托管页只回传 proof 或用户取消事件，不发送邮件；发码 API 与服务端安全校验不变。

嵌入入口仅保留一个 dialog，加载、挑战和错误恢复在同一卡内；无需客户端隐藏宿主页、复制取消按钮或计算网页卡片高度。网页按实际 visualViewport 的宽高与 offsetTop/offsetLeft 定位，监听 resize/scroll；键盘只缩小可视区域或平移视口而布局区域不变时，卡片仍在可视区域内居中，超出内容可滚动；原生只负责 WebView 加载失败兜底及安全消息接收。普通网页账号表单继续使用原有弹窗，不受嵌入页单卡呈现影响。

## 与上一线上版本（8ac18c3）的差异

| 场景 | 旧版 | 本批改动 |
|---|---|---|
| 托管页面 | 宿主页说明与验证弹窗两层结构 | 透明宿主，仅一张验证卡片 |
| 配置与脚本加载 | 先显示宿主页，组件就绪后弹窗 | 立即显示卡片，可在加载期间取消 |
| 失败、过期、超时 | 关闭弹窗，返回宿主页手动重试 | 同一卡片显示错误，手动重试，不重新弹出卡片 |
| 取消 | 留在宿主页，可重新发起验证 | 回传 captcha-cancelled，本次流程结束，由已对接的安卓关闭窗口 |
| 键盘、视口平移 | 主要依赖布局视口的弹窗居中 | 按 visualViewport 的大小与偏移定位，监听 resize/scroll，长内容滚动 |

成功消息 `captcha-completed` 的字段不变。普通账号网页继续采用先验证、再手动发码的两步流程；发码接口、Turnstile 服务端校验、防重放、账号鉴权及模型路由不变。新增回归覆盖布局视口不变但可视视口缩小、平移和恢复的情况；模拟测试不代替安卓软键盘真机验收。

更换已验证登录邮箱还要求当前密码，完整字段和会话撤销规则见[更换登录邮箱](email-change.md)。
