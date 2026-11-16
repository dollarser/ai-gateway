# 部署、授权与运维经验

本文记录 2026-11-15 从旧项目恢复、拆分并部署到 hilex.me 的实际经验。日期、版本、套餐和数据量均为当次观测；资源位置以 `deploy/hilex.json` 和当前 Cloudflare 配置为准。

## 1. 先区分项目职责与真实数据源

| 部分 | 当前职责 | 运行位置 |
|---|---|---|
| 账号网页、登录、API Key、权限和额度 | 账号业务 | accounts.hilex.me，Worker `hilex-accounts` |
| 账号持久化、请求占用与用量 | 生产数据 | D1 `hilex-accounts`，绑定 `DB` |
| HTTP/SSE/WebSocket、模型发现和协议适配 | API 网关 | 本机 Python，通过 api.hilex.me 隧道访问 |
| 模型加载、GPU、推理队列 | 模型部署 | 独立的 model-serving 项目 |

账号部署到 Worker 不等于 GPU 推理部署到 Worker。账号域名直接绑定 Worker Custom Domain，不再需要账号隧道；本机 API 网关仍需要一个对外访问通道。

当前 `.env` 中启用了 `ACCOUNTS_WORKER_URL`。此时本地账号路由关闭，不再使用 SQLite；`accounts/data/accounts.db` 只是迁移前快照。通过本地 `accounts-admin.py` 改旧库不会改变线上账号，不能用它判断生产数据是否已清理。

模型 Client ID 是网关到后端的内部服务凭据，与用户 access_token、API Key、Worker 内部 Secret 不同。拆分时要保留这个服务边界，不能把账号数据带进模型项目。

## 2. 身份认证成功不代表所有操作都已授权

| 凭证或工具 | 能解决什么 | 本次确认的限制 |
|---|---|---|
| cloudflared 的 cert.pem | 管理授权账号/域名下的隧道与相应路由 | 为旧域名登录的证书不自动具备新域名 DNS 写入权限 |
| 单隧道 JSON / Token | 启动某一条隧道的连接器 | 不等于 Worker/D1 管理授权 |
| Wrangler OAuth | 部署 Worker、操作 D1 与已授权资源 | 本次默认权限不包含直接修改 hilex.me DNS 记录 |
| GitHub 应用连接 | 在应用安装和授权范围内访问仓库 | 能读用户资料、看到仓库，不代表集成能写该仓库 |
| Git SSH 私钥 | 以对应 GitHub 身份操作 Git 远端 | 仍要实际验证目标仓库的读写权限 |

遇到 403 先确认是哪一个身份、哪一类资源、哪个操作失败。不要因为 `whoami` 或 GitHub profile 成功，就认定 DNS、Contents API 或 Git push 都可用。

### 远程机器上的 Wrangler 登录

```bash
cd /home/lingzhang/workspace/ai-gateway/cloudflare
export PATH="$HOME/.local/tools/node/bin:$PATH"
npx wrangler login --device --browser=false
npx wrangler whoami
```

设备授权避免远程服务器无法接收用户电脑 localhost 回调的问题。授权码短期有效；授权过期时重新发起，不复用旧码。成功后不需要反复登录。

### GitHub 写入排查

```bash
ssh -T -i "$HOME/.ssh/<你的密钥>" -o IdentitiesOnly=yes git@github.com
git ls-remote git@github.com:dollarser/ai-gateway.git
```

SSH 测试应显示预期 GitHub 用户。`ls-remote` 只能说明远端可访问，真正写入仍以 push 结果为准；空仓库成功查询也可能没有任何 refs 输出。本次已通过 SSH 完成推送，后续核对本地 HEAD 与远端 main，而不是只看提交命令成功。

私钥与 OAuth 凭证都保存在本机私有位置。项目 `.git/config` 可以保存密钥路径，不保存密钥内容；它不会随 Git 提交上传。

## 3. 首次迁移与日常更新必须分开

首次迁移顺序：

1. 确认账号、域名与资源授权，创建新空 D1。
2. 配置 `database_id`、`DB` 绑定、账号 origin 和 Worker 域名，应用 schema。
3. 暂停旧账号/API 写入，确认没有进行中的请求，再取得一致性快照。
4. 导出并导入数据，核对用户、密钥、请求数量及外键关系。
5. 设置 Worker Secret 和网关对应环境变量，发布 Worker。
6. 验证 Worker 后切换网关与域名，最后停止旧账号隧道。
7. 用临时账号验证注册、登录、鉴权与用量写入，随后清除该账号及关联数据。

日常更新只部署代码并应用新增的 schema migration，不重复导入旧快照。部署完成后的新数据已经以 D1 为准，旧 SQLite 不能直接作为生产回滚来源。

迁移和清理的具体数据只保存在私有执行报告。公共文档不记录用户明细或生产规模；后续不得用旧快照数量覆盖新业务数据。方法见 [生产数据清理](production-data-cleanup.md)。

## 4. 实际踩过的问题

| 现象 | 实际原因 | 处理方法 |
|---|---|---|
| `cloudflared: command not found` | 新机器未恢复程序，或 PATH 不含用户 bin | 检查安装路径、执行版本命令，再配置 PATH；不是先重建隧道 |
| cloudflared 登录后仍不能部署 Worker | 两套授权相互独立 | 另行完成 Wrangler 登录 |
| 本地仓库 commit 成功，push 失败 | 命令行 Git 没有身份凭据 | 验证 SSH 身份、目标仓库和远端，再推送 |
| GitHub 连接读取成功，写入返回 403 | 集成写入范围不足 | 检查应用授权；本次改用已授权 SSH 身份 |
| D1 创建命令拒绝 `--json` | 当前 create 子命令不支持该选项 | 先看该子命令 `--help`，不要把 list 的参数套到 create |
| Worker 发布返回 100328 | Workers Free 不支持配置自定义 `cpu_ms` | 删除不支持的配置后实测；不自动升级套餐 |
| 默认 Python urllib 返回 403/1010 | Cloudflare 边缘规则对该请求头的拦截 | 对比浏览器/curl、健康接口和安全事件，区分边缘拦截与源站故障 |
| D1 REST 查询传数组返回 400 | 该 REST 调用要求单个 `{sql, params}` 对象 | 使用实际接口格式；不要与 Worker 的 `env.DB.batch()` 混淆 |
| 隧道已有连接，但请求返回 502 | 源站或模型后端不可达 | 分别检查连接器、本机网关和模型，不重建数据库或隧道碰运气 |

本次移除 Free 不支持的 CPU 配置后，真实注册与登录已验证通过。这只证明当次流量和实现可运行，不意味着所有压力下都不会遇到 CPU 限额。

## 5. 验证应分层进行

| 检查 | 预期结果 | 可以证明什么 |
|---|---|---|
| 账号 `/healthz` | 200，含 `storage: d1` | Worker 能访问 D1 |
| 账号首页 | 200 | 域名、静态资源和页面入口可访问 |
| 正确账号登录、`/account/me` | 200 | 密码兼容、令牌签发与验证有效 |
| 网关 `/healthz` | 200 | API 域名与网关可访问 |
| 未授权 `/v1/models` | 401 | 公网鉴权入口未被绕过 |
| 有效凭证调用模型 API | 后端就绪时正常响应 | 网关到模型的链路可用 |
| 用量页面出现该次请求 | 状态、计数合理 | 账号服务与网关共享 D1 用量数据 |

本次模型后端没有启动，有效凭证已被放行，随后模型 API 返回 502，且 D1 正确记录了该状态。这验证了鉴权和记账，不能写成“模型推理测试通过”。

Worker 本地 Miniflare/D1 测试验证逻辑；生产域名测试验证真实部署、绑定和权限，两者都需要。纯文档变化无需重复运行 GPU 或模型测试。

## 6. 记录结果，不记录秘密

可提交：代码、schema、非秘密资源 ID、域名、操作流程、聚合统计与验证结论。

不提交：私钥、cert.pem、隧道凭证、API Token、内部 Secret、`.env`、真实账号库、迁移 SQL、生产备份和含凭证摘要的逐行报告。

Wrangler 导出会打印有时效的下载签名 URL。完整导出日志也按敏感材料保存，不能复制进公共文档、Issue 或聊天记录。备份文件权限使用 600、目录使用 700；`.gitignore` 只是排除提交，不能替代文件权限。

## 7. 长期运行的边界

当前本机网关和 API 隧道由 systemd 用户服务管理并自动重启，启用 linger 后可在无人登录时启动。使用 `systemctl --user status ai-gateway.service ai-gateway-tunnel.service` 查看状态，使用 journalctl 查询日志，详见 [可靠性运维](gateway-reliability.md)。旧会话 PID 清单已废弃并清理，不得重放历史 PID 的 kill 命令。Worker 已发布不代表本机网关、隧道和 GPU 服务一定可用，应分别检查。

## 相关手册

- [Worker / D1 部署](cloudflare.md)
- [隧道安装与运行](tunnels.md)
- [生产测试数据清理](production-data-cleanup.md)
- [备份恢复与目录迁移](backup-restore-lessons.md)
