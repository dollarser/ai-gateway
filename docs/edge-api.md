# API 边缘认证与可选 OpenAI 出站路径

`api.hilex.me/*` 由账号 Worker 的 Route 接入，底层 DNS 继续保留已有 Tunnel CNAME，作为受保护的本机源站。账号域名仍为 accounts.hilex.me。客户端域名、凭证、模型 ID 和请求格式保持兼容。

## OpenAI 出站模式

生产默认 `OPENAI_TRANSPORT=local`：客户端 → Worker（认证、限频、预留额度）→ Tunnel → 本机私有转发 → OpenAI → Worker（流式处理、结算）→ 客户端。覆盖 Chat Completions、Responses、ASR HTTP/SSE 和 Realtime 合成；合成的 Realtime 协议及 PCM 转换仍由 Worker 控制。本机仅转发，不再次查询 D1，不改变客户端协议和额度。

保留 `OPENAI_TRANSPORT=worker`：Worker 直接请求 OpenAI；下面表格描述此模式。两种模式都不会自动失败重试或切换出口，避免重复生成和计费。`GET https://api.hilex.me/healthz` 的 `openai_transport` 字段可确认部署模式。

```bash
# 常规发布默认采用 cloudflare/wrangler.jsonc 的配置（目前 local）
.venv-accounts/bin/python -m scripts.ops.release --deploy
# 显式选择本机或保留的 Worker 直连模式
.venv-accounts/bin/python -m scripts.ops.release --deploy --openai-transport local
.venv-accounts/bin/python -m scripts.ops.release --deploy --openai-transport worker
```

部署参数只覆盖本次发布；要持续保留模式，应修改并提交 wrangler.jsonc 的 `OPENAI_TRANSPORT`。直接 Wrangler 部署也可传 `--var OPENAI_TRANSPORT:worker`。旧配置缺省值为 worker，未知值拒绝调用。

本机必须运行当前版本网关及 cloudflared，设置 `GATEWAY_EDGE_ONLY=1`，且 `ACCOUNTS_WORKER_SECRET` 与 Worker `INTERNAL_SECRET` 一致。`/__openai/v1/*` 仅允许固定 OpenAI 路径；拒绝公网用户凭证、错误内部密钥和非回环连接，不提供任意 URL 转发。HTTP、multipart、SSE、WebSocket 保持流式；提供方错误码原样返回给 Worker 统一处理。网络结果未知保留预留用量，不伪装成提供方明确拒绝而退款。

OpenAI 密钥仍持久存于 Worker Secret，本机只短暂在内存使用。OpenAI 出站仅构造必要请求头，不携带用户凭据、IP 转发头或内部密钥。local 模式增加本机可用性依赖；实际出口由本机网络决定，不保证上游地区判定一定通过。旧 Worker 参考出口诊断不适用于 local 模式，自动抽样停用，手动 Worker 探测不能代表本机 OpenAI 出口。

2026-11-17（日本时间）生产验证：local 模式下流式聊天、PCM 流式合成及 ASR 均返回 200；测试预留已完成结算，临时账号已移除。此结果仅代表本次验证的本机网络路径。

## worker 模式调用链

| 请求 | 实际路径 | 是否需要本机 |
|---|---|---|
| GPT-6 Luna 文本 / Responses / SSE | 客户端 → Worker/D1 → OpenAI | 否 |
| 云模型列表 | 客户端 → Worker/D1 | 否 |
| PCM 流式或非流式合成 | 客户端 → Worker/D1 → OpenAI Realtime | 否 |
| 16-bit PCM WAV 识别 | Worker 校验实际帧数 → 预留日时长 → OpenAI | 否 |
| 常见 MP3、Ogg/WebM Opus、M4A AAC-LC 识别 | Worker 扫描帧/采样表 → 直接上传原压缩音频到 OpenAI | 否 |
| 其他或无法可靠扫描的音频识别 | Worker → 私有编解码源站解码一次 → Worker → OpenAI | 仅解码 |
| 自建 Qwen/Embedding/ASR/TTS | Worker 鉴权 → Tunnel → 本机模型 | 是 |

因此云端文本和 PCM 合成和支持的音频识别不再经过本机，也没有本机 → Worker 的逐请求鉴权往返。无法可靠扫描的识别输入仍依赖本机解码，不能把“语音已迁到 Worker”理解为所有格式都已完全脱离源站。Worker Free 不适合运行重型 FFmpeg；本次没有升级付费套餐或引入第三方编解码服务。

新客户端建议录制 16kHz、单声道、16-bit PCM WAV，合成播放选择 stream=true,response_format=pcm；合成默认输出 PCM，其他格式返回 422；客户端需要时自行封装 WAV 或压缩编码。PCM WAV 直传支持 8–48kHz、单/双声道，按数据帧数计量；不信任容器内声明的时长，更不信任客户端上报 duration。MP3 按 MPEG 帧数，Ogg/WebM Opus 按音频包，非分片单音轨 M4A AAC-LC 按采样表及实际数据区边界计算，不只读取 duration 标签；歧义、损坏或不支持的编码回退受限 FFmpeg 解码。压缩帧可能包含编码延迟/尾部填充，额度按保守毫秒上界计入，通常略长于播放器显示。21 MiB / 5 分钟 / 每日 30 分钟的限制保持。

## 鉴权、额度与结算

Worker 直接验证凭证、Client ID、权限、RPM/日请求/并发，再预留模型额度和调用 OpenAI。响应流结束或取消时直接在 D1 结束请求，占用和模型额度没有因跳过本机而绕过。输出 X-Inference-Execution: edge 和 X-Request-ID，可用于客户端确认路径及定位；首包时间仍受 OpenAI 生成、网络和 D1 响应影响，不能承诺固定延迟。

账号 access_token 的 Client-ID 白名单保存在 Worker Secret `INFERENCE_CLIENT_IDS`。与本机私有 deploy/client_ids.json 同步：

```bash
.venv-accounts/bin/python -m scripts.ops.sync_worker_client_ids
```

不要把 ID 列表写入公开 wrangler.jsonc 或交接文档。轮换时同步 Worker，API Key 鉴权仍不要求 Client ID。

## 保护回源

本机配置 GATEWAY_EDGE_ONLY=1；18900 只接受具备 INTERNAL_SECRET 对应服务凭证的 Worker 请求。客户端伪造的 X-Edge-*、Authorization、Cookie 等不会作为内部授权原样转发。Worker 给回源请求附加私有 lease 和请求 ID，本机不再重复发起账号授权。公网无法通过 `/__codec/*` 直接使用编解码服务。

HTTP 回源的请求结算由 Worker 负责；自建 WebSocket 仍由本机在连接结束后回报结算。18901 继续是回环免认证开发入口，绝不能加入 Tunnel。

Worker Route 的 fetch 到相同路由域名进入原源站，不再次运行此 Route；账号域名的 Custom Domain 保持独立。不要把 API Route 改成同名 Custom Domain 后继续假设同样的回源语义。[Cloudflare 路由说明](https://developers.cloudflare.com/workers/configuration/routing/routes/)

## 本地模型目录

默认 LOCAL_MODELS_ENABLED=false，避免云目录依赖未启动的本机模型。开启后仅对具备 qwen 权限的调用异步刷新本地模型目录，并缓存 30 秒；首次请求可能只有云模型，后续才显示已启动的本地模型。刷新失败不阻塞云模型发现。直接指定已配置本地模型仍可转发，不受目录缓存影响。

## 发布与回滚

先测试、同步私有 Client IDs、部署源站编解码及边缘凭证支持，再部署 Worker API Route。正常客户端继续使用 api.hilex.me。Worker/D1 账号与模型额度始终是权威来源。

回滚需一起处理 API Route 与 GATEWAY_EDGE_ONLY：先恢复旧本机鉴权配置并重启，再移除 API Worker Route，使 Tunnel 重新直达旧网关。不要在源站仍要求边缘凭据时直接删除 Route，否则全部原接口会返回 401。回滚不重新导入数据库或重置账号额度。

## 合成仅输出 PCM

`POST /v1/audio/speech` 的 `response_format` 缺省或设为 `pcm`，`stream` 缺省为 false，设为 true 时边生成边返回。显式请求 mp3/wav/opus/flac 等格式返回 422、error_code=unsupported_audio_format，在上游调用前拒绝，不预留或扣减模型额度。

响应 `Content-Type: audio/pcm`、`X-Audio-Sample-Rate: 24000`；数据为 24kHz、signed 16-bit little-endian、单声道原始 PCM，没有 WAV 文件头，也不是 SSE/JSON。HTTP chunk 不保证对齐样本，客户端应缓存偶数个字节后播放。若需 WAV，在客户端添加文件头；若需压缩存储，在客户端编码。合成全程 Worker → OpenAI，不调用本机编码器，旧私有 encode/stream-encode 路由已删除。

识别的 `X-Audio-Processing` 仍区分 mpeg-frame-scan、opus-packet-scan、webm-opus-packet-scan、aac-sample-table-scan 和 origin-decode。识别输入支持格式没有因合成收敛而减少。

## 本次验证

本地通过 158 项 Python 测试、47 项 Worker 测试，覆盖默认 PCM、显式 PCM、流式 PCM，以及其他格式在上游调用前拒绝且不扣字符额度。Luna 工具兼容继续通过回归。

公网临时账号实测默认非流式 PCM、流式 PCM、模型目录的 PCM 能力元数据均正常；本轮首段流式音频约 2.05 秒，仅代表本轮观测。四种旧输出格式返回 422 后音频账本数量和字符扣额保持不变。将 PCM 在客户端封装 WAV 后调用识别返回 200，未回源解码；请求和用量均结算，验证账号与关联数据已清理。
