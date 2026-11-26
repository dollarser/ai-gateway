# 本地开发

账号、认证与额度使用 Worker/D1。本机只运行推理网关和后端服务。

```bash
bash scripts/setup/setup.sh
bash scripts/start.sh
```

启动网关前配置 `ACCOUNTS_WORKER_URL` 和 `ACCOUNTS_WORKER_SECRET`。隔离开发可使用本地 Wrangler 和测试 D1；网关允许账号 Worker 使用 localhost HTTP。账号管理及邮箱流程以 Worker 接口为准。

## 客户端示例的可选依赖

语音客户端需要 numpy、soundfile：

```bash
.venv-accounts/bin/python -m pip install -e '.[clients]'
```

使用 API Key 时不需要后端私有 Client ID 文件。使用登录令牌时通过 `SPEECH_CLIENT_ID` 提供服务约定的 Client ID。



完整浏览器门禁：`.venv-dev/bin/python -m scripts.ops.check_browsers`。与 CI 使用同一入口，覆盖管理员隔离、找回密码、人机验证和换邮箱；测试拦截邮件及账号请求，不向真实用户发信。
