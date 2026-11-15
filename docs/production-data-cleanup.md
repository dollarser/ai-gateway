# 生产测试账号清理手册

本文记录 2026-11-15 对 hilex-accounts 生产 D1 的一次清理，以及可复用的方法。当前业务继续运行，文中的数量是当时快照，不是以后每次清理的目标值。

## 1. 本次清理范围与结果

纳入范围：

- 用户明确要求清理的 `smoke` 账号及 `@example.com` 测试邮箱。
- 已通过测试脚本核实、已禁用的 `dual-auth-<时间戳>` 和 `domain-ws-<时间戳>` 账号。
- 对应的密钥、登录凭证、请求记录与能够明确归属的测试审计数据。

真实邮箱用户、管理员、`legacy-api-key-*` 迁移业务账号、持续使用的客户端服务账号保留。不能因为邮箱为空、请求为零、被禁用或名称含 legacy 就直接判为测试账号。

| 表/数据 | 清理前 | 清理后 | 说明 |
|---|---:|---:|---|
| users | 56 | 24 | 删除 32 个测试账号 |
| keys | 27 | 6 | 删除 21 个测试密钥 |
| requests | 3,296 | 3,167 | 删除 129 条测试请求 |
| sessions | 3 | 1 | 删除关联 Cookie 会话 |
| auth_families | 118 | 97 | 删除关联登录族 |
| access_tokens | 246 | 219 | 删除关联 access token 摘要 |
| refresh_tokens | 246 | 219 | 删除关联 refresh token 摘要 |
| legacy_token_baseline | 15 | 15 | 业务基线保持不变 |
| audit | 252 | 126 | 删除 127 条可归属的测试审计，新增 1 条清理摘要 |

验证：保留用户行和保留密钥行逐字段与清理前一致，外键检查通过，账号与 API 健康接口均为 200。私有备份和报告在 `deploy/backups/production-test-cleanup-<UTC时间戳>/`，未进入 Git。

## 2. 先定位真实生产库

当前生产是 D1，不是本机 `accounts/data/accounts.db`。先检查 Worker 配置、D1 名称和绑定，再进行只读盘点：

```bash
cd /home/lingzhang/workspace/ai-gateway/cloudflare
export PATH="$HOME/.local/tools/node/bin:$PATH"
npx wrangler whoami
npx wrangler d1 list --json
npx wrangler d1 execute DB --remote --command \
  'SELECT count(*) AS users FROM users;'
```

下面查询只列候选，不执行删除：

```sql
SELECT u.id, u.username, u.email, u.role, u.enabled, u.created,
       (SELECT count(*) FROM keys k WHERE k.user_id=u.id) AS key_count,
       (SELECT count(*) FROM requests r WHERE r.user_id=u.id) AS request_count,
       (SELECT max(started) FROM requests r WHERE r.user_id=u.id) AS last_request
FROM users u
WHERE lower(u.username) LIKE '%smoke%'
   OR lower(coalesce(u.email,'')) LIKE '%@example.com'
   OR lower(u.username) LIKE '%@example.com'
ORDER BY u.id;
```

邮箱域名要按规范化后的完整域判断。`@example.com` 是本次明确指定的测试域；不要扩展为删除其他邮箱或“看起来不常用”的用户。其他命名规则必须结合脚本来源、权限、使用情况及用户指令判断。

只读盘点输出也包含用户信息，应保存在私有材料中，不把完整真实邮箱列表提交到公共仓库。

## 3. 形成本次清理计划

每次重新生成计划，记录：

1. 库名、时间、规则、候选账号的 ID、用户名和创建时间。
2. 密钥、请求、会话、登录族和 token 的关联数量。
3. 所有保留用户和密钥的校验基线，确认业务账号不会进入范围。
4. 候选是否存在未完成请求，是否涉及唯一有效管理员。

本次候选均已禁用、没有进行中的请求。若有活跃测试账号，要先使其不可继续申请新请求，再等待已有请求结束；不能在流式请求运行中直接删除其占用与凭证。

**不要重复执行旧清理文件里的 ID 列表。** 当前账号 ID 是 SQLite INTEGER PRIMARY KEY，被删除的高位 ID 后续可能分配给新用户。旧文件仅作审计；新的删除集合必须重新核对 ID、用户名、创建时间和当前用途。

## 4. 先做完整备份，并实际验证可读

```bash
cd /home/lingzhang/workspace/ai-gateway/cloudflare
umask 077
cleanup_backup="../deploy/backups/production-test-cleanup-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$cleanup_backup"
npx wrangler d1 export DB --remote \
  --output "$cleanup_backup/before.sql" \
  > "$cleanup_backup/export.log" 2>&1
chmod 600 "$cleanup_backup/before.sql" "$cleanup_backup/export.log"
```

导出日志可能包含临时下载签名 URL，和 SQL 一样按敏感文件处理。本次额外做了：

- 记录备份 SHA256。
- 在内存 SQLite 中恢复完整导出，执行 `PRAGMA quick_check`。
- 对照清理前 users、keys、requests 数量。
- 在该内存副本执行待清理 SQL，检查结果及 `PRAGMA foreign_key_check`。

备份不是当前生产库；验证副本时不要把导出重灌进正在服务的生产库。

## 5. 按关联顺序清理

本次将最终选择出的账号集合编译为一次性 SQL 文件，并在副本上验证后通过 D1 remote execute 执行。顺序为：

1. 先取得目标密钥 ID 和登录族 ID；后续删除会改变这些子查询结果。
2. 删除目标密钥的 `legacy_token_baseline`。
3. 删除目标用户/密钥的 `requests`。
4. 删除目标用户的 `sessions`。
5. 删除目标登录族的 `access_tokens`、`refresh_tokens`。
6. 删除目标 `auth_families`。
7. 清理明确属于测试账号/测试密钥的 audit。
8. 删除目标 `keys`，最后删除目标 `users`。
9. 写入一条清理摘要审计，不记录原始密钥或密码。

审计的 target 是文本，可能代表用户 ID、密钥 ID 或其他对象。**不能只凭 target 的数字与用户 ID 相同就删除审计。** 本次结合 action 类型区分用户事件和密钥事件，同时处理测试 actor；否则会误删同号业务对象的审计。

IP 级登录/注册尝试、认证失败记录不能仅凭 IP 归属给某个测试账号。本次没有全表清空这些共享安全数据，保留既有过期清理策略。

实际执行使用新生成、已在副本验证的文件：

```bash
npx wrangler d1 execute DB --remote --file "$cleanup_backup/cleanup.sql" \
  > "$cleanup_backup/execution.log" 2>&1
```

不要把备份恢复文件当作清理文件；失败后先查看私有执行日志并核对真实状态，不盲目重复执行。

## 6. 执行后验证

必须同时检查：

- 本次候选已不存在，而不是只看总账号数变少。
- 保留用户及密钥与计划基线逐字段一致，包括权限、启用状态和凭证摘要。
- 密钥、登录族、token、用量基线等没有遗留孤儿记录。
- `PRAGMA foreign_key_check` 无结果。
- 删除数量与计划一致；正常业务期间新增的数据不能被“修正回”旧数量。
- 账号 `/healthz`、API `/healthz` 正常；需要时验证保留账号登录和 API 认证。

将计划、SQL、执行日志、备份哈希和结果报告留在私有备份目录。报告中若包含保留用户密码哈希或密钥摘要，同样不能提交到 Git。

## 7. 防止再次积累

生产端到端验证应创建可唯一归属的临时账号，记录其 ID、完整用户名和创建时间，并在 finally 中清理。禁用账号不等于删除测试数据。

本地单元测试和 Miniflare 测试应使用隔离数据，不写生产 D1。历史 smoke 脚本包含本地 SQLite 操作，不能在 Worker 生产模式下直接用于准备线上测试账号；先确认脚本实际写的是哪一个库。

恢复旧数据库或重新导入迁移前 SQL 会把已清理账号带回来。日常发布不能重新导入初始快照；生产回滚要先处理切换后的真实数据。
