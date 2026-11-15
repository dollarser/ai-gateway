# Git 内容与本地材料边界

## 应跟踪

Python / Worker 源码、账号页面（包含 admin.js）、SQL 增量迁移、自动化测试、依赖声明和锁文件（含开发用 requirements/dev.txt）、脱敏环境模板、运维及客户端交接文档。

`deploy/cloudflared-api.yml`、`deploy/tunnels.json`、`deploy/hilex.json` 和 `cloudflare/wrangler.jsonc` 描述部署拓扑。域名、Worker 名、数据库 ID、隧道 ID 不是访问凭据，继续跟踪；其中引用的凭据文件只保留在本机。不能因为目录叫 deploy 就整目录忽略，也不能忽略整个 cloudflare 或所有 JSON/SQL 文件。

`cloudflare/package-lock.json` 和 `requirements/gateway.lock` 应同步。生产运行时依赖记录在 pyproject.toml，验证用的临时浏览器安装不混入生产依赖锁。纯测试用的固定密码编码向量不是真实账号密码，保留作为兼容性测试材料。`cloudflare/tests/audio-fixtures.json` 是 FFmpeg 从 1 秒静音生成的小型压缩音频测试向量，包含 base64 与实测解码毫秒数，应跟踪；真实录音和生产验证音频保留在已忽略的 `.runtime/`。

## 不应跟踪

- `.env` / `.dev.vars*`、SSH 私钥、PEM/Key、Cloudflare 凭据、内部 Client ID、bootstrap 密码和 API Key。
- 用户 SQLite/D1 导出、生产数据清理明细、IP 导出、备份及恢复快照。
- `.runtime/`、`logs/`、`artifacts/`、虚拟环境、node_modules、Wrangler 本地状态、测试构建、浏览器报告、录音与输出文件。

`.gitignore` 使用目录与文件类型规则，保留 `.env.example`、源代码、锁文件和 `cloudflare/migrations/*.sql`。不要在仓库根目录随意导出生产数据库；统一放入已忽略的 `.runtime/` 或 `deploy/backups/`，权限 600。

## 每次提交前

```bash
git status --short --untracked-files=all
git diff --check
git diff --cached --stat
git ls-files -ci --exclude-standard
git check-ignore -v .env .runtime/example.json deploy/backups/example.sql
```

`.gitignore` 不会自动停止跟踪已有文件。发现已跟踪的敏感文件，先判断是否已泄露并轮换凭据，再从索引移除、更新忽略规则；不能只加一条规则后认为泄露已解决。历史清理和强制推送需单独评估，不在普通功能提交中重写远端历史。

本次检查了已跟踪文件和待提交文件，未发现私钥 / 真实提供方 Key 的明显特征；生产备份、密钥及临时验证材料继续保留在本地忽略目录。特征检查不是对所有可能的秘密的形式化证明，实际新增配置仍需人工审阅。

`.runtime/releases/` 含发布清单、私有日志和 D1 备份，继续忽略。浏览器回归脚本与合成测试数据跟踪，截图写入已忽略 artifacts/。
