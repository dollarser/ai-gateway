# 发布与失败恢复

从已提交的干净主分支发布，部署 SHA、源代码和 GitHub 使用同一版本：

```bash
.venv-accounts/bin/python -m scripts.ops.release
.venv-accounts/bin/python -m scripts.ops.release --deploy
```

第一条只检查。正式发布需要 Node.js 22、已安装的 `cloudflare/node_modules`、有效 Wrangler 运维授权及 `.venv-dev` 浏览器环境。可用 `--browser-python /path/to/python` 指定环境。OpenAI 当前继续经本机中继；不要无意传入 `--openai-transport worker`。

脚本先运行 Python、Worker、全部浏览器门禁，再检查部署和迁移。CI 与发布共用 `scripts.ops.check_browsers`，覆盖管理员页面、找回密码、人机验证、换邮箱。检查不向用户发邮件。

## 数据和切换

1. 私有 D1 预备份，校验可恢复性、外键、额度账本。按 `d1_migrations` 检出待执行迁移，在内存 SQLite 预演；保护已有用户 ID、Key ID 和通知已读关联。
2. 构建确定性哈希静态资源；本地存在前一线上提交时保留其哈希资源，供缓存页面继续加载。
3. 有迁移时自动进入维护模式，等待两个公网健康接口确认目标 SHA 和维护状态，再导出正式切换备份并再次预演。无迁移时默认不进入维护；`--maintenance` 可强制启用。
4. 执行待迁移和账本核对。根据前后版本路径判断是否重启源站：Worker/静态改动不重启；Python 网关、运行依赖或 systemd 配置改动才重启。可用 `--restart-origin` 强制。不会重启模型服务。
5. 发布正常 Worker，有限次数重试传播检查；验证双域名 SHA、门户引用及静态文件实际内容、源站就绪和认证边界。

发布使用文件锁避免同机并发。`.runtime/releases/<时间>-<SHA>/` 保存私有备份、分步日志及 `release.json`，不加入 Git。记录包含前后 SHA、迁移列表、重启决策、Worker 版本、当前/失败步骤和维护状态。不要在公开日志中输出备份或凭据。

## 失败处理

测试或预演失败时尚未切换。维护后的迁移失败会保持维护；迁移后正常部署或验证失败会尝试重新启用维护，并记录恢复是否成功。脚本返回失败即停止，不将一次健康请求当作上线成功。

先查看 release.json 和对应步骤日志，确认公网维护状态及 D1 迁移状态，再修正代码并提交，重新执行发布。不同 SHA 接手已处于维护的切换必须显式传 `--resume-maintenance`。维护状态不明时先核验公网，不连续盲发。

**不得将旧 SQL 或旧 SQLite 覆盖上线后 D1**，也不要恢复过期快照覆盖用户新写入。采用向前修复和新增迁移。备份是灾难恢复证据，恢复操作需要单独评估数据边界。
