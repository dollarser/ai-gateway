# 两项目设备备份与恢复

## 备份内容与位置

S3 挂载目录：`/mnt/waylens-genai-shanghai-backup/lingzhang`。

- `project-backups/<UTC时间>/projects.tar.gz.enc`：加密的完整项目及相关本机配置。
- 同目录 `.enc.hmac`：验证密钥和完整性；`backup-receipt.json` 包含 SHA256 和 S3 回读校验结果。
- 同目录 `restore_device.py` 与本文：恢复工具和操作说明，无需旧设备。
- 恢复密钥：`project-backup-recovery/<相同UTC时间>.key`；确切路径也写在备份目录的 `RECOVERY-KEY-LOCATION.txt`。

按用户要求，恢复密钥也保存在 S3，而非仅留在即将到期的机器。具备备份包和密钥读取权限的人可以恢复其中全部凭据；两个前缀均应仅供受信任账号访问。不要把该目录设为公开，也不要将私钥内容发到聊天或 Git。

加密方式为 OpenSSL AES-256-CBC、PBKDF2-SHA256（600000 次），并对密文计算独立域派生的 HMAC-SHA256。恢复工具先验证 HMAC 再解密，不接受已有目标目录，不会启动服务或导入线上数据库。

归档包括：两个项目全部现有文件（含未提交源码、Git 元数据、vendor、模型现有文件、虚拟环境、node_modules、私有配置、历史备份）、刚导出的 D1 快照、通过 SQLite backup API 生成的本机账号库快照；用户目录中的 Cloudflare 授权、隧道凭据、相关 Git SSH 私钥、存在的 AWS 配置/静态凭据、实际 systemd 单元、cloudflared 和 Node.js 便携安装。排除 Python/Ruff/pytest 缓存、运行锁和 SQLite 临时 sidecar，不保存旧进程 PID 作为运行状态。

本机未安装的 GPU 环境和未下载的公开权重不可能由备份补齐。当前 `model-serving` 已是恢复源码状态，完整备份它的现有资源与重建说明，不承诺在不同 GPU 上无需适配即可推理。实例 IAM 角色提供的短期 AWS 凭据不是可长期迁移的授权；新设备访问 S3 仍需配置有效 AWS 权限。Worker、D1、DNS、隧道和 Worker Secrets 保留在现有 Cloudflare 账号，不因实例到期而消失。

## 1. 从 S3 获取并解包

新设备先配置对上述 S3 前缀的访问权限；如果没有同名挂载，将对象下载到本机私有目录。下面路径替换为实际备份时间和文件所在位置：

```bash
umask 077
# BUNDLE_DIR 为下载后的备份目录；KEY 为单独下载的恢复密钥。
BUNDLE_DIR="$HOME/private-backup/<UTC时间>"
KEY="$HOME/private-backup/<UTC时间>.key"
chmod 600 "$KEY"
python3.12 "$BUNDLE_DIR/restore_device.py" \
  --bundle "$BUNDLE_DIR/projects.tar.gz.enc" \
  --key "$KEY" \
  --destination "$HOME/recovered-projects"
```

需要 Python 3.12+、OpenSSL，以及足够存放解密归档和解包文件的磁盘空间。不要将恢复目录放入公开共享目录。错误密钥或损坏的密文会在解密前失败。恢复包中 `manifest.json` 记录原机器和源代码状态，`database/d1-latest.sql` 是本次 D1 快照。

## 2. 安装到新用户目录

先确认目标目录不存在。不要用下列命令覆盖已经运行的项目或已有凭据；有旧目录时先人工核对：

```bash
RECOVERY="$HOME/recovered-projects"
mkdir -p "$HOME/workspace"
test ! -e "$HOME/workspace/ai-gateway"
test ! -e "$HOME/workspace/model-serving"
cp -a "$RECOVERY/projects/ai-gateway" "$HOME/workspace/"
cp -a "$RECOVERY/projects/model-serving" "$HOME/workspace/"
# 如目标授权目录已存在，停止并核对，不直接覆盖。
test ! -e "$HOME/.cloudflared" && cp -a "$RECOVERY/home/.cloudflared" "$HOME/"
mkdir -p "$HOME/.config" "$HOME/.ssh"
test ! -e "$HOME/.config/.wrangler" && cp -a "$RECOVERY/home/.config/.wrangler" "$HOME/.config/"
# 按需恢复 home/.ssh/hij_pem_rsa；不要覆盖其他设备已有私钥。
```

凭据目录建议 700、私钥/授权文件 600。新用户名不同时修正 `deploy/cloudflared-api.yml` 的 credentials-file、本机 `.env` 和 Git `core.sshCommand` 中的旧 `/home/lingzhang` 路径。服务默认工作目录为 `%h/workspace/ai-gateway`。不要将原 `/data/backup` 软链接照搬为失效链接；归档保存的是两个项目真实文件。

`home/.local/bin/cloudflared` 和 `home/.local/tools/` 含原 Linux x86_64 工具，可复制到新用户对应目录；把 Node 的 `node` 软链接重新指向新用户目录里的实际版本目录。其他系统/架构应重新安装相应版本，而非运行旧二进制。`.gitconfig`、AWS 配置及自定义 systemd 单元可按需核对恢复，不自动覆盖新设备的已有设置。

## 3. 重建或验证依赖

归档保留了旧环境以便同平台快速恢复，但 venv、可编辑安装和 native 模块可能含旧绝对路径；跨设备建议重建。安装 Python 3.12、Node.js 22+、cloudflared、Git、FFmpeg（按模型需要），然后：

```bash
cd "$HOME/workspace/ai-gateway"
# 确认不再需要旧 venv 后，将其移走，再创建新环境。
mv .venv-accounts .venv-accounts.from-backup
python3.12 -m venv .venv-accounts
.venv-accounts/bin/python -m pip install -r requirements/gateway.lock
.venv-accounts/bin/python -m pip install --no-deps -e .
# 使用新设备 Node.js 重建工具依赖。
npm --prefix cloudflare ci
python3.12 scripts/ops/build_assets.py
```

模型部署按 `model-serving/README.md`、`RESTORE_PUBLIC_MODELS.csv` 和 `scripts/setup/environments.sh` 重建所需 Python 3.10/3.12 环境与权重。私有启动参数和 Client ID 已在归档，不要用示例配置覆盖。

## 4. 恢复服务与切换

- `.env` 中 Worker 地址与内部密钥必须保持对应；OpenAI Key 仍由 Worker Secret 持有，本机不需要重新填写。
- 使用同一 Cloudflare 账号继续访问原 Worker/D1，不要为普通设备迁移重新导入 `d1-latest.sql`、创建 D1 或重建隧道。该 SQL 是灾难恢复快照，导入会影响数据，不能当启动步骤。
- `wrangler whoami` 检查操作授权，过期时重新登录。隧道 JSON 可继续运行原隧道；`cert.pem` 为管理授权。
- 先验证本机网关和 OpenAI 出站网络，切换前停止旧设备的隧道连接器，避免旧、新设备分流到尚未准备好的服务。

```bash
cd "$HOME/workspace/ai-gateway"
bash scripts/ops/install-user-services.sh
loginctl enable-linger "$USER"
# 确认私有配置、依赖和网络已经准备好，再启动。
systemctl --user start ai-gateway.service
# 停止旧机器隧道后启动新连接器。
systemctl --user start ai-gateway-tunnel.service ai-gateway-auth-check.timer
systemctl --user status ai-gateway.service ai-gateway-tunnel.service
```

如 enable-linger 需要管理员权限，按新设备的权限配置处理。最后检查公网 healthz 的 `openai_transport=local`，以及登录、模型列表、聊天流、ASR、PCM 合成和额度结算。迁移前旧机器的本机模式已验证成功，但新机器出口网络必须重新验证；也可暂时部署 `--openai-transport worker`，不能保证其地区可用性。

## 重新生成备份

```bash
cd "$HOME/workspace/ai-gateway"
.venv-accounts/bin/python -m scripts.ops.backup_device \
  --destination /mnt/waylens-genai-shanghai-backup/lingzhang/project-backups
```

每次使用新的 UTC 时间目录，不覆盖已有备份。完成前会进行 D1 恢复校验、加解密一致性校验、S3 备份文件及恢复密钥回读校验；成功以 `backup-receipt.json` 为准。中断后未写成功回执的目录不能视为已完成备份。不要仅因本机打包结束就销毁旧设备。
