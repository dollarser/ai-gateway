# 账号系统

当前线上账号入口：https://accounts.hilex.me/ 。注册、登录、Cookie/CSRF、access/refresh token、API Key、权限、额度和用量保存在 Cloudflare Worker + D1。

本目录保留本地 SQLite 实现作为兼容部署和迁移工具，并提供 Worker 复用的 `static/` 页面。线上 Worker 实现在 `cloudflare/src/`。

- 原 56 个账号和 27 个 API Key 已迁移；用户名、密码和密钥继续有效。
- 登录 access_token 配合 X-Client-ID 调用 https://api.hilex.me；API Key 可以单独调用模型 API。
- 只有管理员可以管理 API Key；普通用户可注册、查看自己的用量和修改密码。
- 管理员创建用户和重置密码后仍要求首次修改密码。
- 邮箱注册目前不发送验证邮件、不提供邮件找回密码。
- 账号数据目录不进入 Git。本机 accounts/data/accounts.db 是迁移前快照，当前线上不使用。
- scripts/ops/accounts-admin.py 操作的是本地 SQLite，不能用它直接修改线上 D1 账号；线上通过 Worker 管理网页操作。

部署与数据迁移见 [Worker/D1 文档](../docs/cloudflare.md)，客户端协议见 [客户端接入](../docs/client-integration.md)。
