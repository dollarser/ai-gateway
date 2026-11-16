# 注册邮箱验证码

生产账号服务由 Worker 直接通过 TLS SMTP 连接阿里企业邮箱，D1 保存验证码校验状态。不增加本机邮件转发服务。发件地址为 noreply@helixai.cc；现有账号可继续登录，不要求补验证。管理员手动创建账号流程保持原样。新公开注册在启用后必须提供邮箱验证码，成功时记录 users.email_verified_at。

## 私有配置和上线

私有文件 `.runtime/mail-config.json` 权限为 600、被 Git 忽略。包含 smtp_host、smtp_port（465）、smtp_secure（true）、smtp_username、smtp_password（客户端专用授权码）、from_email、from_name。登录账号和发件地址必须相同。不要将授权码、验证码或完整 SMTP 对话放进日志、工单或仓库。

```bash
# 仅验证 TLS 和 SMTP 登录，不发信、不修改 Worker
.venv-accounts/bin/python -m scripts.ops.configure_mail --config .runtime/mail-config.json --check-only

# 可选：仅向配置中的发件邮箱发一封无验证码的测试邮件
.venv-accounts/bin/python -m scripts.ops.configure_mail --config .runtime/mail-config.json --check-only --test-mail

# 验证登录成功后安装 Worker Secret
.venv-accounts/bin/python -m scripts.ops.configure_mail --config .runtime/mail-config.json
```

安装内容为 REGISTRATION_SMTP（完整 JSON）和 EMAIL_CODE_SECRET（独立随机 HMAC 密钥）。HMAC 密钥在本机 `.runtime/email-code-secret` 私有保存，重复配置复用；丢失后重新生成会使未使用验证码失效，应作为明确的密钥轮换处理。授权码轮换只需更新私有配置后重新执行安装命令。

先完成 SMTP 验证与 Secret 安装，再按标准 release 流程备份、迁移 0013、部署 Worker 并验证注册。wrangler.jsonc 中 EMAIL_VERIFICATION_ENABLED=true；未设置时也默认要求验证，缺少有效邮件配置则关闭注册操作并返回 503，不会自动跳过验证码。显式 false 仅用于受控的兼容回退，不应作为生产发信故障的常规处理。

阿里邮箱需开启 SMTP 并使用客户端授权码，所属区域不同可能需要不同 SMTP 主机。登录失败时检查账号、SMTP 开关、授权码和区域，不反复重试以免触发邮箱风控。SMTP 成功接收只表示邮件入队，不保证用户收件箱送达；应检查垃圾邮件、退信和域名 SPF/DKIM/DMARC 配置。

参考：[阿里企业邮箱 SMTP](https://help.aliyun.com/en/document_detail/36687.html)、[服务器及区域](https://help.aliyun.com/en/document_detail/36576.html)、[Worker TCP TLS](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)。

## 客户端协议

账号接口基础地址为 https://accounts.hilex.me ，无需先登录。

1. `GET /auth/registration-info`：新增 email_verification（是否要求验证码）、email_verification_available（邮件配置是否完整，不代表实际投递健康）字段；registration_enabled 仍表示注册策略。
2. `POST /auth/registration-code`，JSON `{"email":"user@example.net"}`：发送六位验证码。成功返回通用 message、expires_in=600、retry_after=60；已有账号返回相同响应但不会再次发送注册验证码，不直接暴露账号存在状态。
3. `POST /auth/register`，JSON `{"email":"user@example.net","password":"用户密码","code":"012345"}`：验证码保留字符串形式以免丢失前导零。成功 201，随后正常登录。code 必须属于同一邮箱；邮件和登录名按去除两端空白、转小写归一化。

网页已经包含邮箱验证码输入、发送按钮和六十秒倒计时。外部客户端必须同步增加验证码 UI 和上述 code 字段；旧客户端直接提交邮箱和密码会被拒绝。验证码只在注册用途有效，不能用于改密、登录或重置密码。

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
- Cron 每十五分钟分批清理：过期一天以上的挑战最多 500 条、一小时以外发送限频记录最多 1000 条。已验证时间保留在用户记录中。

本机旧 FastAPI/SQLite 账号服务仅用于本地开发，不提供这套生产 SMTP 注册流程；生产网关配置 Worker 账号后不会挂载该本地注册路由。
