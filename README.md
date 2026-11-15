# AI Gateway：账号管理与 API 网关

从 `asr-tts` 拆出的独立项目。负责账号、登录、API Key、权限、配额、审计、用量和 HTTP/SSE/WebSocket 代理。不包含模型源码、权重或模型进程启动逻辑。

模型推理独立位于 `../model-serving`。两者通过 HTTP/WebSocket 连接，不导入对方的 Python 包，也不共享账号数据库。

## 运维文档导航

- [API 边缘直连与语音路径](docs/edge-api.md)

- [路由诊断、额度核对、流式语音与自动运行](docs/gateway-reliability.md)

- [管理员后台与用量管理](docs/admin-console.md)
- [OpenAI 语音与日额度](docs/audio-allowances.md)
- [客户端交接](docs/client-handoff.md)
- [Git 内容与本地材料边界](docs/repository-hygiene.md)

- [GPT-6 Luna：每账号每月 1000 万 tokens](docs/luna-allowance.md)

- [项目与生产一致性维护](docs/maintenance-audit.md)
- [与旧 sglang-gateway 的功能关系](docs/sglang-gateway-relationship.md)

- [部署、授权与运维经验](docs/operations-lessons.md)
- [Worker / D1 部署流程](docs/cloudflare.md)
- [Cloudflare Tunnel 运维](docs/tunnels.md)
- [生产测试账号清理手册](docs/production-data-cleanup.md)
- [备份恢复、目录迁移与项目拆分经验](docs/backup-restore-lessons.md)

## 当前线上部署

- 账号网页与账号 API：https://accounts.hilex.me（Worker `hilex-accounts`）
- 账号数据库：D1 `hilex-accounts`
- 模型 API：https://api.hilex.me（Worker 边缘鉴权与云模型直连；仅自建模型和压缩编解码回源）

本机网关使用 Worker 账号模式，SQLite 仅用于离线兼容与迁移。自建模型后端是否就绪需单独验证，后端不可达时请求可能返回 502。GPT-6 Luna 由 Worker 调用 OpenAI，不依赖本机模型进程；每账号默认每月 1000 万 tokens。

## 部署 API 网关

```bash
bash scripts/setup/setup.sh
# 首次部署才创建 .env，不覆盖已有生产配置。
if [ ! -f .env ]; then cp .env.example .env; fi
# 填写与 Worker INTERNAL_SECRET 相同的 ACCOUNTS_WORKER_SECRET。
bash scripts/start.sh
```

默认使用 Worker/D1；缺少配置不会自动退回旧 SQLite。setup 默认不创建本地账号或管理员。显式离线账号模式及迁移工具见 [本地开发](docs/local-development.md)。

Worker 在 API 域名前置，公网隧道只连接受边缘凭据保护的回环端口 18900；18901 保留本机推理入口。用户数据库、凭证和内部 Client ID 不进入 Git。

```bash
.venv-accounts/bin/python -m tests.run
.venv-accounts/bin/python -m scripts.smoke.check_deployment
```

部署检查不创建测试账号。它验证账号 D1 健康、网关、未授权拒绝和内部接口保护；显式传 `--require-models` 才使用环境变量中的 API Key 检查模型后端。

## Cloudflare Tunnel

安装、登录授权、新建/重建、DNS、运行和验证见 [隧道运维文档](docs/tunnels.md)。当前仅 API 入口使用隧道，配置为 `deploy/cloudflared-api.yml`；账号域名由 Worker 直接提供服务。连接器凭证留在 `~/.cloudflared/`。

## Cloudflare Worker + D1 账号部署

`cloudflare/` 是独立 Worker 账号服务：账号网页、注册/登录、Cookie/CSRF、access/refresh token、管理员操作、API Key、权限和配额使用 D1。公网 API 由 Worker 直接完成认证及云模型调用；GPU 机器上的 Python 源站仅负责受保护的自建模型、长连接和压缩音频编解码。

部署步骤、迁移及回滚见 [Cloudflare 部署说明](docs/cloudflare.md)。启用方式：

```dotenv
ACCOUNTS_WORKER_URL=https://accounts.hilex.me
ACCOUNTS_WORKER_SECRET=<与 Worker 的 INTERNAL_SECRET 相同>
```

启用后本地账号路由关闭，不再创建或使用 SQLite；用户在 Worker 的账号域名登录，模型客户端仍调用 API 网关域名。Worker 暂时不可用时鉴权失败关闭，不降级为本地账号。D1 的额度检查在原子 SQL 写入中完成，支持多个 API 网关实例。

完整调用链与配置见 [架构说明](docs/architecture.md)。
