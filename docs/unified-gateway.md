# 统一网关与旧项目合并（2026-10-28）

## 当前架构

```text
Cloudflare Tunnel → 127.0.0.1:18900（强制认证）
本机程序          → 127.0.0.1:18901（推理免认证）
                          ↓ 同一应用／同一账号数据库
              LLM 30007 / Embedding 18771 / ASR 18767
              TTS 18768 / VibeVoice 18769
```

VibeVoice 仅通过本机入口使用，不对公网开放；其他推理统一使用 `api.sunlingzhang.com`。旧 ASR/TTS DNS 记录已删除，权威查询返回 NXDOMAIN，缓存未过期时可能暂时仍返回旧地址并收到 404。

两个入口均只绑定回环；Cloudflare 配置只指向 18900。不能按来源 IP 是 127.0.0.1 就放行，因为 cloudflared 自身也从本机连接。实际 TCP 监听端口为 18901 且 TCP 对端为 loopback 才允许本地推理免认证。关闭代理请求头对 ASGI server/client 信息的改写。伪造 Host、X-Forwarded-For 或 X-Forwarded-Port 不能将 18900 变成本地入口。

本地免认证仅限推理，`/admin/*`、`/account/*` 等管理接口仍需账号登录。公网健康检查及既有模型文档可公开；推理必须认证。SGLang 原始服务当前为回环监听，旧 2233 网关停用，既有 Cloudflare Tunnel 不重建。30007 没有单独公开到公网，因此改变其监听并不是此次合并的必要条件；当前回环设置是额外收紧，不代表此前已公开该端口。

## 公网认证

- 账号：`Authorization: Bearer ai-at-...`，同时带有效 `X-Client-ID`。
- API Key：`Authorization: Bearer sk-acct-...` 或 `X-API-Key: sk-acct-...`，无需 Client ID；旧迁移的 `sk-qw-...` 同样适用。
- `X-API-Key` 不接受 access_token；同时提交不同的 Authorization 与 X-API-Key 会返回 401，不会尝试其中一个作为降级身份。
- Client ID 单独、Cookie 单独、无效／过期／撤销的 Key 均不能调用公网推理。仅管理员配置 Key；普通用户登录不需要创建 Key。
- 账号禁用、权限和账号请求额度同样约束 Key。账号退出撤销其登录令牌，不撤销独立 API Key；管理员可单独撤销 Key。
- WebSocket 账号使用同一请求头加 Client ID，或浏览器子协议 `access-token.<TOKEN>` + `client-id.<ID>`；Key 可用 Bearer、X-API-Key 或 `api-key.<KEY>`，无须 Client ID。浏览器宜优先账号方式。

## 本地调用

```bash
curl http://127.0.0.1:18901/v1/models
curl http://127.0.0.1:18901/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"Qwen/Qwen3-Embedding-0.6B","input":"课程知识整理"}'
curl http://127.0.0.1:18901/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"Qwen3.8-27B","messages":[{"role":"user","content":"你好"}],"max_tokens":128}'
```

VibeVoice 仅本机使用，公网同名路径返回 404，不接受任何认证方式访问。

本地路径根据接口自动分流：`/v1/chat/completions`、`/v1/completions` 为 LLM；`/v1/embeddings` 为 embedding；`/v1/audio/transcriptions` 为 Paraformer；`/v1/audio/transcriptions/vibevoice` 为 VibeVoice；`/v1/audio/speech` 为 TTS。语音 WebSocket 为 `ws://127.0.0.1:18901/ws/asr` 和 `/ws/tts`。

本机统一入口不消耗账号额度，但仍有模型并发、请求大小和推理资源限制。统一入口 ASR 上传最多 21 MiB；大文件 VibeVoice 继续直接使用 18769，保持其本机 1 GiB / 30 分钟限制。ASR/TTS 原始端口仍使用网关注入的内部 Client ID，不需要客户端知道它。

## 保留的 LLM 能力

从原 `sglang-gateway` 迁入纯函数兼容层及测试：developer 消息合并、reasoning_effort / output_config 映射、上下文窗口限制、仅在明确上下文溢出时降低输出预算重试一次、模型思考强度元信息。SSE 不合并为整段，逐块转发并读取 usage。统一 LLM 全局并发上限 4，跨模型的用户并发另由账号额度控制。

请求和 token 用量写入统一 requests 表；usage 缺失时仅作字符估算，日志明确 tokens_exact=false。审计只记录 ID、接口、状态、数量和耗时，不迁移旧项目的明文对话记录功能。

## 旧 Key 与数据

迁移工具先备份两个数据库，再复制不可逆密钥哈希，不需要读取或生成旧 Key 明文。每个旧 Key 关联一个 `legacy-api-key-<旧ID>` 技术账号，仅有原 LLM 权限；保留过期／吊销状态、每分钟请求限制、并发和每日 token 限额。技术账号使用未保存的随机密码，不作为交互登录账号使用，可由管理员禁用、撤销 Key 或设置账号请求额度。

新账号仍采用当前的每日请求额度。旧 Key 额外保留原 token 限额；原日志时间按主机 UTC 转换后导入每日用量基线，统一按北京时间零点重置。并发请求的 token 统计与原网关一样在响应后结算，并非严格预留式 token 计费。旧历史日志保留在原项目；新调用和新增 Key 只管理当前项目。

迁移记录：`artifacts/gateway-migration.json`；备份在 `accounts/data/migration-backups/`，仅本机 0600。切换后如需回滚代码，不应直接覆盖正在使用的账号数据库，否则会丢失切换后的用户、Key 和使用记录。数据库备份仅用于离线恢复。

## 部署管理

运行 `scripts/start-all.sh` 启动／复用全部服务，包括当前 LLM 后端；`--status` 只检查。账号网关使用 `gateway.run`，单进程同时监听 18900/18901，避免两个实例争抢数据库锁。关闭会话不停止后台进程；未安装开机自启。

旧项目源码、数据库和日志已于 2026-10-29 私有归档后删除，旧网关 2233 不再运行。同名 Cloudflare Tunnel 仍在运行，与旧项目目录不同。退役细节见 `docs/architecture.md`。新日志在 `logs/gateway-background.log` 和 `logs/llm-backend-background.log`，私有启动配置在 `deploy/private/llm-launch.json`。

## 不限请求次数的账号额度

管理员手动配置账号时，`rpm=0` 表示不限制每分钟请求数，`daily_requests=0` 表示不限制每日请求次数；并发仍由 `concurrency` 独立限制。自助注册的默认额度继续要求正数。账号下所有 Key 共用账号并发与次数额度，需独立额度时为 Key 建独立账号。新 Key 默认不设置每日 token 预算，仍受模型上下文、后端资源和 Key 有效期约束。
