> 公网 API 由 Worker 统一认证和结算；OpenAI 出站支持本机转发（当前默认）或 Worker 直连，见 [出站配置](edge-api.md#openai-出站模式)。

# 项目边界与部署架构

```text
账号用户 ── accounts.hilex.me ──> Cloudflare Worker ──> D1
模型客户端 ─ api.hilex.me ──────> Cloudflare Worker ──> Tunnel ─> 本机转发 ─> OpenAI
                                      ├─> OpenAI（worker 模式）
                                      │
                                      └─> Tunnel ─> 私有本机源站 ─> 自建模型 / 识别解码
```

不启用 Worker 时，账号路由和 SQLite 在 API 网关进程内，保留原行为。生产环境中 Worker 统一执行网页、账号、API 认证、请求占用及模型额度结算。本机以 GATEWAY_EDGE_ONLY=1 接受受保护的边缘回源，不重复执行用户鉴权。

GPT-6 Luna 通过受内部密钥保护的 Worker 代理调用 OpenAI；提供方密钥持久保存在 Worker Secrets；local 模式下经受保护的隧道随请求传给本机，只在内存用于 OpenAI 鉴权，不写入本机配置。D1 的独立月额度账本在调用前预留、完成后按提供方 usage 结算，详见 [Luna 额度](luna-allowance.md)。

OpenAI 语音服务使用同一个 Worker 密钥：识别由 Worker 扫描音频帧验证实际时长，不支持的格式才回源解码，合成由 Worker 把 HTTP 请求适配成受限 Realtime 会话。D1 的 audio_usage 原子检查账号日额度，参见 [语音接入](audio-allowances.md)。管理后台直接读取 D1 的用户、用量和可信入口 IP 元数据。

Worker 负责云模型发现、OpenAI 请求验证、HTTP/SSE 和云语音适配；本机可选承担 OpenAI 出站转发，同时负责自建模型的参数兼容、WebSocket 和压缩音频编解码；`model-serving` 负责模型加载、GPU、模型级排队和推理。模型侧的 Client ID 只是内部服务凭据，不是用户账号或 API Key。

环境变量 `LLM_UPSTREAM_URL`、`ASR_UPSTREAM_URL`、`TTS_UPSTREAM_URL`、`EMBEDDING_UPSTREAM_URL`、`VIBEVOICE_UPSTREAM_URL` 是不带路径的 HTTP(S) origin，变更后重启网关。同机默认使用原端口；跨机器部署时只使用受控私网或受保护的模型入口。

现有 `deploy/client_ids.json` 已独立复制到两个项目，默认仍匹配。若单独轮换模型服务 ID，同时更新网关的 `GATEWAY_BACKEND_CLIENT_ID`。前者不能由客户端传入的 Authorization 或 Client ID 覆盖。

Worker 模式下 D1 保存凭证的 SHA256 摘要、scrypt 密码哈希、账号权限和请求占用；内部服务密钥只通过 Worker Secret 和网关环境变量配置。数据库请求占用采用条件 INSERT 和 SQL trigger 原子执行限额，不依赖某个 Worker 实例的内存锁。

当前 Worker 为 hilex-accounts，D1 为 hilex-accounts。本机账号路由已关闭，旧账号隧道连接器已停止。源站 API 网关和 API 隧道由 systemd 用户服务管理并自动重启，linger 支持无人登录时随系统启动，见 [自动运行](gateway-reliability.md)。
