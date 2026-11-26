# 迁移设备备份清单

当前账号、权限、额度和请求数据保存在 Cloudflare D1，OpenAI 密钥持久保存在 Worker Secrets；本机运行受保护的 OpenAI 转发和 API 隧道。更换本机不需要重新创建 Worker、D1、域名或隧道。

## 本机必需材料

| 内容 | 位置 | 作用 |
|---|---|---|
| 源代码和依赖锁 | GitHub 仓库，另保存未提交改动 | 可重新克隆；本地独有内容不会随 Git 自动恢复 |
| 生产环境配置 | 项目 `.env` | 包含 Worker 地址、内部认证密钥和本机运行配置，未入 Git |
| 后端客户端 ID | `deploy/client_ids.json` | 未入 Git；需与 Worker 客户端白名单及模型服务配置匹配 |
| 私有邮件配置 | `.runtime/config/` | 包括当前 SMTP 配置与事务邮件模板；存在告警 Webhook 配置时一并保存 |
| 密钥恢复材料 | `.runtime/secrets/` | 验证码 HMAC 密钥及内部认证密钥恢复副本；内部密钥以实际 `.env` 与线上 Secret 一致的值为准 |
| 当前隧道凭据 | `~/.cloudflared/d79096c0-61c1-4317-8878-2ed3b79f0417.json` | 运行现有 API 隧道；只保存 Git 中的隧道 ID/YAML 不足以运行 |

项目路径 `/home/lingzhang/workspace/ai-gateway` 当前解析到 `/data/backup/ai-gateway`。备份工具应包含真实文件，不能只复制软链接本身。备份应加密、限制访问，不提交凭据到 Git。

## 建议保存的恢复材料

- `~/.cloudflared/cert.pem`：隧道管理授权，可重新登录获取；运行已有隧道主要使用上述隧道 JSON。
- `~/.config/.wrangler/`：当前 Linux 的 Wrangler OAuth 授权配置，可在新设备重新登录，授权过期时备份不能代替重新授权。
- `.runtime/releases/` 和 `.runtime/backups/`：多个时间点的 D1 恢复快照。迁移前再导出一份最新生产库，旧发布备份不代表实时状态。
- `.runtime/audits/`：维护记录；必要时保留 `diagnostics/` 中仍需核对的问题。
- 自行修改过的 `~/.config/systemd/user/ai-gateway*` 单元及 drop-in；标准单元已经在 `deploy/systemd/` 中。迁移后仍需重新安装、启用服务和 linger。
- 如需复用 Git SSH 访问权限，安全迁移相应私钥或在新设备创建新密钥并重新授权。

D1 最新导出示例，从项目根目录执行；该操作读取云端生产库，不恢复或覆盖线上数据：

```bash
umask 077
mkdir -p .runtime/backups/manual
cloudflare/node_modules/.bin/wrangler d1 export DB --remote \
  --config cloudflare/wrangler.jsonc \
  --output .runtime/backups/manual/d1-before-device-migration.sql
```

输出文件和导出日志均按私有备份处理。迁移前导出用于兜底；继续使用同一 Cloudflare 账号、Worker 和 D1 时，无须将备份重新导入。

## 云端状态

Cloudflare 中的 Worker、D1、DNS 和隧道资源不会因本机迁移自动丢失。保留账号登录、恢复方式及所需权限。`OPENAI_API_KEY` 当前只持久保存在 Worker Secret，本机没有提供方密钥恢复文件；Wrangler OAuth 配置不是该 Key 的备份。若需在其他 Cloudflare 账号重新搭建，必须准备原始 OpenAI Key，或在提供方新建 Key，并重新配置 Worker Secrets、绑定和域名；不能仅靠代码和 D1 导出恢复全部密钥。

## 可重新生成

`.venv-accounts/`、`node_modules/`、`.ruff_cache/`、各项目 `.wrangler/`、`__pycache__/`、测试输出、普通临时日志、`.runtime/portal-assets/` 和 `release.lock` 都不需要作为迁移必需项；在新设备重建依赖、构建产物和运行锁。不要将本机发布锁当成需要恢复的进程状态。

## 切换检查

先恢复私有配置和隧道凭据，修正 `deploy/cloudflared-api.yml` 中的用户名/绝对路径及 systemd 工作目录，重建依赖并安装 cloudflared。验证网关、内部认证和出站网络后再切换隧道连接器：旧、新连接器同时连接同一隧道可能分摊流量，避免未就绪的新设备接收生产请求。停旧连接器不等于删除云端隧道，不必重建 DNS。

启用用户服务与 linger 的流程见 [可靠性运维](gateway-reliability.md)，隧道恢复见 [隧道文档](tunnels.md)。切换后确认 `/healthz` 的 `openai_transport` 为期望模式，并验证聊天、ASR、PCM 合成及用量结算。迁移本机后实际出口网络可能改变，应重新验证 OpenAI 可用性。

Turnstile 的私有恢复副本 `.runtime/secrets/turnstile.json` 也须随私有备份迁移，权限600，不能提交或公开；包含 Worker 恢复所需的 site/secret 配置，操作见[人机验证运维](human-verification.md#部署与运维)。
