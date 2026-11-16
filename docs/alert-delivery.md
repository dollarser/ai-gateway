# 外部告警投递

默认未配置接收地址，不会向外发送。后台“全站预算、注册保护与告警”显示配置状态、投递记录和安全错误码；接收地址完整 URL 与签名密钥仅放 Worker Secret，不进入 D1、诊断包或前端。

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
.venv-accounts/bin/python -m scripts.ops.configure_alerts --config .runtime/alert-webhook.json
```

脚本仅安装 ALERT_WEBHOOK_URL 和可选 ALERT_WEBHOOK_SECRET，不打印值、不发送测试消息；未提供 secret 时保留现有签名配置。配置后管理员可点击“发送测试通知”，明确向已配置接收端发送合成消息。接收端未配置时按钮禁用。URL 必须为公共 HTTPS 端点；不支持本机/IP 字面量目标，不自动跟随重定向。

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
  "dashboard": "https://accounts.hilex.me/"
}
```

- Idempotency-Key 为投递 ID，重试保持不变。接收端应按此去重；网络超时可能发生在消息已收到但响应丢失时，因此不是严格恰好一次投递。
- 配置签名密钥时，X-Alert-Timestamp 为 Unix 秒；X-Alert-Signature 是 HMAC-SHA256(secret, timestamp + "." + 原始请求体) 的小写十六进制。接收端应恒定时间比较、限制时间偏差并拒绝重复投递 ID。
- 接收端返回 2xx 表示接收成功。408、429、5xx、网络错误和超时最多尝试 3 次；其他非 2xx 作为不可重试失败。不记录或转发接收端原始错误正文。
- 投递超时 5 秒；Cron 每 15 分钟处理到期队列，每轮最多 10 条。重试带指数延迟，但实际执行受 Cron 周期影响。
- 同一告警事件最多每小时提醒一次；已知悉暂停提醒，持续异常满一小时会重新打开。恢复只对已送达过的事件发一次 resolved 通知；取消尚未发送的旧 open 消息，避免恢复后再补发过期告警。
- 投递使用数据库租约避免并发处理同一记录。已完成/取消/达到重试上限的记录 30 天后分批清理。

载荷不包含对话、音频、客户端 IP、账户、邮箱、设备、请求头或凭据。配置地址后开始发送真实运行告警；在接收地址未提供前，仍只保留后台和 Worker 日志。
