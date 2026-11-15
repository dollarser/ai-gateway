# AI Gateway：账号管理与 API 网关

从 `asr-tts` 拆出的独立项目。负责账号、登录、API Key、权限、配额、审计、用量和 HTTP/SSE/WebSocket 代理。不包含模型源码、权重或模型进程启动逻辑。

模型推理独立位于 `../model-serving`。两者通过 HTTP/WebSocket 连接，不导入对方的 Python 包，也不共享账号数据库。

## 本地账号部署

```bash
bash scripts/setup/setup.sh
cp .env.example .env
# 在 .env 中配置各 *_UPSTREAM_URL；默认连接同机 model-serving 的原端口。
bash scripts/start.sh
```

网关只监听回环地址：18900 为需认证的隧道入口，18901 保留原来的本机免鉴权入口。公网隧道只应转发 18900。账号域名和 API 域名分别由 `ACCOUNTS_HOST`、`GATEWAY_API_HOST` 配置。

已复制现有账号数据库和部署凭证。`accounts/data/`、`deploy/client_ids.json`、`deploy/private/` 不进入版本控制。新安装会生成初始管理员凭证文件，文件只保存在本机。

```bash
.venv-accounts/bin/python -m tests.run
```

## Cloudflare Tunnel

安装、登录授权、新建/重建、DNS、运行和验证见 [隧道运维文档](docs/tunnels.md)。当前 API 和账号入口的隧道配置统一保存在本项目 `deploy/`，连接器凭证留在 `~/.cloudflared/`。

## Cloudflare Worker + D1 账号部署

`cloudflare/` 是独立 Worker 账号服务：账号网页、注册/登录、Cookie/CSRF、access/refresh token、管理员操作、API Key、权限和配额使用 D1。GPU 机器上的 Python API 网关保留原有模型协议处理和长连接，通过受内部密钥保护的 Worker 接口申请/结算请求额度。

部署步骤、迁移及回滚见 [Cloudflare 部署说明](docs/cloudflare.md)。启用方式：

```dotenv
ACCOUNTS_WORKER_URL=https://accounts.example.com
ACCOUNTS_WORKER_SECRET=<与 Worker 的 INTERNAL_SECRET 相同>
```

启用后本地账号路由关闭，不再创建或使用 SQLite；用户在 Worker 的账号域名登录，模型客户端仍调用 API 网关域名。Worker 暂时不可用时鉴权失败关闭，不降级为本地账号。D1 的额度检查在原子 SQL 写入中完成，支持多个 API 网关实例。

完整调用链与配置见 [架构说明](docs/architecture.md)。
