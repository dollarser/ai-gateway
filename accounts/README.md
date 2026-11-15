# 统一账号中心

公网入口：**https://accounts.sunlingzhang.com/**

管理员用户名为 `admin`，初始密码仅保存在本机 `accounts/data/bootstrap-admin.json`（600）。管理员和手动创建账号首次登录必须修改密码；现在已开放邮箱自助注册。数据库和凭证目录已加入 gitignore。

## 使用

1. 用户可在登录页选择「邮箱注册」，自行设置至少 6 字符密码；无需管理员审批，默认获得 Qwen / ASR / TTS 权限。
2. 使用邮箱登录后自动取得 access/refresh token；Android 和其他客户端同时传 `Authorization: Bearer <access_token>` 和 `X-Client-ID` 调用服务，无需 API Key。
3. 管理员可修改「新注册用户的默认额度」，只影响后续注册；已有用户可逐个调整权限、每分钟请求、每日请求和跨服务并发。
4. 管理员也可继续手动创建账号，这类账号首次登录需修改初始密码。

客户端接入文档：[docs/client-integration.md](../docs/client-integration.md)，仅在本地保留。网页提供 [Helix 客户端发布页](https://github.com/dollarser/helix-agent/releases) 链接。
邮箱当前只校验格式，不发送验证码、不验证邮箱归属、不提供邮件密码找回。

```bash
curl https://api.sunlingzhang.com/v1/models \
  -H "Authorization: Bearer $AI_ACCESS_TOKEN" -H "X-Client-ID: $AI_CLIENT_ID"
curl https://api.sunlingzhang.com/v1/audio/transcriptions \
  -H "Authorization: Bearer $AI_ACCESS_TOKEN" -H "X-Client-ID: $AI_CLIENT_ID" -F 'file=@audio.wav'
curl https://api.sunlingzhang.com/v1/audio/speech \
  -H "Authorization: Bearer $AI_ACCESS_TOKEN" -H "X-Client-ID: $AI_CLIENT_ID" \
  -H 'Content-Type: application/json' -d '{"input":"你好。"}' -o speech.wav
```

Python WebSocket 客户端使用同一 Authorization 请求头。浏览器不能自定义该请求头，可使用子协议：

```javascript
const ws = new WebSocket("wss://api.sunlingzhang.com/ws/tts", ["speech", "access-token." + accessToken, "client-id." + clientId]);
```

现有文件客户端也支持登录 token：

```bash
AI_ACCESS_TOKEN="$AI_ACCESS_TOKEN" .venv-asr/bin/python scripts/clients/client.py asr \
  models/paraformer/example/asr_example.wav --url wss://api.sunlingzhang.com/ws/asr
```

文件客户端优先读取 `AI_ACCESS_TOKEN` / `SPEECH_ACCESS_TOKEN`，再读取管理员 Key 的 `AI_API_KEY` / `SPEECH_API_KEY`，未设置账号凭证时会报错，不再以 Client ID 单独调用。

接口路径、SSE 和语音 WebSocket 协议保持不变。登录 access token 前缀为 `ai-at-`，refresh token 前缀为 `ai-rt-`；管理员 Key 前缀仍为 `sk-acct-`。

## 权限与统计边界

- 账号禁用、修改权限、撤销 Key 对**后续请求**即时生效；不强制中断已开始的模型推理。
- 密钥最长有效期 365 天；只在创建时返回明文，数据库保存哈希。
- 限额按**账号**共享，创建更多 Key 不能绕过。初始注册默认 30 次/分钟、1000 次/日、并发 2；管理员既可调整后续注册的默认值，也可逐个调整已有用户。
- 请求在授权接纳时计数，包含后续上游报错，例如模型队满或等待超时返回 503。`/v1/models` 和每次 WebSocket 会话也计作一次请求。
- 日额度按北京时间零点重置。记录服务、时间、状态、响应字节和耗时；不记录密码、原始 Key、对话或音频内容。
- 这里只统计请求数和响应字节，不实现按 token / 音频秒数计费。Qwen 原网关自身的 token、并发保护继续生效，是叠加限制。
- 管理员重置用户密码会撤销其所有会话和 API Key；用户自己改密码会撤销所有登录会话，保留 API Key。
- 公网账号 token 调用必须带 Client ID；API Key 可单独调用，已迁移的旧 Qwen Key 由统一账号系统校验。关闭单独 Client ID 调用。`ACCOUNTS_ALLOW_LEGACY` 不再启用此兼容。
- 账号中心支持邮箱自助注册；尚无验证邮件、找回邮件、MFA、支付或组织管理。管理员操作审计在 SQLite `audit` 表，可通过 `GET /admin/audit` 查询最近 100 项。

## 部署结构

```text
api.sunlingzhang.com      → API Cloudflare Tunnel → 统一网关 18900 → 各模型后端
accounts.sunlingzhang.com → 账号 Cloudflare Tunnel → 统一网关 18900 → 账号系统
本机免鉴权推理           → 127.0.0.1:18901         → 按路径分流至各模型后端
```

统一网关只监听回环 18900（公网认证）与 18901（本机推理免认证）；LLM 后端只监听回环。账号 Key 不传给模型后端；网关使用本机既有 Client ID 调用后端。
修改后端共享 Client ID 后，需要同步语音服务并重启统一网关。模型后端仅内部使用，本机客户端可通过 18901 免鉴权调用，公网通过 18900 统一认证。

启动（Python 环境用 uv 创建）：

```bash
uv venv --python 3.10 .venv-accounts
uv pip sync --python .venv-accounts/bin/python requirements/accounts.lock
.venv-accounts/bin/python scripts/ops/accounts-admin.py bootstrap
./scripts/ops/serve-gateway.sh
```

语音及账号域名隧道：`./scripts/ops/serve-tunnel.sh`。
Qwen 隧道配置仍为 `~/.cloudflared/config.yml`，仅将 `api.sunlingzhang.com` 的 origin 从 2233 改为 18900；旧 Key 已迁移至当前账号数据库，旧网关进程已停用，旧项目已私有归档后删除，历史记录在 deploy/backups 中保留。
隧道切换前配置备份在 `deploy/backups/`。仅需模型后端与当前统一网关运行，不再启动原 Qwen 网关。
当前进程是持续运行的部署，尚未添加开机自启。统一网关同时只允许一个实例（文件锁）；数据库使用 WAL。

## 安全机制

- scrypt 密码哈希，随机 API Key 和随机服务端会话；Cookie 使用 `__Host-` 前缀、Secure、HttpOnly、SameSite=Strict。
- 写操作要求 CSRF token，浏览器请求同时校验 Origin；不开放跨域。
- 登录每个来源地址 5 分钟最多尝试 10 次，保存在数据库中，重启不会清零。
- 请求配额和并发预占在 SQLite 单个事务中完成；流式结束或异常时释放，在重启时回收中断请求。
- 代理只转发固定服务和推理路径，不代理模型管理端点；上传上限 21MiB（ASR）、4MiB（其他），语音后端继续执行自己的更严格限制。
- HTTP 上传最长 60 秒；连接/首响应超时受上游客户端约束；整个流式会话最多 15 分钟。没有另做基于 IP 的全局推理限流或 DDoS 防护。

## 验证与维护

```bash
.venv-accounts/bin/python -m unittest discover -s tests -v
```

42 项测试覆盖密码、会话、初始密码修改、CSRF、越权、账号禁用、密钥撤销、跨服务权限、原子并发、请求配额和持久化。
已验证公网 Qwen SSE、ASR HTTP/WSS、TTS HTTP/WSS，以及浏览器登录、创建/撤销 Key、用量和退出登录。
证据：`artifacts/accounts-*.json`、`artifacts/accounts-tests.log`；页面预览：`artifacts/accounts-portal.png`。

数据目录 `accounts/data/` 需纳入主机的受控备份；备份运行中的 SQLite 时使用 SQLite backup API，不要只复制主数据库文件而忽略 WAL。当前未配置自动备份或日志清理。

本机恢复 CLI 可创建用户或禁用普通用户；不输出明文凭证：

```bash
.venv-accounts/bin/python scripts/ops/accounts-admin.py create-user --username alice --output /secure/path/alice.json
.venv-accounts/bin/python scripts/ops/accounts-admin.py disable-user --username alice
```

邮箱注册新增 `users.email` 和注册限流、默认额度配置表，通过可重复的增量迁移保留已有账号、密钥与用量。邮箱注册按来源每小时最多 5 次尝试、全站每小时最多 100 次尝试。额度默认值在 SQLite settings 表持久化。

## 登录凭证与管理员 Key（当前）

- 登录返回 15 分钟 access token 和最长 30 天 refresh token；Android 不依赖 Cookie 或 CSRF。
- 刷新 token 单次使用，重放会撤销本次登录；客户端必须串行刷新并原子保存新 token 对。
- 退出支持直接提交 refresh token，即使 access token 过期也可撤销该次登录。
- 改密码、重置密码或禁用账号都会撤销该账号全部登录；退出只撤销当前登录。
- 所有 API Key 配置接口只允许管理员，普通用户不能创建、列出、撤销 Key。管理员可 POST `/admin/keys/{user_id}` 为账号配置 Key；旧 Key 保留调用能力，受对应账号权限和额度约束。
- 登录调用不创建内部 API Key。请求用量中的 `key_id` 可空，并以 `auth_type=access_token` 与既有 `api_key` 记录区分。
