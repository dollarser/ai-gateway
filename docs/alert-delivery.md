# 站内告警与外部投递

默认接收地址为 https://accounts.hilex.me/admin#alerts ，管理员登录后可查看站内告警、未读数量并逐条或按当前页标记已读。已读状态按管理员独立保存，不等于知悉故障；非管理员无权读取。站内投递直接写入 D1，不向自身发送 HTTP 请求，也不会产生邮件或手机推送。取消页面自动轮询，仅主动打开告警中心或点击刷新时查询未读和列表，告警检测由每 15 分钟的 Cron 执行。消息保留 30 天。

GET /admin/notifications?page=1&state=all|unread 分页读取，每页 30 条；POST /admin/notifications/read 接收 {"ids":["投递ID"]}，一次最多 100 条。

外部 Webhook 默认未配置，不会向外发送；配置后仍保留站内副本。后台“全站预算、注册保护与告警”显示配置状态、投递记录和安全错误码；接收地址完整 URL 与签名密钥仅放 Worker Secret，不进入 D1、诊断包或前端。

当前支持通用 HTTPS JSON Webhook，适合自有告警接收服务。飞书/钉钉/企业微信等机器人的原生消息格式不同，不能直接把通用载荷当成它们的协议；需要在接收端适配或按指定渠道增加适配器。

## 配置

将私有配置放到已忽略目录，权限 600：

```json
{
  "url": "https://your-alert-service.example/hook",
  "secret": "由你和接收端共同保存的至少16字符签名密钥"
}
```

```bash
.venv-accounts/bin/python -m scripts.ops.configure_alerts --config .runtime/config/alert-webhook.json
```

脚本仅安装 ALERT_WEBHOOK_URL 和可选 ALERT_WEBHOOK_SECRET，不打印值、不发送测试消息；未提供 secret 时保留现有签名配置。配置后管理员可点击“发送测试通知”，明确向已配置接收端发送合成消息。未配置外部接收端时，测试消息仅投递到站内告警中心。URL 必须为公共 HTTPS 端点；不支持本机/IP 字面量目标，不自动跟随重定向。

## 接收协议

POST application/json，结构如下，details 仅包含允许的数值聚合信息：

```json
{
  "schema": "ai-gateway-alert-v1",
  "id": "随机投递ID",
  "kind": "provider_region_restricted",
  "state": "open",
  "episode": 1,
  "observed_at": "2026-11-16T00:00:00.000Z",
  "details": {"count": 2, "window_minutes": 15},
  "dashboard": "https://accounts.hilex.me/admin#alerts"
}
```

- Idempotency-Key 为投递 ID，重试保持不变。接收端应按此去重；网络超时可能发生在消息已收到但响应丢失时，因此不是严格恰好一次投递。
- 配置签名密钥时，X-Alert-Timestamp 为 Unix 秒；X-Alert-Signature 是 HMAC-SHA256(secret, timestamp + "." + 原始请求体) 的小写十六进制。接收端应恒定时间比较、限制时间偏差并拒绝重复投递 ID。
- 接收端返回 2xx 表示接收成功。408、429、5xx、网络错误和超时最多尝试 3 次；其他非 2xx 作为不可重试失败。不记录或转发接收端原始错误正文。
- 投递超时 5 秒；Cron 每 15 分钟处理到期队列，每轮最多 10 条。重试带指数延迟，但实际执行受 Cron 周期影响。
- 同类告警在同一持续事件（episode）中只创建一条通知，不定时重复提醒，也不另发恢复通知。恢复状态仍可在管理后台查看；恢复后再次发生才开启新事件并通知。持久化去重标记不随 30 天消息清理而丢失。Webhook 重试沿用同一投递 ID。
- 地区限制、明显服务错误率、全站 Luna 预算达到 80% 每 15 分钟检查；待核对额度每小时检查一次。关闭高延迟和首音频延迟的自动检查与通知，按需查看请求诊断。预算实时拦截不受监测频率影响。
- 投递使用数据库租约避免并发处理同一记录。已完成/取消/达到重试上限的记录 30 天后分批清理。

载荷不包含对话、音频、客户端 IP、账户、邮箱、设备、请求头或凭据。配置地址后开始发送真实运行告警；未配置外部地址时，使用站内告警中心和 Worker 日志。
