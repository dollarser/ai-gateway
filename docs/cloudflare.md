# Cloudflare Worker / D1 账号服务

## 本地验证

需要 Node.js 22+。Worker 代码在 `cloudflare/src`，D1 schema 在 `cloudflare/migrations`。静态账号页面复用本项目 `accounts/static`，无需 Python 服务提供网页。

```bash
cd cloudflare
# 本机本次安装的 Node.js 位置（已自有 Node 时可省略）：
export PATH="$HOME/.local/tools/node/bin:$PATH"
npm ci
npm test
npm run db:local
# 生成至少 32 字符的随机内部密钥，保存为 .dev.vars 中的 INTERNAL_SECRET。
# .dev.vars 不进入版本控制。
npm run dev
```

`npm test` 通过 Miniflare 使用真实本地 D1，覆盖密码兼容、登录/CSRF、刷新重放撤销、权限与并发配额。`npm run check` 只构建并验证部署包，不发布。

## 建立云端环境

```bash
cd cloudflare
npx wrangler login
npx wrangler d1 create accounts
```

把返回的 database_id 写入 `wrangler.jsonc` 的 D1 binding，设置 `ACCOUNT_ORIGIN` 为账号域名（包含 https://）。配置该域名的 Worker Custom Domain。Python API 网关域名仍路由到 GPU/网关机器，不路由到账号 Worker。

```bash
npx wrangler secret put INTERNAL_SECRET
npm run db:remote
```

数据库创建、域名绑定、远程导入和发布需在实际部署时执行。本次拆分没有创建或修改云端资源。

## 从现有 SQLite 迁移

先暂停账号管理写入及新推理请求，等待正在进行的请求结束。使用新建的空 D1 作为迁移目标；在迁移完成前，不让 Worker 接受真实用户流量。

```bash
# 在 ai-gateway 根目录执行；输出文件独占创建、权限 600，包含敏感凭证摘要。
.venv-accounts/bin/python -m scripts.migrations.export_d1 \
  --source accounts/data/accounts.db \
  --output cloudflare/accounts.migration.sql
cd cloudflare
npx wrangler d1 execute accounts --remote --file accounts.migration.sql
npm run deploy
```

schema migration 先建表；导入文件保留现有用户 ID、密码哈希、API Key 摘要、登录凭证和用量。未结束的历史请求在快照导出中结算为 503。仅在导入期间重建请求配额 trigger，避免历史请求被当前额度阻止；导入必须在无流量的新库进行。不要将敏感导入文件提交到 Git。

新账号库没有管理员时，可在本地运行 `scripts/ops/accounts-admin.py bootstrap` 并启动一次本地账号服务以初始化管理员，再从该 SQLite 导出；不要向 Worker 配置中写明文初始密码。

迁移前后核对 `users`、`keys`、`requests` 数量，并用一个实际账号验证登录、权限、密钥和用量。原 SQLite 和 `asr-tts` 快照保留以便回滚。切换后若要回滚，先处理 D1 新写入数据，不能直接启用已过期的旧快照。

## 将 API 网关切到 D1

```dotenv
ACCOUNTS_WORKER_URL=https://accounts.example.com
ACCOUNTS_WORKER_SECRET=<相同的 INTERNAL_SECRET>
```

内部密钥应至少 32 字符。设置后重启 API 网关；本地账号路由关闭，不再打开 SQLite。用户管理和登录改用 Worker 账号域名，模型 API 地址和客户端 access_token / API Key 协议保持不变。

`/internal/*` 仅接受带内部 Bearer Secret 的 POST，不提供通用 SQL 或数据库代理。Worker 不代理模型请求，因此不改变已有大文件、SSE 和 WebSocket 的传输路径。D1 中超过 920 秒未结束的占用由定时任务结算；并发检查也忽略已过期占用，Worker 冷启动不会清空其他实例的活跃请求。

## 官方参考

- [D1 prepared statements 与 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 SQLite 数据导入](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [Worker 静态资源绑定](https://developers.cloudflare.com/workers/static-assets/binding/)
