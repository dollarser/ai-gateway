# 邮箱登录与可重复显示名迁移

本次直接采用新的账号契约，不保留用户名登录或旧字段别名。身份由固定整数 `id` 确定；`display_name` 是允许重复的显示名，不参与登录或权限判断；`email` 是唯一且不区分大小写的登录邮箱。

## 登录

```http
POST /auth/login
Content-Type: application/json

{"email":"owner@example.net","password":"<密码>"}
```

原请求字段 `username` 不再接受。成功返回的 access_token、refresh_token、Cookie 与刷新接口保持原协议；用户对象使用 `display_name`，不再返回 `username`。客户端必须按账号 `id` 隔离缓存、通知已读和设备数据，不能按显示名区分账号。

邮箱登录与邮箱归属验证是两件事：新用户自助注册仍必须通过邮箱验证码验证。历史账号及管理员创建的账号可以凭已有登录邮箱和密码登录，`email_binding_required=true` 时应提示验证；只有验证后的邮箱才可用于自助找回密码。没有邮箱的服务账号不能密码登录，原有 API Key 仍按账号 ID 生效。不能根据显示名推断角色或邮箱已验证。

## 注册

```http
POST /auth/register
Content-Type: application/json

{"email":"owner@example.net","password":"<至少6字符>","code":"123456","display_name":"小林"}
```

`display_name` 选填，省略时为“用户”，允许与其他账号重复。支持 1–80 个 Unicode 可见字符，去除首尾空格并按 NFC 规范化，拒绝控制字符。邮箱、人机验证、手动发码、验证码消费与频率限制保持原流程。

## 修改显示名

```http
PATCH /account/profile
Authorization: Bearer <access_token>
Content-Type: application/json

{"display_name":"新的显示名"}
```

此账号接口不要求 X-Client-ID；浏览器 Cookie 写请求仍要求 X-CSRF-Token。API Key 不能修改资料。每 24 小时可成功修改一次，相同值为幂等操作；已登录用户直接修改，无需填写或发送当前密码。成功返回 `{user, message}`，用户对象包含 `display_name_updated_at`（秒时间戳）。修改显示名不改变 ID、登录邮箱、密码、角色、额度、API Key、登录令牌或通知已读记录。

常见错误：422 `display_name_invalid`，403 需先修改初始密码，429 `display_name_change_limited`。不要因资料改名清空账号数据或重新生成账号。

## 修改密码

匿名凭旧密码修改采用 `POST /auth/password`，请求为 `{email,current_password,new_password}`；已登录接口 `POST /account/password` 仍按当前会话确定 ID，请求为 `{current_password,new_password}`。原匿名接口的 `username` 不再接受。密码修改继续撤销全部登录会话，默认保留 API Key。

## 管理后台

创建账号使用 `display_name` 和 `email`，同名账号允许共存。后台用 ID 和邮箱辅助区分账号，所有管理操作按 ID 定位。

缺少登录邮箱的历史账号可通过 `PUT /admin/users/{id}/login-email`，请求 `{email}` 设置邮箱。此操作仅管理员可用，只能填补空邮箱，不能覆盖已有邮箱，也不会把邮箱标记为已验证。管理员创建的无邮箱服务账号仍可配置密钥，但不能通过显示名登录。

## 数据迁移与验收

D1 迁移 `0024_account_identity.sql` 将旧 `username` 字段迁为 `display_name`，移除名称唯一约束，保留邮箱唯一索引，并将 ID 改为 AUTOINCREMENT，避免后续删除账号后复用 ID。所有现存 ID 原样保留，无需重新注册。

迁移会重建父表及外键关联表，先保存数据、按依赖顺序重建，再恢复索引和触发器，避免 ON DELETE CASCADE 删除已读记录或重新触发计费。必须在同一原子迁移中执行；发布前在生产备份副本逐表核对数据、外键与账本汇总，不能拆开执行。用户已经存在固定 ID，不根据姓名或邮箱合并账号，不给历史未验证邮箱补造验证时间。

本次结构切换会短暂启用 `ACCOUNT_MAINTENANCE=true`，公网新请求返回 503 `maintenance` 和 Retry-After，既有签名内部结算仍可完成。迁移成功并核对数据后，以 `ACCOUNT_MAINTENANCE=false` 发布正式版本；若迁移后发布失败，应保持维护并修复发布，不把旧版用户名 SQL 直接重新接到新结构，也不覆盖线上数据回滚。
