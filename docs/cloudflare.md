# Worker / D1 部署与运维

当前账号服务为 https://accounts.hilex.me，Worker 名为 `hilex-accounts`，D1 名为 `hilex-accounts`，绑定为 `DB`。API 网关仍在本机，地址 https://api.hilex.me。

## 本次部署状态

已创建 APAC 区域 D1、应用 schema、迁移 56 个账号、27 个 API Key 和 3,296 条请求记录，并发布 Worker 自定义域名。账号页面、注册登录和网关鉴权已验证。原密码哈希和密钥摘要保留，无需批量重设密码或密钥。

2026-11-15 完成历史测试数据清理后，快照为 24 个账号、6 个业务密钥和 3,167 条请求。后续业务会继续改变数量；首次迁入数量是历史记录，不应通过重复导入旧库恢复它。清理规则、备份和验证见 [生产测试账号清理手册](production-data-cleanup.md)。

本机网关通过私有环境变量连接 Worker，Worker 的 `INTERNAL_SECRET` 与网关 `ACCOUNTS_WORKER_SECRET` 一致。生产密钥只在 Worker Secrets、本机 `.env` 和私有运行目录中，不在 Git 内。不要用开发 `.dev.vars` 替换生产密钥。

当前账号为 Workers Free，配置未设置自定义 `cpu_ms`（Free 不支持该字段）。本次实际注册、登录验证通过；若未来发生 CPU 超限，应根据指标调整实现或由账号持有人决定是否升级套餐，不自动产生套餐升级。

## 登录与日常发布

需要 Node.js 22+。`cloudflared` 的登录与 Wrangler 的 Worker/D1 授权相互独立。

```bash
cd /home/lingzhang/workspace/ai-gateway/cloudflare
export PATH="$HOME/.local/tools/node/bin:$PATH"
npm ci
npx wrangler login --device --browser=false
npm test
npm run deploy
```

已登录且授权有效时可省略 login。修改账号静态页面、Worker 代码或绑定后用 deploy 更新；正常更新不要再次导入历史数据。

```bash
npx wrangler whoami
npx wrangler d1 migrations list DB --remote
npm run db:remote
```

schema migration 仅对新迁移执行。D1 ID 和 `ACCOUNT_ORIGIN` 在 `wrangler.jsonc` 中；Worker 自定义域名也由其中 `routes` 管理。

## 首次在新环境创建

当前数据库已存在，下列命令仅用于新环境：

```bash
npx wrangler d1 create hilex-accounts --location apac --update-config=false
```

把新 ID 写入 `wrangler.jsonc`，保持 binding 为 `DB`，再运行 `npm run db:remote`。配置 `ACCOUNT_ORIGIN` 和自定义域名，然后设置内部密钥：

```bash
npx wrangler secret put INTERNAL_SECRET
npm run deploy
```

内部密钥至少 32 字符。若用不同账号或域名，确认该域名属于对应账号；已有冲突 DNS 记录需先处理。API 域名的隧道路由另外配置，见 [隧道文档](tunnels.md)。

## 从 SQLite 导入新空库

暂停旧账号与 API 网关写入，等待请求结束。导出文件包含敏感凭证摘要，独占创建、权限 600，仅导入没有用户流量的新库：

```bash
cd /home/lingzhang/workspace/ai-gateway
.venv-accounts/bin/python -m scripts.migrations.export_d1 \
  --source accounts/data/accounts.db \
  --output cloudflare/hilex-accounts.migration.sql
cd cloudflare
npx wrangler d1 execute DB --remote --file hilex-accounts.migration.sql
```

本次上述文件已存在且已导入，不重复执行。迁移保留用户 ID、scrypt 密码哈希、API Key、登录凭证和用量；快照中未完成的请求结算为 503。导入期间重建配额 trigger，避免历史请求被当前配额拦截。

本机 SQLite 现只作为迁移前快照。运行 `scripts/ops/accounts-admin.py` 修改的是本地旧库，不会修改 D1；线上账号通过 Worker 管理界面操作。回滚必须先处理 D1 在切换后的新写入，不能直接恢复过期 SQLite。

## 本机网关配置

`.env` 中：

```dotenv
ACCOUNTS_HOST=accounts.hilex.me
GATEWAY_API_HOST=api.hilex.me
ACCOUNTS_WORKER_URL=https://accounts.hilex.me
ACCOUNTS_WORKER_SECRET=<与 Worker INTERNAL_SECRET 相同的生产密钥>
```

重启网关后本地账号路由关闭，不再打开 SQLite。模型访问仍经 API 隧道；账号 Worker 不代理模型流量，HTTP/SSE/WebSocket 协议处理仍由 Python 网关负责。账号服务不可达时鉴权失败关闭，不降级到本地账号。

## 验证与本地测试

```bash
curl https://accounts.hilex.me/healthz
curl https://api.hilex.me/healthz
npm test
npm run check
```

账号应返回 `storage: d1`。`npm test` 使用隔离的本地 D1，不修改生产库；`npm run check` 仅构建。模型后端目前未启动，带有效凭证的模型请求可能返回 502，不代表账号鉴权失败。

[官方 D1 API](https://developers.cloudflare.com/d1/worker-api/d1-database/) · [导入与导出](https://developers.cloudflare.com/d1/best-practices/import-export-data/) · [Worker 自定义域名](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
