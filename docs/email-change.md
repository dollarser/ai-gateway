# 更换登录邮箱

现行账号以不可变整数 `users.id` 为主键，邮箱唯一并用于登录，显示名可重复。已验证账号可自助更换登录邮箱；未验证账号先完成原邮箱补验证。无需管理员操作，不增加 MFA。

## 网页和安卓接口

基础地址 `https://accounts.hilex.me`。使用 `Authorization: Bearer <access_token>`，不需要 Client ID；网页 Cookie 写请求同时需要 CSRF。API Key 不允许访问这些接口。

1. 填写新邮箱、当前密码。完成用途为 `email_change_code` 的人机验证；安卓打开 `/auth/captcha?action=email_change_code`，沿用受可信来源限制的 HelixCaptcha WebMessage 桥。
2. 用户手动发送 `POST /account/email/change/code`：

   ```json
   {"email":"new@example.net","current_password":"当前密码","captcha_token":"本次验证凭据"}
   ```

   返回 `message`、`expires_in:600`、`retry_after:60`。发送尝试后清空人机凭据和密码；失败时重新验证、重新填写密码，不自动重试发信。
3. 提交 `POST /account/email/change`：

   ```json
   {"email":"new@example.net","code":"012345"}
   ```

   成功返回 `ok:true`、`email`、`api_keys_revoked:false` 和说明文字。清除客户端登录状态，跳转邮箱登录，可预填新邮箱；原密码保持有效。确认阶段不再次发送密码或人机凭据。

人机凭据仅放内存，过期、取消、改邮箱、切换用途、离页或发送尝试后不可复用。验证码为字符串，保留前导零。取消和离页清空密码、验证码。发信按钮按服务端 Retry-After 倒计时；不自动发送或后台循环重试。

| HTTP / error_code | 处理 |
|---|---|
| 401 | 登录已过期，重新登录 |
| 403 current_password_invalid | 当前密码错误，重新填写并验证 |
| 403 password_change_required | 先修改初始密码 |
| 409 email_verification_required | 先验证当前邮箱 |
| 422 email_unchanged | 新邮箱须不同于当前邮箱 |
| 409 email_in_use | 新邮箱已占用，更换地址 |
| 400 email_change_invalid | 过期、已用、尝试耗尽或账号状态改变，重新发起 |
| 422 email_change_code_required | 输入六位数字字符串 |
| 429 email_rate_limited | 根据 Retry-After 退避，重新人机验证后手动发送 |
| 503 email_delivery_unavailable | 暂停发送，稍后重试 |

通用人机验证、参数错误沿用[人机验证契约](human-verification.md)。

## 安全和状态

独立迁移 `0025_email_change.sql` 新建挑战表，不重建用户表。当前密码先校验，验证码绑定账号 ID、新邮箱、用途、挑战 ID 和密码版本；十分钟有效，最多五次确认尝试，重发替换旧挑战。注册、绑定、找回及其他账号的码不能互换。密码或原邮箱改变后旧挑战失效。

同邮箱至少六十秒间隔、每小时最多三次；另有每账号每小时三次及共享 IP/全站预算。密码尝试复用登录限流。SMTP 失败仍计入发信预算，失败挑战不可使用；只有 SMTP 确认接受后挑战才生效。成功及失败均不记录明文密码、验证码或完整 SMTP 对话。

确认在同一 D1 事务内更新邮箱和验证时间、消费挑战、撤销全部登录会话及令牌族、清除找回和补绑定挑战、记录审计。唯一约束及提交随机标记避免并发抢占和重复副作用。账号 ID、显示名、权限、额度、API Key、通知及已读状态保持原值。Key 是独立服务凭据，默认保留；怀疑泄漏时另行撤销。

完成后异步向旧邮箱发送安全通知，不包含验证码、新邮箱或凭据。通知失败记录脱敏错误，不回滚已完成的换绑。未通过真实收件箱的投递闭环只能算模拟验证；自动测试不会向用户邮箱发信。
