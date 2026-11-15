> 本页仅供旧自建客户端迁移域名参考。新客户端及云模型请使用 [当前接入入口](client-integration.md) 和 [客户端交接](client-handoff.md)。

# 客户端迁移：统一推理域名（2026-10-28）

## 必须调整的配置

本次为直接切换，不保留旧 ASR/TTS 域名、不做重定向。VibeVoice 仅本机使用，不提供公网接口，也不属于本次客户端公网迁移。客户端应删除独立的 ASR/TTS 服务地址，只保留：

```text
ACCOUNT_BASE_URL = https://accounts.hilex.me
INFERENCE_BASE_URL = https://api.hilex.me/v1
SPEECH_WS_BASE_URL = wss://api.hilex.me
```

OpenAI 类 SDK 的 base_url 使用包含 `/v1` 的第二项，调用具体方法时不要再次拼 `/v1`；WebSocket 使用第三项后拼 `/ws/asr` 或 `/ws/tts`。账号登录、注册和刷新依旧使用 ACCOUNT_BASE_URL，不能改为 api 域名。

| 功能 | 新的完整地址 | 方法／类型 |
|---|---|---|
| 完整模型列表（LLM／Embedding） | `https://api.hilex.me/v1/models?output_modalities=all` | GET |
| LLM 对话 | `https://api.hilex.me/v1/chat/completions` | POST JSON，可 SSE |
| LLM 文本补全 | `https://api.hilex.me/v1/completions` | POST JSON |
| Embedding | `https://api.hilex.me/v1/embeddings` | POST JSON |
| Paraformer 文件 ASR | `https://api.hilex.me/v1/audio/transcriptions` | POST multipart |
| TTS 文件 | `https://api.hilex.me/v1/audio/speech` | POST JSON，返回 WAV |
| 实时 ASR | `wss://api.hilex.me/ws/asr` | WebSocket |
| 双流 TTS | `wss://api.hilex.me/ws/tts` | WebSocket |
| 网关健康 | `https://api.hilex.me/healthz` | GET，无需认证 |

旧地址对照：

| 删除的旧地址 | 替换为 |
|---|---|
| `https://asr.sunlingzhang.com/v1/audio/transcriptions` | `https://api.hilex.me/v1/audio/transcriptions` |
| `https://tts.sunlingzhang.com/v1/audio/speech` | `https://api.hilex.me/v1/audio/speech` |
| `wss://asr.sunlingzhang.com/ws/asr` | `wss://api.hilex.me/ws/asr` |
| `wss://tts.sunlingzhang.com/ws/tts` | `wss://api.hilex.me/ws/tts` |

旧域名不再作为受支持的服务入口；不对当前 DNS 状态作保证。不应将旧域名作为 fallback。`api` 域名不提供登录页面、`/auth/*`、`/account/*`、`/admin/*`、静态页面、Swagger 或文档下载；`/v1/rerank`、`/v1/score` 等没有部署后端的接口不开放。健康接口只证明网关运行，不证明每个模型随时可用。

## 认证：账号与 API Key 二选一

### 安卓和用户账号客户端

所有推理 HTTP 请求和语音 WS 握手都必须同时提供：

```http
Authorization: Bearer <用户 access_token>
X-Client-ID: <现有 Client ID>
```

继续使用现有 Client ID，不生成新值；Client ID 不能替代账号身份。HTTP Cookie 不是推理认证方式。

### 管理员配置的 API Key

自动化程序可只提供一个凭据，不需要 Client ID：

```http
Authorization: Bearer <API_KEY>
```

或：

```http
X-API-Key: <API_KEY>
```

不要同时发送用户 token 与 X-API-Key；两个不同凭据会被拒绝。API Key 不可调用账号管理接口，也不参与 access/refresh token 刷新。账号退出只撤销登录令牌，独立 API Key 需要管理员单独撤销。普通用户仍不能创建或管理 Key。

### 权限和额度

域名统一不合并服务权限：LLM 和 Embedding 使用 `qwen` 权限及额度，两个 ASR 使用 `asr`，TTS 使用 `tts`。账号请求额度、并发、Key 范围、有效期、禁用与撤销仍生效。认证有效但没有对应权限返回 403；不要因 URL 同为 api 域名而把所有调用在客户端计为 LLM。

## 账号流程不变

```text
POST https://accounts.hilex.me/auth/register
  {"email":"user@example.com","password":"至少6字符"}

POST https://accounts.hilex.me/auth/login
  {"username":"user@example.com","password":"密码"}

POST https://accounts.hilex.me/auth/refresh
  {"refresh_token":"登录返回的 refresh_token"}

POST https://accounts.hilex.me/auth/logout
  {"refresh_token":"当前 refresh_token"}
```

注册、登录和刷新不要求 Client ID。登录响应包含 `access_token`、`refresh_token`、`expires_in`、`refresh_expires_in` 和用户信息。客户端应根据响应有效期刷新，不硬编码。刷新返回新的 token 对，旧 refresh token 不可再次使用；多请求同时过期时，应串行刷新并原子替换 token 对，避免刷新竞争。不要把 refresh token 放进模型接口或 WS URL。

账号 token 401 时可刷新一次后重试；Client ID 错误需要修正应用配置，刷新无效。API Key 的 401 应检查 Key 有效期或撤销状态，不进入账号刷新流程。账号退出后清除本机 token 和敏感缓存。

## HTTP 接入示例

账号模式下，以下请求都使用相同的两个认证头：

```bash
curl https://api.hilex.me/v1/embeddings \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Client-ID: $CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{"model":"Qwen/Qwen3-Embedding-0.6B","input":"课程知识整理","dimensions":1024}'

curl https://api.hilex.me/v1/audio/transcriptions \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Client-ID: $CLIENT_ID" \
  -F 'file=@sample.wav'

curl https://api.hilex.me/v1/audio/speech \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Client-ID: $CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{"input":"你好，欢迎学习。"}' -o speech.wav
```

API Key 模式替换认证头为 `-H "X-API-Key: $API_KEY"` 即可，不带用户 token 或 Client ID。multipart 由客户端库生成 boundary，不要手工写死 Content-Type。

本次没有修改模型输入／输出协议：

- LLM：JSON 请求与 SSE 响应照旧，按事件解析，不按 TCP chunk 解析；`data: [DONE]` 代表结束，可能含 usage-only 事件。
- Embedding：默认 1024 维，支持 32–1024 维、float/base64；单条 32768 token，批量含 padding 后总量也受限，不会静默截断。入库和查询必须使用同一维度。
- Paraformer HTTP：主要字段 `file`，音频最多 120 秒；返回 `text` 等字段。
- TTS HTTP：`input` 最多 2000 字符，响应为完整 `audio/wav`。不要把它当成裸 PCM 或 WS 音频帧。

## 语音 WebSocket

安卓等原生客户端可在握手中直接设置 HTTP 认证头。浏览器 WebSocket 无法设置任意请求头时，账号模式使用子协议：

```javascript
const ws = new WebSocket("wss://api.hilex.me/ws/asr", [
  "speech", "access-token." + accessToken, "client-id." + clientId
]);
```

API Key 模式可使用 `['speech', 'api-key.' + apiKey]`，无需 client-id 子协议；浏览器面向普通用户时仍推荐账号模式。不要在 query string 里放凭据。

### ASR

1. 等待 `{"type":"ready","sample_rate":16000,"format":"s16le","channels":1}`。
2. 发送原始 16kHz、单声道、16bit 小端 PCM 二进制帧；不能发送 WAV/FLAC/OGG 文件头。每帧字节数必须为偶数；建议发送小块，单帧不超过 10 秒。
3. `partial` / `final` 包含 `delta`（本次新增文本）与 `text`（累计文本）。选择按 delta 追加，或直接用 text 覆盖，不能两者同时追加。
4. 音频结束后只发送一次 `{"type":"end"}`，等待 final 和关闭，不要立即主动断开导致尾部未刷新。

### TTS

1. 连接 `wss://api.hilex.me/ws/tts`，等待 ready；播放参数采用 ready 给出的 sample_rate、s16le 和 channels。
2. 增量发送 `{"type":"text","text":"一段文字"}`，每条最多 2000 字符，会话合计最多 20000。
3. 接收二进制裸 PCM16 帧并按顺序播放，不包含 WAV 头；文本发送完成后只发送一次 `{"type":"end"}`。
4. 等待音频输出完成及 `{"type":"done"}`。text 输入和音频输出可以并行进行。

WS 忙时关闭码 1013，协议错误／认证失败可能为 1008 或握手被拒绝；不得把失败当作正常转写结束。重连前取得有效 token，新连接使用新凭据；连接内不发送 refresh token。网关会话最长约 900 秒。

## 错误、重试与验收

| 状态／错误 | 客户端处理 |
|---|---|
| 400 / 422 | 修正输入、参数或音频格式，不盲目重试 |
| 401 | 检查所选认证分支、账号 token + Client ID 或 API Key |
| 403 | 账号禁用、权限不足、需修改密码等，按服务端 detail 提示处理 |
| 404 | 检查是否使用新域名和精确路径；不回退旧域名 |
| 413 | 缩小上传文件或拆分音频 |
| 429 | 账号额度／并发限制，遵循 Retry-After，避免密集重试 |
| 502 / repetition_detected | 按现有客户端失败片段重切策略处理；不接受为成功结果 |
| 502 / 503 / 504 | 上游、排队或超时问题，有限退避；不要无限重发 |

记录响应 `X-Request-ID` 以便服务端排查；它不是幂等键。TTS/音频上传超时后不要立即无限重复提交。后台推理可能尚未结束。

客户端迁移验收建议：

- 从安装配置、持久化设置、HTTP 拦截器、WS 工厂、证书固定策略和测试配置中移除旧语音域名。
- 账号登录、刷新和退出仍走 accounts；LLM、Embedding、Paraformer ASR、TTS 和两个 WS 全部走 api。
- 账号模式缺任一认证头必须失败；Key-only 无 Client ID 应成功；无权限服务返回 403。
- 验证 ASR 最后一次 flush、累计文本不重复追加、TTS 裸 PCM 播放和 busy 1013。
- 确认旧域名不可用，不依赖重定向；本地免鉴权仅使用 `http://127.0.0.1:18901`，不把“服务器连接来自本机”作为公网免认证依据。

补充文档：[统一网关运维](unified-gateway.md)、[账号接入细节](client-integration.md)；模型部署细节见独立 model-serving 项目。文档随本仓库版本管理，API 域名不提供文档下载。

## 模型发现更新（2026-10-30）

模型分类采用 OpenRouter 风格的 `architecture.input_modalities` / `output_modalities`，默认 `/v1/models` 仅返回文本输出模型。Helix 完整发现请改为 `/v1/models?output_modalities=all`；只选嵌入可用 `output_modalities=embeddings`。推理地址及认证不变，详见 [模型发现](model-discovery.md)。
