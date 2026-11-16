# 本地运行目录

`.runtime/` 被 Git 忽略，不是源代码目录。目录权限为 700、文件为 600；其中配置、密钥、数据库备份和诊断可能包含私有信息，不要作为静态资源整体上传。

| 路径 | 用途与清理方式 |
|---|---|
| `config/` | 邮件和可选告警接收配置；人工维护，不自动清理 |
| `secrets/` | 邮箱验证码 HMAC 密钥及内部密钥的私有恢复副本；不可随意删除或重新生成 |
| `releases/<UTC时间>-<提交>/` | 成功发布清单、日志和发布前 D1 备份；保留最近 5 次成功发布，以及此前每个日期的最后一次成功发布。本次保留 6 次；目前由人工整理，不自动删除 |
| `backups/manual/*.sql.gz` | 较早手工导出的数据库备份；压缩前后验证 SHA256 一致，原 SQL 已删除；恢复前先解压到私有目录 |
| `tests/browser/`、`tests/clients/` | 浏览器截图、合成诊断和客户端测试音频；测试自动创建，允许覆盖或删除后重建 |
| `diagnostics/<核查日期>/` | 仍有参考价值的请求核查和实际调用验证结果；过时后可删除，不保留测试音频及一次性脚本 |
| `audits/` | 维护结果和本地清理清单；清单仅记录路径和大小，不包含密钥值 |
| `portal-assets/` | 公开网页构建产物，供 Wrangler 使用；可由 `python3 scripts/ops/build_assets.py` 重建，部署前需存在 |
| `release.lock` | 发布进程锁；保留此文件，不在发布运行时删除、移动或替换 |

当前邮件配置路径为 `.runtime/config/mail-config.json`，事务邮件模板为 `.runtime/config/transactional-mail-config.json`。验证码密钥为 `.runtime/secrets/email-code-secret`；配置脚本兼容旧位置的迁移，并在新旧密钥冲突时停止，避免意外轮换。内部恢复副本为 `.runtime/secrets/hilex-worker-secret`；生产本机服务仍使用 `.env` 中的内部凭据，并不读取这个恢复副本。OpenAI Key 持久保存在 Worker Secret，不在此目录中创建副本。

本次删除的是可重建或已过时的验证脚本、散落日志、测试音频、缓存、旧前端/Worker 源码快照、废弃 PID 清单、失败/仅检查发布和多余发布备份。保留最近请求诊断与本机 OpenAI 实测结果，历史文档中的验证结论不依赖临时脚本。

后续操作应将私有配置放入 `config/`、恢复密钥放入 `secrets/`、诊断放入日期子目录，避免继续散落在根目录。发布程序继续使用原 `releases/` 和 `portal-assets/` 路径；无须为目录整理重新部署线上 Worker。

迁移机器时需要额外保存项目 `.env`、未跟踪的客户端 ID、用户目录下的隧道凭据等，见 [设备迁移备份清单](device-migration.md)。
