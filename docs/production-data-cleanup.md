# 生产测试数据清理方法

本手册只记录识别、备份、清理与验证方法，不记录实际邮箱、用户 ID、批次清单或生产库数量。具体执行材料保存在私有备份目录，不进入 Git。

## 1. 确认数据源

生产账号使用 D1。本机 `accounts/data/accounts.db` 是离线兼容或迁移用 SQLite，不代表当前生产状态。先确认授权账号、数据库和绑定：

```bash
cd /home/lingzhang/workspace/ai-gateway/cloudflare
export PATH="$HOME/.local/tools/node/bin:$PATH"
npx wrangler whoami
npx wrangler d1 list --json
```

查询时先列用户名、邮箱、角色、启用状态、创建时间、密钥数量、请求数量和最近使用时间，不直接执行删除。输出含用户信息时按私有材料保存。

## 2. 明确候选规则

以用户确认的命名规则、测试邮箱域、测试脚本来源为依据。邮箱按完整域名规范化匹配，不使用容易误伤的模糊后缀。

没有邮箱、请求为零、已禁用、名称包含 legacy 都不足以证明账号是测试账号。迁移服务账号和客户端账号可能合法存在，需结合权限、密钥和实际使用情况判断。

每次清理重新生成候选集合，记录 ID、完整用户名、创建时间和选择理由。不要重放旧 ID 列表：SQLite INTEGER PRIMARY KEY 的高位 ID 删除后，可能分配给新用户。

确认候选没有正在运行的请求，不涉及唯一有效管理员。活跃测试账号应先停止获取新请求，等待已有请求结束，再清理关联数据。

## 3. 备份并在副本验证

```bash
umask 077
cleanup_backup="../deploy/backups/production-test-cleanup-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$cleanup_backup"
npx wrangler d1 export DB --remote \
  --output "$cleanup_backup/before.sql" \
  > "$cleanup_backup/export.log" 2>&1
chmod 600 "$cleanup_backup/before.sql" "$cleanup_backup/export.log"
```

导出日志可能包含临时下载签名 URL，应与 SQL 一样保密。记录备份 SHA256，在内存 SQLite 或隔离副本中恢复导出，执行 `PRAGMA quick_check`，核对表和关联数量，再演练清理 SQL。不能把备份重灌进正在服务的生产库来验证。

## 4. 按关联关系清理

先保存本次目标密钥 ID、登录族 ID 和保留数据的校验基线，再按依赖顺序处理：

1. 目标密钥的 `legacy_token_baseline`。
2. 先删除目标用户或请求对应的 `luna_usage`，再删除目标用户或密钥的 `requests`。
3. 目标用户的 `sessions`。
4. 目标登录族的 `access_tokens`、`refresh_tokens`。
5. 目标 `auth_families`。
6. 明确属于目标账号、密钥的审计事件。
7. 目标 `keys`。
8. 最后删除目标 `users`，写入一条不含凭证的清理摘要审计。

audit 的 target 可能表示用户 ID、密钥 ID 或其他对象，必须结合 action 判断，不能只按数字相同就删除。清理计划应覆盖无外键约束但有业务关联的表。

IP 级登录尝试、注册尝试、认证失败记录不能仅凭 IP 归属给某个账号，不应全表清空这些共享安全数据。

将新生成、已在副本上验证的 SQL 一次执行并保留私有日志：

```bash
npx wrangler d1 execute DB --remote --file "$cleanup_backup/cleanup.sql" \
  > "$cleanup_backup/execution.log" 2>&1
```

失败后先核对真实状态，不盲目重复执行。不要把备份恢复文件当作清理文件。

## 5. 验证结果

- 本次目标确实不存在，而不是只看总数下降。
- 保留用户和密钥逐字段与清理前基线一致。
- 没有遗留的登录族、token、密钥用量基线等孤儿数据。
- `PRAGMA foreign_key_check` 无结果。
- 删除数量与本次计划一致，正常业务新增数据没有被“修正回”旧数量。
- 账号与 API 健康检查正常；必要时验证已有账号登录与授权。

计划、备份、SQL、日志、哈希和验证报告留在私有目录。报告若包含密码哈希或密钥摘要，同样不能提交到 Git。

## 6. 避免重新积累

默认部署检查使用：

```bash
cd /home/lingzhang/workspace/ai-gateway
.venv-accounts/bin/python -m scripts.smoke.check_deployment
```

该检查不创建账号、密钥或业务请求；未授权探测可能按正常安全策略更新认证失败计数。需要模型列表验证时显式加 `--require-models`，API Key 仅从 `AI_API_KEY` 环境变量读取。

单元测试和 Miniflare 使用隔离数据，不写生产 D1。若必须进行会创建账号的端到端验收，要唯一标记临时账号，在 finally 中按完整身份清理；禁用账号并不等于删除测试数据。

日常发布不能重新导入迁移前快照，否则可能重新带回已清理数据。生产回滚必须先处理上线后的新写入。
