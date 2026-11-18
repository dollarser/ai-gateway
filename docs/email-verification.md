# 注册邮箱验证码

生产账号服务由 Worker 直接通过 TLS SMTP 连接阿里企业邮箱，D1 保存验证码校验状态。不增加本机邮件转发服务。发件地址为 noreply@helixai.cc；现有账号可继续登录，不要求补验证。管理员手动创建账号流程保持原样。新公开注册在启用后必须提供邮箱验证码，成功时记录 users.email_verified_at。

## 私有配置和上线

私有文件 `.runtime/config/mail-config.json` 权限为 600、被 Git 忽略。包含 smtp_host、smtp_port（465）、smtp_secure（true）、smtp_username、smtp_password（客户端专用授权码）、from_email、from_name。登录账号和发件地址必须相同。不要将授权码、验证码或完整 SMTP 对话放进日志、工单或仓库。

```bash
# 仅验证 TLS 和 SMTP 登录，不发信、不修改 Worker
.venv-accounts/bin/python -m scripts.ops.configure_mail --config .runtime/config/mail-config.json --check-only

# 可选：仅向配置中的发件邮箱发一封无验证码的测试邮件
.venv-accounts/bin/python -m scripts.ops.configure_mail --config .runtime/config/mail-config.json --check-only --test-mail

# 验证登录成功后安装 Worker Secret
.venv-accounts/bin/python -m scripts.ops.configure_mail --config .runtime/config/mail-config.json
```

安装内容为 REGISTRATION_SMTP（完整 JSON）和 EMAIL_CODE_SECRET（独立随机 HMAC 密钥）。HMAC 密钥在本机 `.runtime/secrets/email-code-secret` 私有保存，重复配置复用；丢失后重新生成会使未使用验证码失效，应作为明确的密钥轮换处理。授权码轮换只需更新私有配置后重新执行安装命令。

先完成 SMTP 验证与 Secret 安装，再按标准 release 流程备份、迁移 0013、部署 Worker 并验证注册。wrangler.jsonc 中 EMAIL_VERIFICATION_ENABLED=true；未设置时也默认要求验证，缺少有效邮件配置则关闭注册操作并返回 503，不会自动跳过验证码。显式 false 仅用于受控的兼容回退，不应作为生产发信故障的常规处理。

阿里邮箱需开启 SMTP 并使用客户端授权码，所属区域不同可能需要不同 SMTP 主机。登录失败时检查账号、SMTP 开关、授权码和区域，不反复重试以免触发邮箱风控。SMTP 成功接收只表示邮件入队，不保证用户收件箱送达；应检查垃圾邮件、退信和域名 SPF/DKIM/DMARC 配置。

参考：[阿里企业邮箱 SMTP](https://help.aliyun.com/en/document_detail/36687.html)、[服务器及区域](https://help.aliyun.com/en/document_detail/36576.html)、[Worker TCP TLS](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)。

## 客户端协议

账号接口基础地址为 https://accounts.hilex.me ，无需先登录。

1. `GET /auth/registration-info`：新增 email_verification（是否要求验证码）、email_verification_available（邮件配置是否完整，不代表实际投递健康）字段；registration_enabled 仍表示注册策略。
2. `POST /auth/registration-code`，JSON `{"email":"user@example.net","captcha_token":"本次人机验证token"}`：发送六位验证码。成功返回通用 message、expires_in=600、retry_after=60；已有账号返回相同响应但不会再次发送注册验证码，不直接暴露账号存在状态。
3. `POST /auth/register`，JSON `{"email":"user@example.net","password":"用户密码","code":"012345"}`：验证码保留字符串形式以免丢失前导零。成功 201，随后正常登录。code 必须属于同一邮箱；登录邮箱按去除两端空白、转小写归一化，显示名保留 Unicode 大小写且可重复。

网页已经包含邮箱验证码输入、发送按钮和六十秒倒计时。外部客户端必须同步增加验证码 UI 和上述 code 字段；旧客户端直接提交邮箱和密码会被拒绝。注册验证码只在注册用途有效，不能用于改密、登录或重置密码。邮箱找回密码使用[独立的重置验证码流程](password-recovery.md)。

| HTTP / error_code | 客户端处理 |
|---|---|
| 422 email_verification_required | 提示输入六位验证码 |
| 400 email_verification_invalid | 无效、过期、已用或超过错误次数；提示重新获取 |
| 429 email_rate_limited | 限频，参考 Retry-After 并退避，不循环发送 |
| 503 email_delivery_unavailable | 邮件配置、SMTP 登录或投递异常，稍后重试；不要绕过验证 |
| 403 registration_disabled | 当前暂停注册 |
| 409 | 账号已存在，转登录 |

邮箱仅支持常见 ASCII 邮箱格式，不支持 SMTPUTF8 地址。用户输入不能直接拼入邮件头。

## 限频与原子性

- 验证码使用安全随机数，六位数字、十分钟有效、最多五次校验尝试。成功注册后不可复用，重发会使旧码失效。
- 同邮箱发送间隔至少六十秒，每小时最多三次；IP 和全站小时/分钟上限复用 registration_policy 的配置，发送次数与实际注册尝试分别计数。发送失败和已存在账号请求也占发送限额，防止重试放大。
- 邮箱和 IP 在发送限频表中仅保存 SHA-256；验证码保存带独立 Secret 的 HMAC，不存明文。SMTP 回复正文、认证内容和验证码不进入日志；日志仅记录固定错误分类。
- 限频预留及挑战替换在 D1 batch 内完成；校验尝试使用条件 UPDATE，注册用户创建和验证码消费在同一事务完成，避免并发复用。注册失败回滚不提前消耗验证码。
- SMTP 统一十五秒截止时间，回复长度有限制。只有 DATA 后返回 250 接受才启用验证码。SMTP 失败不能落入免验证注册。
- Cron 每十五分钟分批清理：已过期、已使用或发送失败的挑战最多 500 条；成功消费时立即清空验证码HMAC、一小时以外发送限频记录最多 1000 条。已验证时间保留在用户记录中。

本机旧 FastAPI/SQLite 账号服务仅用于本地开发，不提供这套生产 SMTP 注册流程；生产网关配置 Worker 账号后不会挂载该本地注册路由。

## 历史账号登录后的绑定提醒

登录响应的 `user` 和 `GET /account/me` 的 `user` 新增 `email_binding_required`。未验证账号（包括历史邮箱注册、历史用户名账号、管理员创建的未验证账号）为 true，已完成注册邮箱验证或绑定验证的账号为 false。标记按 email_verified_at 动态计算，不批量修改历史账号，不自动向历史邮箱发信。

网页登录或恢复会话后展示“请验证并绑定邮箱”提醒。只预填已有 email，不能从显示名推断邮箱。没有邮箱的历史服务账号由管理员按 ID 设置登录邮箱。用户可展开验证表单，也可选择稍后绑定；提醒不阻断模型调用、用量查询等既有功能。首次强制改密的账号先修改初始密码，再绑定。绑定成功后提醒隐藏，下次登录不再提示。

### 客户端接口

基础地址 https://accounts.hilex.me ，要求账号登录 access_token；网页 Cookie 写操作要求 CSRF。模型 API Key 不支持这些账号接口。

- `POST /account/email/code`，JSON `{"email":"user@example.net","captcha_token":"本次人机验证token"}`：向目标邮箱发送六位验证码，返回 message、expires_in=600、retry_after=60。
- `POST /account/email/bind`，JSON `{"email":"user@example.net","code":"012345"}`：校验验证码并完成绑定，返回 `{"user":{...},"message":"邮箱已验证并绑定，可用于登录和找回密码"}`。返回的 user.email_binding_required=false，并包含 email_verified_at。

绑定更新登录邮箱和验证时间，**不修改账号 ID、显示名、密码、权限、额度或现有登录令牌**。绑定成功后使用返回的 email 登录；显示名不参与登录。此功能用于补绑定，已验证账号不提供修改邮箱操作。

除注册已有的邮箱错误码外，新增：409 email_in_use（被其他账号的邮箱占用）、409 email_already_verified（已完成绑定）、409 email_binding_changed（并发导致账号或挑战状态改变，刷新后重试）、403 password_change_required（先改初始密码）。客户端应在收到 true 时提示用户绑定，允许稍后处理；用户主动打开表单后才发送验证码，不能在每次登录时自动发邮件。

### 隔离、限频和并发

- 绑定验证码位于 account_email_codes，按登录用户保存；HMAC 输入包含用户 ID 和绑定用途。注册码与绑定码不能互换，一个账号的码也不能用于另一个账号；更换目标并重发会使该账号旧码失效。
- 绑定沿用十分钟有效、五次尝试及六十秒重发间隔。除共享邮箱/IP/全站发送预算外，每账号每小时最多发送三次，避免切换目标绕过限制。暂停公开注册时，历史账号仍可补绑定，但共享发送上限仍生效。
- 绑定前及提交事务内均检查邮箱占用；已验证邮箱另有大小写不敏感的唯一索引，防止并发抢占。更新邮箱、消费验证码和 bind_email 审计同一事务提交，审计只保存账号 ID。
- 绑定记录随账号删除级联清理；成功绑定立即清空HMAC；Cron 分批清理已用、失败和过期的绑定挑战，发送限频记录保持原清理周期。

外部客户端需要主动接入上述登录标记和表单；服务器不会强制拦截旧客户端的既有模型请求。


## 事务邮件服务切换（待新凭据后执行）

既有企业邮箱SMTP技术上能发送，但阿里官方不支持将企业邮箱用于注册验证等系统邮件：[用途说明](https://help.aliyun.com/zh/document_detail/189757.html)。技术测试成功不代表适合作为长期事务邮件通道。当前未擅自切换线上凭据或开通服务；后台运维区域会显示仍使用旧邮件通道。

建议在阿里云DirectMail验证发信域和地址，并为该发信地址设置**单独的SMTP密码**，不是企业邮箱授权码。可继续使用 noreply@helixai.cc，但应按DirectMail控制台要求验证DNS，不覆盖现有企业邮箱MX记录。地域与SMTP端点必须匹配：[DirectMail端点](https://www.alibabacloud.com/help/en/direct-mail/smtp-endpoints)、[专用SMTP密码](https://www.alibabacloud.com/help/en/direct-mail/user-guide/send-emails-using-smtp)。服务价格和账户发信额度由实际开通套餐决定。

已创建私有模板 `.runtime/config/transactional-mail-config.json`（600，Git忽略），provider=alicloud-directmail，默认杭州端点smtpdm.aliyun.com、TLS465；其他地域按官方端点调整，填入专用SMTP密码后执行：

```bash
.venv-accounts/bin/python -m scripts.ops.configure_mail --config .runtime/config/transactional-mail-config.json --check-only
.venv-accounts/bin/python -m scripts.ops.configure_mail --config .runtime/config/transactional-mail-config.json --test-mail
```

第二条先验证登录并只向发件邮箱自测，再安装Worker Secret，复用原HMAC密钥，不影响账号、邮箱验证状态和个人额度。configure_mail默认拒绝重新安装企业邮箱注册通道；如明确需要短期回退，可使用 --allow-legacy-enterprise，但这不代表供应商支持其用途。未提供provider的旧Secret继续兼容，避免上线过程中突然中断现有注册。

已验证绑定的邮箱现在可用于[自助找回密码](password-recovery.md)。原注册或绑定验证码不能用于找回；默认保留 API Key，可主动选择停用全部 Key。

注册和绑定的发送验证码接口现在强制校验 captcha_token，获取方式、action、安卓 WebView 桥接见[人机验证接入](human-verification.md)。
