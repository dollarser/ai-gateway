# API 边缘直连与语音路径

`api.hilex.me/*` 由账号 Worker 的 Route 接入，底层 DNS 继续保留已有 Tunnel CNAME，作为受保护的本机源站。账号域名仍为 accounts.hilex.me。客户端域名、凭证、模型 ID 和请求格式保持兼容。

## 调用链

| 请求 | 实际路径 | 是否需要本机 |
|---|---|---|
| GPT-6 Luna 文本 / Responses / SSE | 客户端 → Worker/D1 → OpenAI | 否 |
| 云模型列表 | 客户端 → Worker/D1 | 否 |
| PCM 流式或非流式合成 | 客户端 → Worker/D1 → OpenAI Realtime | 否 |
| WAV 合成 | 同上，Worker 为 PCM 添加准确 WAV 头 | 否 |
| 16-bit PCM WAV 识别 | Worker 校验实际帧数 → 预留日时长 → OpenAI | 否 |
| MP3/M4A/WebM 等压缩输入识别 | Worker → 私有编解码源站解码一次 → Worker → OpenAI | 仅解码 |
| MP3/Opus/FLAC 合成输出 | Worker → OpenAI → 私有编解码源站编码一次 → 客户端 | 仅编码 |
| 自建 Qwen/Embedding/ASR/TTS | Worker 鉴权 → Tunnel → 本机模型 | 是 |

因此云端文本和 PCM/WAV 语音不再经过本机，也没有本机 → Worker 的逐请求鉴权往返。压缩格式保持兼容，编解码仍依赖本机，不能把“语音已迁到 Worker”理解为所有格式都已完全脱离源站。Worker Free 不适合运行重型 FFmpeg；本次没有升级付费套餐或引入第三方编解码服务。

新客户端建议录制 16kHz、单声道、16-bit PCM WAV，合成播放选择 stream=true,response_format=pcm；现有默认 MP3 仍可用，但多一次编码回源。PCM WAV 直传支持 8–48kHz、单/双声道，按数据帧数计量；不信任容器内声明的时长，更不信任客户端上报 duration。其他格式由受限 FFmpeg 实际解码后再计量。21 MiB / 5 分钟 / 每日 30 分钟的限制保持。

## 鉴权、额度与结算

Worker 直接验证凭证、Client ID、权限、RPM/日请求/并发，再预留模型额度和调用 OpenAI。响应流结束或取消时直接在 D1 结束请求，占用和模型额度没有因跳过本机而绕过。输出 X-Inference-Execution: edge 和 X-Request-ID，可用于客户端确认路径及定位；首包时间仍受 OpenAI 生成、网络和 D1 响应影响，不能承诺固定延迟。

账号 access_token 的 Client-ID 白名单保存在 Worker Secret `INFERENCE_CLIENT_IDS`。与本机私有 deploy/client_ids.json 同步：

```bash
.venv-accounts/bin/python -m scripts.ops.sync_worker_client_ids
```

不要把 ID 列表写入公开 wrangler.jsonc 或交接文档。轮换时同步 Worker，API Key 鉴权仍不要求 Client ID。

## 保护回源

本机配置 GATEWAY_EDGE_ONLY=1；18900 只接受具备 INTERNAL_SECRET 对应服务凭证的 Worker 请求。客户端伪造的 X-Edge-*、Authorization、Cookie 等不会作为内部授权原样转发。Worker 给回源请求附加私有 lease 和请求 ID，本机不再重复发起账号授权。公网无法通过 `/__codec/decode` 或 `/__codec/encode` 直接使用编解码服务。

HTTP 回源的请求结算由 Worker 负责；自建 WebSocket 仍由本机在连接结束后回报结算。18901 继续是回环免认证开发入口，绝不能加入 Tunnel。

Worker Route 的 fetch 到相同路由域名进入原源站，不再次运行此 Route；账号域名的 Custom Domain 保持独立。不要把 API Route 改成同名 Custom Domain 后继续假设同样的回源语义。[Cloudflare 路由说明](https://developers.cloudflare.com/workers/configuration/routing/routes/)

## 本地模型目录

默认 LOCAL_MODELS_ENABLED=false，避免云目录依赖未启动的本机模型。开启后仅对具备 qwen 权限的调用异步刷新本地模型目录，并缓存 30 秒；首次请求可能只有云模型，后续才显示已启动的本地模型。刷新失败不阻塞云模型发现。直接指定已配置本地模型仍可转发，不受目录缓存影响。

## 发布与回滚

先测试、同步私有 Client IDs、部署源站编解码及边缘凭证支持，再部署 Worker API Route。正常客户端继续使用 api.hilex.me。Worker/D1 账号与模型额度始终是权威来源。

回滚需一起处理 API Route 与 GATEWAY_EDGE_ONLY：先恢复旧本机鉴权配置并重启，再移除 API Worker Route，使 Tunnel 重新直达旧网关。不要在源站仍要求边缘凭据时直接删除 Route，否则全部原接口会返回 401。回滚不重新导入数据库或重置账号额度。

## 本次验证

通过 155 项 Python 测试及 26 项 Worker/Miniflare 测试。线上使用临时账号验证了账户 token + Client ID 直接调用 Luna、PCM 流式和 WAV 合成、PCM WAV 识别、MP3 输出和压缩输入的私有编解码回源，并核对实际扣额。对应云端直接请求未进入本机模型网关日志，受保护的自建 WebSocket 仍正确返回上游停机 503。验证账号和相关数据已清理。
