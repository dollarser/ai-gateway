# 本地开发与迁移工具

生产账号只使用 Worker/D1。本地 SQLite 实现保留用于隔离测试、离线兼容和旧数据迁移，不用于线上用户管理。

## 显式启用本地账号

```bash
bash scripts/setup/setup.sh --local-accounts
```

该选项才会创建本地初始管理员凭证文件。默认 setup 只安装网关依赖和准备内部 Client ID，不初始化账号。

本地 `.env` 中设置：

```dotenv
GATEWAY_ACCOUNT_MODE=local
ACCOUNTS_DATA=/absolute/path/to/isolated-dev-data
```

如果使用自定义数据目录，应在初始化时也通过环境变量传入同一 `ACCOUNTS_DATA`，确保 bootstrap 凭证生成在该目录。不要把开发配置写进生产机器正在使用的 `.env`。本地模式会取消 Worker 连接环境变量，并显式传入 `--local-accounts`；直接运行 gateway.run 时也需要这个开关。

```bash
bash scripts/start.sh
```

默认网关入口没有配置 Worker 时会拒绝启动，防止误用历史 SQLite。

## 本地账号 CLI

```bash
.venv-accounts/bin/python scripts/ops/accounts-admin.py bootstrap --local-only
```

所有子命令都要求 `--local-only`。它操作本地 accounts/data，不修改生产 D1；线上账号在 Worker 管理界面处理。

## 离线迁移

- `scripts/migrations/export_d1.py`：从显式 `--source` SQLite 快照导出，写入新的私有文件，目标是新空 D1；不会读取生产 D1。
- `scripts/migrations/migrate_legacy_gateway.py`：经过回归测试的旧 SQLite Key/用量基线迁移工具，需要显式 `--source`、`--target` 离线库和应用选项；不是日常生产管理命令。

这些工具保留是为了兼容原密码哈希、迁移 Key 和额度基线；不能在日常发布时重新导入旧快照。

## 客户端示例的可选依赖

语音客户端需要 numpy、soundfile：

```bash
.venv-accounts/bin/python -m pip install -e '.[clients]'
```

使用 API Key 时不需要后端私有 Client ID 文件。使用登录令牌时通过 `SPEECH_CLIENT_ID` 提供服务约定的 Client ID。
