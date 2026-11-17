# 邮箱自助找回密码

登录页“忘记密码？”使用**已验证并绑定的邮箱**找回账号。密码仍为 6–128 字符；找回后原登录名不变，不会把联系邮箱自动增加为登录别名。未验证邮箱、未绑定邮箱、已禁用账号不能通过此流程找回，需联系管理员。暂停公开注册不影响已有账号找回。

## 客户端协议

基础地址 `https://accounts.hilex.me`，无需登录，无需 API Key 或 X-Client-ID。

1. `POST /auth/password-reset/code`，JSON `{"email":"owner@example.net","captcha_token":"本次人机验证token"}`。
2. `POST /auth/password-reset`，JSON `{"email":"owner@example.net","code":"012345","new_password":"至少6字符","revoke_api_keys":false}`。

第一个接口对存在、不存在、未验证或被禁用的邮箱均返回通用 `message`、`expires_in:600`、`retry_after:60`，不会暴露账号是否存在。后台异步发送；返回 200 表示请求已受理，不保证邮件送达。只有 SMTP 接受成功后验证码才可使用，失败会作废挑战并记录脱敏告警。请提示用户检查垃圾邮件并在倒计时后按需重发。

第二个接口成功返回 `ok:true`、`api_keys_revoked` 和 `message`。客户端需让用户通过普通登录重新登录，不应自动创建会话或复用旧 access_token、refresh_token。网页清空本地密码和验证码并返回登录。验证码必须以字符串传递，保留前导零。网页要求再次确认新密码，服务端接受单个 new_password。

| HTTP / error_code | 含义 |
|---|---|
| 422 invalid_email / invalid_password / invalid_reset_options | 邮箱、密码或布尔选项格式错误 |
| 422 password_reset_code_required | 需要六位数字验证码 |
| 400 password_reset_invalid | 统一表示无效、过期、已使用、用途不符、超过尝试次数或账号状态已改变 |
| 429 email_rate_limited | 发送限频，遵守 Retry-After，不循环重试 |
| 503 email_delivery_unavailable | 邮件配置暂不可用，不能跳过验证 |

请求体仅开放上述字段。账号中心沿用同源检查，不允许跨站提交。找回码与注册/绑定码严格隔离，不能互换。

## 会话与 API Key 策略

- 邮箱自助找回：**始终撤销全部网页会话、access/refresh 令牌族**；不自动登录。已经被受理的推理请求不由此流程强制终止。
- API Key 默认保留。它是独立的调用凭证；单纯忘记密码不表示 Key 泄漏，无条件撤销会中断已经部署的客户端和自动化服务。
- 怀疑账号被盗时勾选“同时停用全部 API Key”，或传 `revoke_api_keys:true`；与密码更新和会话撤销在同一事务执行。Key 无法恢复，需要管理员重新创建。
- 管理员强制重置保持原有应急策略：撤销所有登录会话和所有 Key，生成需首次修改的临时密码。普通登录后的修改密码仍保留 Key。
- 此策略不是声称“改密可消除所有入侵风险”。若怀疑邮箱或 Key 泄漏，应独立保护邮箱并撤销泄漏凭证。

重置成功后向绑定邮箱异步发送安全通知，说明登录会话已撤销和 API Key 是否保留，不发送新密码。通知失败不会回滚已经成功的密码重置。

## 验证码与事务边界

验证码使用加密安全随机数，六位数字、十分钟有效、最多五次尝试；成功立即消费并清空 HMAC。HMAC 绑定 reset 用途、账号 ID、邮箱摘要和挑战 ID，D1 不存明文验证码。重发覆盖旧挑战；每邮箱 60 秒间隔、每小时 3 次，账号/IP/全站发送预算与注册和绑定共享。即使账号不存在也计入邮箱/IP预算。仅请求验证码不会修改密码、锁定账号或撤销已有会话。

挑战保存密码版本摘要，密码在其他路径修改后旧挑战失效。最终事务再次检查账号启用、验证邮箱、原密码版本、验证码、有效期与尝试次数；并发提交只允许一次成功。密码、挑战消费、会话撤销、可选 Key 撤销、审计同时提交。不会因猜错验证码而撤销 Key。

新表 `password_reset_codes` 使用 0020 增量迁移；账号删除时级联清理。Cron 每 15 分钟分批删除到期、已消费及失败挑战，最多 500 条。审计动作 `self_reset_password` / `self_reset_password_revoke_keys` 只记录账号 ID，不记录邮箱、密码、验证码或 Key。SMTP 失败日志仅记录固定错误分类。

设计依据：[OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)。

发送邮件前必须先完成[Turnstile 人机验证](human-verification.md)，网页验证框和安卓 WebView 接入均已提供；最终重置密码接口仍使用邮件验证码，不需要再次提交 Turnstile proof。

## 记得旧密码：按原用户名改密

无需邮箱或登录令牌，可直接调用 `POST https://accounts.hilex.me/auth/password`：

```json
{"username":"原登录用户名或原登录邮箱","current_password":"旧密码","new_password":"至少6字符的新密码"}
```

只开放以上字段，新密码6–128字符；客户端本地重复输入确认，不发送confirm_password。用户名按首尾去空白和小写规范化，密码不做trim。错误用户名、旧密码或禁用账号统一401；与登录共享每IP/身份的10次/5分钟限频，超限429。客户端应将该路径视为匿名凭据操作，不触发token refresh。

成功返回ok/message，撤销全部网页会话及access/refresh令牌，API Key保留，清除网页cookie后返回登录；没有自动登录。绑定的联系邮箱不会变成登录别名；请输入原用户名。通过密码版本条件更新防止并发改密覆盖；原找回挑战在密码修改后也会失效。

网页在“忘记密码”页提供“记得旧密码？直接修改密码”入口，登录后的“修改密码”页也可填写原用户名和旧密码。管理员强制重置仍使用原有撤销全部Key策略，不受此接口影响。
