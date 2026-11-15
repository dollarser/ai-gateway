# 统一 API 网关

## 当前架构

```text
accounts.hilex.me → Worker → D1（账号、权限、配额、用量）
api.hilex.me → API Tunnel → 本机 18900（强制认证）
本机应用 → 18901（仅推理免认证）
                       ↓
             独立模型服务的 HTTP / WebSocket 后端
```

账号网页和 `/auth/*`、`/account/*`、`/admin/*` 在 Worker 上。生产网关不提供本地账号管理路由，不打开 SQLite。账号服务不可达时拒绝授权，不自动使用旧库。

18900、18901 都仅绑定回环；隧道只指向 18900。本地免认证必须同时满足实际监听端口为 18901、TCP 对端为 loopback，不能靠 Host 或 X-Forwarded-* 请求头获得。账号业务不因本机访问而免认证。

## 认证协议

- 登录令牌：Bearer access_token + 有效 X-Client-ID。
- API Key：Bearer 或 X-API-Key 单独使用，无需 Client ID；兼容已迁移的旧 Key。
- 不同的 Authorization 和 X-API-Key 同时出现会被拒绝。
- Key 仍受所属账号、权限、额度、有效期和撤销状态约束。
- 浏览器 WebSocket 可以使用 `access-token.<TOKEN>` + `client-id.<ID>`，或 `api-key.<KEY>` 子协议。

客户端无需读取服务器的私有 Client ID 文件即可使用 API Key；只有登录令牌方式需要配置合法 Client ID。

## 路由

| 接口 | 后端 |
|---|---|
| /v1/models | LLM 与 Embedding 的合并发现 |
| /v1/chat/completions、/v1/completions | LLM |
| /v1/embeddings | Embedding |
| /v1/audio/transcriptions、/ws/asr | ASR |
| /v1/audio/speech、/ws/tts | TTS |
| /v1/audio/transcriptions/vibevoice | 仅本机入口可用 |

后端地址由 `.env` 的各 `*_UPSTREAM_URL` 指定。模型启动和 GPU 环境由 model-serving 项目管理，不由本仓库启动。

## 协议与用量

网关保留 OpenAI 参数兼容、模型能力发现、上下文限制、受限重试、SSE 逐块转发和 WebSocket 转发。模型请求占用在 Worker/D1 中原子检查，完成后写入请求状态、字节数、token 和关联 ID。

账号所有 Key 共用账号并发与请求额度。管理员配置 rpm=0 或 daily_requests=0 表示该项不限制；并发仍单独限制，自助注册默认额度必须为正数。迁移保留的旧 Key token 基线仍有效，不能作为无用数据删除；新 Key 不因此自动获得旧的每日 token 预算。

token 统计在响应后结算，不是严格预留式计费。usage 缺失时采用有标记的估算，不记录对话正文。

## 启动与检查

```bash
bash scripts/start.sh
.venv-accounts/bin/python -m scripts.smoke.check_deployment
```

启动默认要求 Worker 配置，缺少配置时报错。只有显式本地开发模式才使用 SQLite，见 [本地开发](local-development.md)。

当前进程与日志定位见 [隧道运维](tunnels.md)，云端发布见 [Worker/D1](cloudflare.md)。账号或网关健康为 200 不代表模型后端已经加载；模型验证需显式运行带凭证的检查。
