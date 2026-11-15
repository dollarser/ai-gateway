# 当前 Cloudflare Tunnel 运维

当前部署：`accounts.hilex.me` 为 Worker + D1，无需隧道；`api.hilex.me` 通过 API 隧道连接本机 API 网关。网关对公网的源站端口为 18900，不能将本机免鉴权端口 18901 发布到公网。

## 安装与登录

Linux x86_64：

```bash
mkdir -p "$HOME/.local/bin"
curl -fL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o "$HOME/.local/bin/cloudflared"
chmod 755 "$HOME/.local/bin/cloudflared"
export PATH="$HOME/.local/bin:$PATH"
cloudflared --version
cloudflared tunnel login
cloudflared tunnel list
```

已有有效 cert.pem 时不必重新登录。登录授权时选择要管理的域名；`sunlingzhang.com` 的旧证书不自动拥有 `hilex.me` 的 DNS 写入权限。本次 `hilex.me` 的 API CNAME 由账号持有人在 Cloudflare DNS 控制台配置。

## 当前隧道

- 名称：`ai-gateway-api`
- ID：`d79096c0-61c1-4317-8878-2ed3b79f0417`
- 配置：`deploy/cloudflared-api.yml`
- DNS：`api.hilex.me` CNAME → `d79096c0-61c1-4317-8878-2ed3b79f0417.cfargotunnel.com`，启用代理（橙云）。
- 源站：`http://127.0.0.1:18900`

```bash
cd /home/lingzhang/workspace/ai-gateway
cloudflared tunnel --config deploy/cloudflared-api.yml ingress validate
bash scripts/ops/serve-tunnel.sh api
```

本机当前连接器已运行，不要重复启动。进程记录在 `.runtime/tunnel-processes.json`，日志在 `logs/tunnel-api.log`。本次没有配置开机自启。

## 仅在需要新建时

```bash
umask 077
cloudflared tunnel create ai-gateway-api
```

已有同名隧道时不要重复创建。新建后更新 YAML 中的 ID、私有凭证路径、`deploy/tunnels.json` 和 DNS。若证书已授权相应域名，可使用：

```bash
cloudflared tunnel route dns --overwrite-dns <新隧道ID> api.hilex.me
```

仅丢失凭证时可以恢复原隧道凭证，无需删建：

```bash
cloudflared tunnel token --cred-file "$HOME/.cloudflared/<隧道ID>.json" <隧道ID>
```

## 验证

```bash
curl --fail https://accounts.hilex.me/healthz
curl --fail https://api.hilex.me/healthz
curl -i https://api.hilex.me/v1/models
```

账号健康应包含 `storage: d1`；API 未带凭证应返回 401。已授权请求返回 502 时还需检查模型后端是否启动。Python urllib 的默认 User-Agent 可能触发 Cloudflare 1010，此时检查边缘安全规则，不能误判为隧道掉线。

旧 `ai-gateway-accounts` 连接器已停止，本机不再使用账号隧道；旧资源记录在 `deploy/legacy-tunnels.json`。此前 sunlingzhang.com 两条隧道重建操作见 [历史记录](tunnels-legacy-20261115.md)。

[官方安装](https://developers.cloudflare.com/tunnel/downloads/) · [官方隧道流程](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/)
