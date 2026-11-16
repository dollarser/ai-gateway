# 客户端交接：云模型、额度与诊断信息

## 必须支持

1. 使用公网 base URL `https://api.hilex.me/v1`，不能使用 18901 本机免认证入口调用 OpenAI 模型。
2. 账号登录后使用 Bearer access_token 和有效 `X-Client-ID`；API Key 只需 Bearer Key。不能把 Worker 内部密钥或 OpenAI 密钥放入客户端。
3. 完整发现请求 `GET /v1/models?output_modalities=all`。默认列表只包含对话文本模型，不包含独立识别/合成模型。模型列表按账号与 Key 的权限交集返回，只有 ASR/TTS 权限的 Key 也能发现自己的语音模型，不必增加 qwen 权限。
4. 按 `architecture.output_modalities` 和 `endpoints`（如存在）区分用途：`text` 对话，`transcription` 识别，`audio` / `speech` 合成。不要把所有模型放进同一个聊天选择器，也不要硬编码只有 Qwen。
5. 模型 ID 精确为 `gpt-6-luna`、`gpt-transcribe`、`gpt-realtime-2.1-mini`。Luna 的 Chat Completions 和 Responses 参数不同；语音模型不是聊天模型。
6. 遇到 429 先展示服务端 `detail` 并遵守 Retry-After，不无限自动重试。遇到 401 尝试正规刷新或重新登录；403 展示权限/封禁/首次改密提示。网络断开后不要无条件重复提交同一份音频或文本。

## 语音接口路由

OpenAI 云语音当前使用下面的 HTTP 接口。原 `/ws/asr`、`/ws/tts` 仍连接自建模型，不会按 model 字段自动转发到 OpenAI；原生 `/v1/realtime` 也未向客户端开放。若客户端当前固定使用语音 WebSocket，选择这两个云模型后必须切换到 HTTP 识别/合成流程，不能只改模型名称。

## 语音识别

POST `/v1/audio/transcriptions`，multipart 的 `model=gpt-transcribe`，`file` 为实际音频数据，不是 URL 或文件路径字符串。支持 json/text 返回；SSE 时 `stream=true,response_format=json`。客户端不要自己设置 multipart boundary。

单文件不超过 21 MiB、单次音频不超过 5 分钟，长录音分段。客户端可以估算时长、显示剩余额度，但计量由服务端实际解码决定，不能靠上报 duration 降低扣量。`language` 或重复 `languages[]`、`keywords[]` 可辅助识别。

## 语音合成

POST `/v1/audio/speech`，JSON 包含 model、input、voice（默认 marin）和 response_format（默认 pcm）。输入每段 1–2000 Unicode 码点，长文本分段；JavaScript 用 `Array.from(text).length` 估算，不使用 UTF-16 length 或字节数。空格和标点也计入每日字符。

仅支持 `response_format:"pcm"`（可省略），speed=1；`stream:true` 可以边生成边播放，默认 false 等整段生成后返回。PCM 为 24kHz、signed 16-bit little-endian、单声道原始字节，无 WAV 头。响应 Content-Type 为 audio/pcm，X-Audio-Sample-Rate 为 24000。HTTP 分块可能不对齐 16-bit 样本，客户端需缓存拼接；流式中断不能只凭 HTTP 200 当成成功。显式请求 mp3/wav/opus/flac 返回 422，不扣模型额度。需要 WAV 文件或压缩文件时由客户端封装/编码。

## 账号余额展示

使用账号 access_token 调用账号域名（不是模型 base URL）：

- `GET https://accounts.hilex.me/account/luna-usage`：月额度、已计入、预留/待核对和剩余 tokens。
- `GET https://accounts.hilex.me/account/audio-usage`：ASR 为 milliseconds，除以 60000 显示分钟；TTS 为 characters。不要把毫秒当成秒。
- `GET https://accounts.hilex.me/account/usage`：请求记录和统计。

原始 API Key 不能当作账号管理的 access_token 使用；仅配置 Key 的客户端可以显示服务端额度错误，不应伪造余额或要求用户提供管理员凭据。原生桌面客户端可直接调用账号 API；跨域网页需要另行配置受控 CORS，目前账号域名不对任意来源开放。

默认 Luna 每月 1000 万 tokens；ASR 每日 30 分钟；TTS 每日 50 万字符。管理员可改变单账号额度，以服务端返回为准，不在客户端写死。日 / 月切换均以 Asia/Shanghai 为准，客户端本地时区不影响服务端额度。已计入包含预留/待核对量，不可再次从 remaining 扣除。

## 建议支持的诊断字段

每个 HTTP / WebSocket 握手请求附加：

| 请求头 | 内容 | 说明 |
|---|---|---|
| `X-Client-Version` | 客户端版本，如 `helix/1.2.3` | 最多 128 字符，避免带凭证 |
| `X-Device-ID` | 随机安装实例 ID | 最多 128 字符；不要使用硬件序列号、MAC、邮箱或永久身份指纹 |
| `User-Agent` | 应用名称与版本 | 服务端最多保存 512 字符 |
| `X-Client-Request-ID` | 每次逻辑请求的随机 ID | 用于人工排查，不代表幂等重试保证 |

保存响应的 `X-Request-ID`，报错时向用户提供复制入口。IP 由服务端可信入口记录，客户端无需上报 IP；不要自行填写 CF-Connecting-IP、CF-Ray 或 X-Forwarded-For。若为浏览器 WebSocket，不能任意加请求头，继续沿用现有安全子协议鉴权，版本/设备信息需另行协商协议；不要把密钥或诊断字段塞进会被访问日志记录的 URL 查询参数。

识别结果、待合成文本和原始音频不应写进常规客户端日志。设备 ID 只是诊断信息，不参与账号权限、额度或安全认证。

## 新增错误与兼容要求

云语音缺少/拼错 model、错误 Content-Type 返回 422，不能把 tts-1、whisper-1 或旧自建默认名称当作新云模型 ID。旧自建客户端显式发送 `X-Inference-Provider: local` 可保留原格式。WebSocket 握手错误现在区分 401/403/422/503，并提供 request_id；上游停机不再伪装为权限 403。完整行为见 [可靠性与诊断](gateway-reliability.md)。

## 边缘直连更新

API 域名和请求格式不变。云文本、PCM 合成、标准 PCM WAV 识别直接由 Worker 处理，不再经过本机网关。响应 X-Inference-Execution: edge 可确认入口。常见 MP3、Ogg/WebM Opus、M4A AAC-LC 识别经帧扫描后直传；无法验证的识别输入保留一次私有解码回源，若源站停机可能失败；低延迟和源站独立性优先时，识别上传 16kHz 单声道 PCM WAV，合成选择 PCM 流。不要给客户端添加任何 X-Edge-* 内部头。详情见 [边缘路径](edge-api.md)。

## 压缩音频与 Luna 工具兼容更新

- 识别可直接上传常见 MP3、Ogg/WebM Opus、M4A AAC-LC；网关验证后直接传 OpenAI，不要求客户端转换 WAV，也不接受客户端 duration 作为扣额依据。特殊变体仍可能回源解码。
- 合成仅支持 PCM（默认），流式和非流式均不依赖源站；客户端应移除旧压缩格式参数并按原始 PCM 播放，详情见 [边缘接口](edge-api.md)。
- Luna Chat 带工具统一使用 reasoning_effort=none，网关自动兼容；需要推理加工具时使用 Responses。记录 X-Request-ID 和 X-Inference-Compatibility 便于排查；错误 JSON 可能带 upstream_error_code / upstream_error_param，请勿记录敏感请求正文。详见 [Luna 额度及工具协议](luna-allowance.md)。

## 流式取消、错误与全站预算

- Chat SSE 正常完成需要最终 usage 和 `[DONE]`，Responses 需要 `response.completed`，识别需要 `transcript.text.done`。若收到 `type:error` / `error.code=provider_stream_interrupted`，丢失终止标记或连接失败，应显示“未完成”，不要自动续写或重发有工具副作用的请求。
- 用户停止播放/生成时取消 HTTP 读取，网关会中止上游；已发生或无法确认的用量仍计入预留，不应因客户端取消就显示已退款。PCM 是原始音频，无法嵌入 SSE 错误；客户端仍须处理网络异常和播放失败。
- 错误 JSON 提供 error_code、retryable，参数错误和地区限制不会通过重试修复。`provider_rate_limited` 可遵守 Retry-After；`provider_credit_exhausted`、`provider_auth_failed`、`provider_region_restricted`、`global_budget_exhausted` 应提示并停止自动重试。不得将提供方认证异常当成用户 token 失效而反复登录。
- 账号每月 1000 万 tokens 额度保留；全站 Luna 另有每月 200 美元估算预算。管理员暂停云服务返回 global_cloud_disabled。预算按北京时间自然月重置；全站预算耗尽不代表个人额度被清零。
- 默认示例客户端改用云 HTTP，老自建语音示例移至 `python -m scripts.clients.local_ws`。

## 错误展示与重试决策补充

本仓库 Python HTTP 示例已接入 scripts/clients/errors.py，网页错误对象保留 code、request_id、retryable、retry_after；均不会自动重放模型请求。外部 Android/其他客户端应按下表接入，不能只根据 HTTP 502/429 决策：

| error_code | 展示和动作 |
|---|---|
| provider_region_restricted | 当前上游地区访问受限，联系管理员核查；不反复登录，不自动重试 |
| provider_auth_failed | 上游密钥异常；不清除用户登录状态 |
| provider_credit_exhausted | 上游账单/余额不足，联系管理员 |
| global_budget_exhausted | 全站预算达到上限，不是个人额度被清零 |
| account_luna_budget_exhausted / account_asr_budget_exhausted / account_tts_budget_exhausted | 明确展示对应个人额度不足 |
| account_daily_limit / key_token_budget_exhausted | 个人请求数或当前 Key 的额度不足 |
| provider_rate_limited / account_rate_limited / account_concurrency_limited | 可参考 Retry-After 稍后由调用方重试；避免重复执行工具副作用 |
| provider_stream_interrupted | 显示未完成和请求 ID，不自动重发 |

只有真正的用户凭证过期/无效才进入登录刷新流程。保留 X-Request-ID 供管理员下载脱敏诊断包，不上传用户对话或音频作为默认排障材料。统计、参考探测和支持包的范围见 [网络诊断](network-diagnostics.md)。
