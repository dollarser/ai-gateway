> 历史操作记录。当前域名已迁移到 hilex.me，账号已部署 Worker/D1；请使用 [当前隧道文档](tunnels.md)。以下旧账号隧道命令不再执行。

# Cloudflare Tunnel：安装、授权、创建与重建

公网入口由 `ai-gateway` 管理。模型服务仍由独立的 `model-serving` 部署。隧道只转发到网关的 **18900** 端口；18901 是本机免鉴权入口，不配置为公网源站。

## 1. 安装 cloudflared

以下命令适用于当前 Linux x86_64 主机，无需 sudo：

```bash
mkdir -p "$HOME/.local/bin"
curl -fL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o "$HOME/.local/bin/cloudflared"
chmod 755 "$HOME/.local/bin/cloudflared"
export PATH="$HOME/.local/bin:$PATH"
cloudflared --version
```

在 `~/.bashrc` 中保留 `export PATH="$HOME/.local/bin:$PATH"`，新终端即可直接使用。当前主机已从原备份恢复程序，并已完成 PATH 配置，不必重复安装。

[官方安装与各平台下载](https://developers.cloudflare.com/tunnel/downloads/)。

## 2. 登录授权

```bash
cloudflared tunnel login
cloudflared tunnel list
```

打开命令输出的授权链接，登录管理 `sunlingzhang.com` 的 Cloudflare 账号并完成授权。成功后生成 `~/.cloudflared/cert.pem`。该文件用于管理隧道；运行某条隧道使用的是独立的 `<隧道ID>.json`。

本机本次已登录。已存在有效 `cert.pem` 时可以直接使用，不要重复覆盖。凭证、证书和运行 Token 不放入项目仓库。

## 3. 新建隧道

仅首次新建或明确删除重建时执行。普通重启无需再次创建：

```bash
umask 077
cloudflared tunnel create ai-gateway-api
cloudflared tunnel create ai-gateway-accounts
cloudflared tunnel list
```

创建后会在 `~/.cloudflared/` 生成对应的 JSON 凭证。将输出的 ID 和凭证路径写入 `deploy/cloudflared-api.yml`、`deploy/cloudflared.yml`，同步更新 `deploy/tunnels.json`。

若隧道仍存在、仅凭证丢失，可恢复凭证而不删除隧道，例如：

```bash
umask 077
cloudflared tunnel token --cred-file "$HOME/.cloudflared/<隧道ID>.json" <隧道ID>
```

## 4. 本次重建记录（2026-11-15，已完成）

根据用户要求，已删除以下无活动连接的旧隧道：

```bash
cloudflared tunnel delete c676e25c-9be7-430b-9dff-daef15ee9ff3
cloudflared tunnel delete c25403d1-b154-458c-95f5-e82be86be9b7
```

以上删除命令是本次操作记录，不是日常启动步骤。新隧道如下：

| 名称 | 新 ID | 域名 | 配置 |
|---|---|---|---|
| ai-gateway-api | d79096c0-61c1-4317-8878-2ed3b79f0417 | api.sunlingzhang.com | deploy/cloudflared-api.yml |
| ai-gateway-accounts | 4aa254d5-8737-422c-9913-36ae20c3a41b | accounts.sunlingzhang.com | deploy/cloudflared.yml |

两条隧道均转发到 `http://127.0.0.1:18900`。旧元数据与配置保存在本机 `deploy/backups/`；被删除的旧 ID 不能作为回滚隧道继续运行。

## 5. 更新 DNS 与检查规则

以下是当前新隧道的实际路由命令。本次已执行，替换了指向旧隧道的 CNAME：

```bash
cloudflared tunnel route dns --overwrite-dns \
  d79096c0-61c1-4317-8878-2ed3b79f0417 api.sunlingzhang.com
cloudflared tunnel route dns --overwrite-dns \
  4aa254d5-8737-422c-9913-36ae20c3a41b accounts.sunlingzhang.com

cd /home/lingzhang/workspace/ai-gateway
cloudflared tunnel --config deploy/cloudflared-api.yml ingress validate
cloudflared tunnel --config deploy/cloudflared.yml ingress validate
```

## 6. 启动网关与连接器

开发排查时分别在三个终端以前台方式运行：

```bash
cd /home/lingzhang/workspace/ai-gateway
bash scripts/start.sh
```

```bash
cd /home/lingzhang/workspace/ai-gateway
bash scripts/ops/serve-tunnel.sh api
```

```bash
cd /home/lingzhang/workspace/ai-gateway
bash scripts/ops/serve-tunnel.sh accounts
```

`serve-tunnel.sh` 默认启动 API 隧道，可用 `CLOUDFLARED_BIN` 覆盖程序路径。当前本次恢复已将这三个进程以独立会话方式启动；PID 和启动命令在 `.runtime/tunnel-processes.json`，日志为 `logs/gateway.log`、`logs/tunnel-api.log` 和 `logs/tunnel-accounts.log`。它们不依赖当前终端，但本次没有配置开机自启。已有进程运行时不要重复启动；需要停止时，先核对记录的 PID 与实际命令再发送 TERM。

## 7. 验证与故障定位

```bash
cloudflared tunnel info d79096c0-61c1-4317-8878-2ed3b79f0417
cloudflared tunnel info 4aa254d5-8737-422c-9913-36ae20c3a41b
curl --fail https://api.sunlingzhang.com/healthz
curl --fail https://accounts.sunlingzhang.com/healthz
```

本次验证结果：两个域名的 `/healthz` 均返回 200，账号首页返回 200，未授权模型 API 返回 401；两条隧道各有 4 条健康边缘连接。默认 Python urllib User-Agent 曾触发 Cloudflare 1010，使用浏览器 User-Agent 后正常。若遇到 403/1010，应检查 Cloudflare 安全事件/浏览器完整性规则，不能将其误判为隧道离线；本次未更改这些安全规则。

未带登录凭证/API Key 请求 `https://api.sunlingzhang.com/v1/models` 应返回 401。这说明公网 API 鉴权入口有效，不代表所有模型已经加载。模型进程和公开权重由 `model-serving` 另外恢复与启动。

隧道连接成功但源站不可达时，检查本机 18900 和网关日志；域名解析仍指向旧隧道时检查 DNS/CNAME。本次使用 HTTP/2 连接器协议，配置中已显式指定。

## 8. 账号迁到 Worker 后

账号 Worker/D1 本次尚未发布。发布并验证账号 Worker 后，将 `accounts.sunlingzhang.com` 绑定 Worker Custom Domain，停止账号隧道，并移除其旧 CNAME；API 隧道继续指向本机 API 网关。网关通过 `ACCOUNTS_WORKER_URL` 调用 Worker，不经账号隧道。详见 [Worker/D1 部署](cloudflare.md)。

[官方本地管理隧道流程](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/)。
