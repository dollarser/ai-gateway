# 客户端接入与交接

OpenAI 出站支持部署时切换 Worker 直连或本机转发，当前默认本机转发。客户端域名、鉴权、请求参数、流式响应和额度协议均不变；不需要客户端自行选择出口。

本文件是当前生产客户端的统一接入清单。账号、通知、模型和语音的详细字段由下文链接补充；历史迁移文档不作为新客户端默认协议。客户端应忽略响应中的未知字段，对新增错误码提供通用兜底；请求只提交开放字段，服务端会拒绝未开放参数。

## 1. 地址、凭据与能力边界

| 用途 | 基础地址 | 凭据 |
|---|---|---|
| 登录、注册、邮箱绑定、通知、个人用量 | `https://accounts.hilex.me` | 登录后使用账号 `access_token`；注册/登录接口无需先登录 |
| 模型发现、文本、识别、合成 | `https://api.hilex.me/v1` | `Bearer access_token` + 有效 `X-Client-ID`，或 `Bearer API_Key` |

`X-Client-ID` 用于账号令牌调用模型 API，账号域名接口不要求该头。仅配置 API Key 的客户端可以调用获授权模型，但不能用 Key 调用账号管理或余额接口，不应伪造余额或索取管理员凭据。普通用户通过账号登录；Key 由管理员管理。

原生客户端可直接访问上述地址。跨域网页需要受控 CORS，目前账号域名不对任意来源开放。站内 Cookie 写操作须带 `X-CSRF-Token`；原生 Bearer 模式不使用网页 CSRF。不要将 Worker 内部密钥、OpenAI 密钥或 `X-Edge-*` 内部头放入客户端，也不要使用本机端口作为公网免认证入口。

## 2. 登录、刷新与退出

建议顺序：登录 → 处理首次改密 → 提示历史账号绑定邮箱 → 按需加载模型、用量和通知。绑定提醒允许稍后处理，不阻断已有模型服务。

| 接口 | 请求与处理 |
|---|---|
| `POST /auth/login` | `{ "email":"登录邮箱", "password":"用户密码" }`；保存返回的 token 对、有效期和 `user` |
| `GET /account/me` | 获取最新 `user`；适合启动恢复会话或进入账号页，不要在每次推理前额外调用 |
| `POST /auth/refresh` | `{ "refresh_token":"当前刷新令牌" }`；成功后原子替换 access_token、refresh_token 和有效期 |
| `POST /account/password` | `{ "current_password":"旧密码", "new_password":"新密码" }`；成功后重新登录 |
| `POST /auth/logout` | 原生令牌模式提交 `{ "refresh_token":"当前刷新令牌" }`；随后清除本地会话与敏感缓存 |

有效期使用服务端 `expires_in` / `refresh_expires_in`（相对秒数），不要写死令牌寿命。刷新令牌会轮换：同一账号的并发刷新必须合并成一次，其他请求等待结果；重复使用旧刷新令牌可能撤销整个登录家族。

401 只有确认是本人的登录凭证失效时才进入刷新；刷新失败转登录。读取类请求可在刷新成功后最多重试一次；超时、断流或已提交上游的文本/音频请求不得无条件重放。提供方认证异常 `provider_auth_failed` 不属于用户登录失效。

`user.must_change` 为真时先修改初始密码，再重新登录；当前JSON通常使用0/1，客户端不要强制将它仅解析为布尔类型。令牌保存在系统安全存储或受控会话中，不写日志、URL、剪贴板历史或普通配置文件。

## 3. 新注册与历史邮箱绑定

### 新注册

1. `GET /auth/registration-info`，检查 `registration_enabled`、`email_verification` 和默认额度；`email_verification_available` 仅表示配置完整，不保证实际邮件送达。
2. 用户主动点击后调用 `POST /auth/registration-code`，提交 `{ "email":"user@example.net" }`。
3. `POST /auth/register`，提交邮箱、密码和六位字符串验证码：

```json
{"email":"user@example.net","password":"用户选择的密码","code":"012345"}
```

密码要求6–128字符。成功返回201，随后正常登录。验证码十分钟有效、最多五次校验尝试、同邮箱至少六十秒重发间隔；以实际错误和 Retry-After 为准。保留前导零，不将 code 转为数字，不自动循环发信。成功消费后服务端清空验证码校验值，已用或过期码不能复用。

### 历史账号

登录返回的 `user.email_binding_required=true` 或 `/account/me` 中同名标记为 true 时展示可稍后处理的提醒。只预填 `user.email`；显示名不能推导邮箱。无邮箱账号先由管理员按 ID 设置登录邮箱。

- 用户主动发送：`POST /account/email/code`，提交 `{ "email":"user@example.net" }`。
- 完成绑定：`POST /account/email/bind`，提交 `{ "email":"user@example.net","code":"012345" }`。
- 成功后用返回的 user 更新状态并隐藏提醒。**验证绑定后的 email 就是登录邮箱**；更新客户端保存的邮箱。账号 ID、密码、权限与既有令牌不变。

不得在登录时自动发绑定邮件；注册和绑定验证码不能互换，绑定码也不能跨账号使用。已验证账号的换绑不是当前补绑定接口的用途。详细错误与限频见 [邮箱验证及绑定](email-verification.md)。发信服务的具体供应商属于服务端配置，客户端不保存 SMTP 凭据。

## 4. 模型发现与缓存

完整目录：`GET https://api.hilex.me/v1/models?output_modalities=all`。默认不带参数仅展示文本输出模型，不包含独立识别/合成用途。按 `architecture.output_modalities`、`endpoints` 和 `audio` 能力分组，不把语音模型混入聊天选择器，也不硬编码只有 Qwen。

| 模型 ID | 用途 | API 域名下的接口 |
|---|---|---|
| `gpt-6-luna` | 文本、图片输入与自定义工具 | `POST /v1/chat/completions`、`POST /v1/responses` |
| `gpt-transcribe` | 音频识别 | `POST /v1/audio/transcriptions` |
| `gpt-realtime-2.1-mini` | 文字合成语音 | `POST /v1/audio/speech` |

实际列表以账号/Key服务权限及部署配置为准。仅有 ASR/TTS 权限的 Key 也可以发现自己的模型，不需要额外 qwen 权限。自建模型仅在部署明确开放时出现。

当前生产云模型目录是只读鉴权：**不计日请求数、不占并发名额、不产生逐次推理明细**。不要把模型发现次数显示成计费调用。目录仍读取最新权限；缓存列表不保证下一次推理会被授权。按账号及凭据隔离缓存，建议最多24小时，手动刷新、切换账号/Key或权限变化时失效。将来开启本地模型目录时，查询可能走带内部凭证的旧路径，不承诺同样的零写入行为。详见 [模型发现](model-discovery.md)。

## 5. Luna 文本与工具调用

普通文本使用标准 Chat Completions 或 Responses 请求，model 精确为 `gpt-6-luna`。示例：

```json
{"model":"gpt-6-luna","messages":[{"role":"user","content":"你好"}],"max_completion_tokens":256,"stream":true}
```

Chat 带工具时客户端使用 `reasoning_effort:"none"`，网关也会做兼容处理；需要推理加工具时使用 Responses。两种接口的消息、工具及推理字段不同，不直接复用同一请求对象。客户端必须提交完整上下文，不能假设服务端保存对话或支持隐藏状态引用。

保存 `X-Request-ID` 和可选 `X-Inference-Compatibility`。不要因 medium/none 的工具兼容问题反复提交同一调用。完整支持范围和工具回传格式见 [Luna 协议](luna-allowance.md)。

## 6. 云语音协议

云识别和合成使用 HTTP。`/ws/asr`、`/ws/tts` 属于自建服务，不会因更改 model 自动转发云模型；客户端不能只改模型名称而保持旧 WebSocket 流程。原生 `/v1/realtime` 未向客户端开放。

### 识别

`POST /v1/audio/transcriptions`，使用 multipart：`model=gpt-transcribe`，`file` 为真实音频文件，不是 URL 或文件路径字符串。不要手动设置 multipart boundary。

- 单文件不超过21 MiB、单次音频不超过5分钟，长录音分段。
- 支持 json/text；SSE 使用 `stream=true,response_format=json`。
- `language`、重复 `languages[]` / `keywords[]` 可辅助识别；详细字段格式见语音文档。
- 常见 MP3、Ogg/WebM Opus、M4A AAC-LC 可直接上传。服务端按验证出的实际时长计量，可能采用头/帧扫描或必要解码，不接受客户端 duration 作为扣额依据。
- 对低延迟、减少特殊格式回源的场景，推荐16kHz单声道PCM WAV；不要求把所有受支持的压缩格式强制转为WAV。

### 合成

`POST /v1/audio/speech`，示例：

```json
{"model":"gpt-realtime-2.1-mini","input":"你好，欢迎使用。","voice":"marin","response_format":"pcm","stream":true}
```

- 每段1–2000个Unicode码点；JavaScript用 `Array.from(text).length` 估算，空格和标点也计量。长文本由调用方分段。
- 只支持原始PCM：24kHz、signed 16-bit little-endian、单声道、无WAV头；默认voice=marin、response_format=pcm、speed=1，默认stream=false。
- 响应 `Content-Type: audio/pcm`，`X-Audio-Sample-Rate: 24000`。HTTP块不保证按两个字节的样本对齐，客户端应缓存半个样本，跨块拼接。
- mp3/wav/opus/flac合成参数返回422，不提交上游模型扣量；需要文件时由客户端封装或编码，不能把PCM字节直接改扩展名当WAV。

云文本和PCM合成不依赖本机推理网关；特殊识别格式仍可能走一次私有解码回源。响应 `X-Inference-Execution: edge` 可辅助排查。旧自建客户端协议见 [自建语音](self-hosted-voice.md)，云语音详情见 [语音额度](audio-allowances.md)、[边缘路径](edge-api.md)。

## 7. 流式完成、取消与重试

| 响应类型 | 完成判断 |
|---|---|
| Chat SSE | 最终usage及 `[DONE]` |
| Responses SSE | `response.completed` |
| ASR SSE | `transcript.text.done` |
| PCM音频 | 持续读取并处理传输错误；原始PCM不含SSE终止/错误标记，不能仅凭HTTP200判断内容完整 |

收到错误事件、`provider_stream_interrupted`、缺少终止事件或连接异常，应标记“未完成”。文本/音频分块不是独立请求，不为每块开连接、查余额或写已读状态。

用户停止生成/播放时取消HTTP读取，及时停止上游工作。取消不保证退款：已发生或无法确认的用量可能仍占额度或预留。`X-Client-Request-ID` 是诊断关联ID，**不是幂等键**；不要在超时或断流后自动重发计费请求，尤其是已有工具副作用的请求。

## 8. 用量、余额与历史记录

| 账号接口 | 单位与显示 |
|---|---|
| `GET /account/luna-usage` | 月tokens、已计入、预留/待核对和剩余；不要再次从remaining减去reserved |
| `GET /account/audio-usage` | ASR为毫秒，除以60000显示分钟；TTS为字符 |
| `GET /account/usage` | 当日totals及最近最多100条仍保留的请求明细，不是完整历史分页 |

默认个人额度为Luna每月1000万tokens、ASR每天30分钟、TTS每天50万字符。管理员可调整，以服务端字段为准，不在客户端写死。全站Luna另有每月200美元估算预算；全站预算耗尽不代表个人额度被清零。

服务端按 `Asia/Shanghai` 自然日/月重置，客户端本地时区不改变额度周期；优先使用服务端 `resets_at` 显示重置时间。通知的 starts_at / expires_at / published_at / read_at 及 email_verified_at 是Unix秒，可包含小数；expires_in、refresh_expires_in、retry_after 是相对秒，resets_at 是ISO8601时间字符串。不要与音频毫秒或JavaScript毫秒时间戳混淆。

用量页进入时或用户手动刷新时获取；请求完成优先使用响应usage展示，不在每次推理前后固定查询所有账号接口。本地余额只是展示，不参与服务端放行、并发或扣费判断。

**明细不是完整历史**：旧模型目录记录在当日额度窗口结束后可归档，普通无财务关联的请求结束90天后可归档，财务关联请求保留。归档保留每日汇总，管理员历史日统计已合并汇总；客户端不应从有限requests数组反推累计调用数，也不能把明细为空解释为从未使用。当前没有新增供普通账号调用的“全量历史汇总接口”。IP/UA/设备标识30天后可能为空，不能因此显示为数据损坏。

## 9. 用户通告与每天一次自动检查

账号域名接口：

| 接口 | 用途 |
|---|---|
| `GET /account/notices/unread-count` | 返回unread、poll_after_seconds=86400 |
| `GET /account/notices?page=1&state=all` | 当前有效列表，可选state=unread，每页30条，含正文和读状态 |
| `POST /account/notices/read` | `{ "ids":["通告ID"] }`，1–100个不重复ID；幂等，返回最新unread |

每账号每客户端安装/浏览器，每24小时最多自动检查一次。持久化最近成功/尝试时间和角标摘要，多窗口共用调度；登录、恢复前台、恢复网络只判断到期，不无条件联网。自动失败也推迟一天，随机抖动只延后检查。用户主动打开列表或点击刷新可立即获取；列表成功后同样更新本地检查时间，已读响应直接更新角标，避免紧接着重查。

后台、离线、退出状态不自动检查。时间与角标按账号隔离；退出清理正文和会话，可以保留隔离的检查时间摘要以防重新登录反复拉取。存储不可用、不同设备仍可能分别检查；服务端的间隔提示不是跨设备一天一次的硬限流。

正文只按纯文本显示，收到不等于已读；详情打开或用户明确操作后再上报。刷新列表须处理撤回/过期，替换有效数据而非只追加。分页期间若有新发布，从第一页刷新并按ID去重。未读是全体有效通告的未读数，不只是当前页数量；404可能表示刚过期/撤回，重新获取列表。

自动发现允许延迟一天，不是应用关闭后的系统推送。管理员运维告警与用户通告分开，不向普通客户端调用 `/admin/*`。详细字段见 [用户通告](customer-notices.md)。

## 10. 错误处理与诊断

解析HTTP状态、JSON的 `error_code` / `detail` / `retryable` 和响应头 `Retry-After` / `X-Request-ID`；未知字段或非JSON错误用通用提示兜底。请求ID有时只在响应头，不假定正文一定包含。流式开始后还须解析错误事件。

| 错误类型/代码 | 客户端动作 |
|---|---|
| 本人账号401 | 合并令牌刷新；失败转登录，不递归刷新 |
| 403、password_change_required | 展示封禁、权限或先改密提示，不自动重试 |
| email_verification_required / email_verification_invalid | 输入六位码或重新获取，保留用户输入的邮箱 |
| email_rate_limited | 至少遵守Retry-After，不自动循环发信 |
| email_in_use / email_already_verified / email_binding_changed | 提示占用或刷新账号状态，不按显示名猜测邮箱 |
| email_delivery_unavailable / registration_disabled | 提示发信服务异常或暂停注册，不跳过验证码 |
| provider_auth_failed / provider_credit_exhausted | 联系管理员；不清除用户登录状态 |
| provider_region_restricted | 提示上游地区限制，不反复登录或自动重试 |
| global_cloud_disabled / global_budget_exhausted | 全站停用或预算耗尽，不解释为个人额度清零 |
| account_luna_budget_exhausted / account_asr_budget_exhausted / account_tts_budget_exhausted | 明确显示对应个人额度不足 |
| account_daily_limit / key_token_budget_exhausted | 个人请求数或当前Key额度限制 |
| provider_rate_limited / account_rate_limited / account_concurrency_limited | 等待已有请求或遵守Retry-After；不重放可能有副作用的请求 |
| provider_stream_interrupted、网络中断 | 显示未完成和请求ID，不自动重放 |
| 400/422、unsupported_audio_format | 修正参数、模型或音频格式，不用重试掩盖协议错误 |

普通只读请求可有限退避；不要仅凭HTTP429或502决定重新登录或重发POST。仓库示例的类型化错误处理见 `scripts/clients/errors.py`。

建议附加诊断头：

| 头 | 内容 |
|---|---|
| `X-Client-Version` | 应用名称/版本，最多128字符 |
| `X-Device-ID` | 随机安装ID，最多128字符；不要用硬件序列号、MAC或邮箱 |
| `User-Agent` | 应用与版本，不带凭据；服务端保存上限512字符 |
| `X-Client-Request-ID` | 每次逻辑请求的随机关联ID，不提供幂等保证 |

给用户提供复制 `X-Request-ID` 的入口。目录查询不产生逐次账本，不能假定所有请求ID都有可查询的推理明细。IP由可信入口记录，客户端不填CF-Connecting-IP、CF-Ray或X-Forwarded-For；不把令牌、设备信息塞入URL。自建浏览器WebSocket不能任意加头，鉴权遵循已有安全子协议。

常规日志不记录聊天正文、音频、验证码、密码或完整令牌。设备ID仅用于诊断，不参与认证和额度。诊断包范围见 [网络诊断](network-diagnostics.md)。

## 11. 资源策略与兼容边界

应节省重复数据库查询、计费请求、重复刷新和无效重连；不要过度限制必要的手动操作或降低PCM质量。HTML、哈希JS/CSS由免费静态托管提供，按HTTP缓存头使用，不自行改写资源URL或禁用缓存。客户端无需感知索引、数据库触发器或请求写入合并，也不要直连D1。

服务端仍实时校验认证、封禁、权限、并发和预算，本地缓存不替代这些检查。通知采用每天一次自动检查；模型缓存与用量按需刷新，不把所有资源一律降为一天一次。云语音继续HTTP，自建协议独立；特殊识别格式可能需要源站，详见上述语音章节。[服务端资源策略与保留表](resource-efficiency.md)。

## 12. 客户端验收清单

- 账号令牌和Key两种方式均能发现获授权模型；无效/撤销凭据不绕过鉴权。
- 注册验证码保留前导零；旧账号有可稍后处理的绑定提醒，绑定后原登录名不变。
- 多个请求同时401只刷新一次，并原子替换令牌对；提供方密钥异常不触发用户重新登录。
- 语音模型按HTTP调用；PCM可跨奇数长度块拼接，取消生成/播放能取消读取。
- SSE断流、缺少完成事件或PCM传输失败不显示为完整成功，不自动重复计费或工具调用。
- 通知刷新页面/重新登录/恢复前台不会绕过每天自动检查间隔，手动刷新可用；已读更新角标不重复查询。
- 切换账号/Key隔离模型及通知缓存，退出清理敏感数据，客户端日志无凭据或原始内容。
- 模型发现不计为推理用量；余额不重复扣reserved；历史明细为空或诊断字段为空有正确提示。

排查新出现的模型参数错误时，服务端Worker日志可按X-Request-ID查看脱敏的上游错误分类及指定工具的Schema结构摘要；客户端无需为此上传整段聊天、音频或凭据。历史请求不能补录未保存的Schema。服务端日志不改变错误响应契约，客户端仍按上述错误码及流式完成规则处理；内部账号错误也可能返回request_id供关联排查。

## 图片与并发错误更新

Luna 已开放标准 Chat image_url 和 Responses input_image，模型发现声明 text、image 输入；图片来源、大小及预留额度详见 [Luna 图片输入](luna-allowance.md#图片输入)。最多 2 张图（含历史）、JSON 请求体 4 MiB。

账号并发在对话、ASR、TTS 间共享。HTTP 429 的 `error_code=account_concurrency_limited` 表示同时进行的请求过多，不代表日额度耗尽；响应包含同值 `X-Error-Code`、`request_id` / `X-Request-ID`、`retryable:true` 和 `Retry-After:1`。Retry-After 只是最短重试间隔，不保证 1 秒后有空位。客户端应保留错误码，取消不再使用的对话请求，并按需提示重试，避免无上限自动重试。

收到完整 JSON usage，或 SSE 的完成标记与 usage 后，服务端即释放名额；客户端取消也释放名额。未知的提供方费用仍占用额度预留，与并发名额独立。

## 安卓客户端：邮箱自助找回密码

安卓可以直接使用已上线的 HTTP 接口实现原生“忘记密码”页面，无需打开网页、接收深链或读取短信。**只能使用已验证并绑定的邮箱**；新密码为 6–128 字符，原登录名不变。联系邮箱不是自动增加的登录别名，用户名账号绑定邮箱后仍使用原用户名登录。

### 入口和页面流程

1. 登录页提供“忘记密码？”入口，进入独立找回页面。填写绑定邮箱，先在应用内 WebView 完成 Turnstile 人机验证，获取一次性 token，再点击/提交“发送重置验证码”。
2. 展示通用发送提示和重发倒计时。用户从邮件手动填写六位验证码，再输入新密码、确认新密码；两次不一致时在本地拦截。
3. 默认保留 API Key。可在“怀疑账号被盗？”展开项下提供“同时停用全部 API Key”复选框，默认不勾选，明确说明相关应用会停止调用。普通用户无需看到 Key 管理入口。
4. 提交成功后清空密码与验证码、清理被重置账号的本地认证状态，再返回普通登录页。**不自动登录，不自动创建新 API Key**。

### 请求一：发送重置验证码

```http
POST https://accounts.hilex.me/auth/password-reset/code
Content-Type: application/json

{"email":"owner@example.net","captcha_token":"本次Turnstile验证返回的token"}
```

成功响应 HTTP 200：

```json
{
  "message": "若该邮箱已验证并绑定可用账号，您将收到密码重置验证码，请检查收件箱及垃圾邮件",
  "expires_in": 600,
  "retry_after": 60
}
```

200 表示请求已受理，不表示邮箱一定存在或邮件已经送达；发送由服务端异步处理。不要显示“账号存在”或“验证码保证已发送”。提示检查收件箱和垃圾邮件，未验证或未绑定邮箱的账号联系管理员。暂停公开注册不影响已有账号找回。

发送按钮根据 retry_after 禁用；收到 429 时读取响应头 Retry-After。倒计时使用单调时钟截止时间（例如 SystemClock.elapsedRealtime），从后台恢复时重新计算，不依赖页面每秒减一。禁止后台自动重发；按钮防重复点击，切换页面也不能绕过服务端限频。

### 请求二：校验验证码并设置新密码

```http
POST https://accounts.hilex.me/auth/password-reset
Content-Type: application/json

{
  "email": "owner@example.net",
  "code": "012345",
  "new_password": "example-new-password",
  "revoke_api_keys": false
}
```

示例密码仅示意。code 必须为字符串，保留前导零；只接受六位 ASCII 数字。邮箱可去首尾空白并按 Locale.ROOT 转小写，**密码不要 trim 或自动转换大小写**。确认密码只在本地比对，不发送 confirm_password 等未开放字段。revoke_api_keys 必须为 JSON 布尔值，省略等同 false，不能传字符串 "false"。

成功响应 HTTP 200：

```json
{
  "ok": true,
  "api_keys_revoked": false,
  "message": "密码已重置，原登录会话均已退出，请使用原登录名和新密码重新登录。API Key 保持有效。"
}
```

验证码有效期十分钟、最多五次校验尝试；重发使旧挑战失效。注册、绑定和找回验证码不能互换；已消费的找回码不能再次提交。提交中禁用按钮，不并行发送多次重置请求。

### Retrofit / Kotlin 接口示意

以下仅展示协议；沿用客户端现有 JSON 序列化方案，不新增 SDK 或鉴权辅助类。使用 Gson 时的字段映射示例：

```kotlin
data class ResetCodeRequest(
    val email: String,
    @SerializedName("captcha_token") val captchaToken: String,
)
data class ResetCodeResponse(
    val message: String,
    @SerializedName("expires_in") val expiresIn: Int,
    @SerializedName("retry_after") val retryAfter: Int,
)
data class ResetPasswordRequest(
    val email: String,
    val code: String,
    @SerializedName("new_password") val newPassword: String,
    @SerializedName("revoke_api_keys") val revokeApiKeys: Boolean = false,
)
data class ResetPasswordResponse(
    val ok: Boolean,
    val message: String,
    @SerializedName("api_keys_revoked") val apiKeysRevoked: Boolean,
)
interface PasswordRecoveryApi {
    @POST("auth/password-reset/code")
    suspend fun sendCode(@Body body: ResetCodeRequest): Response<ResetCodeResponse>

    @POST("auth/password-reset")
    suspend fun reset(@Body body: ResetPasswordRequest): Response<ResetPasswordResponse>
}
```

baseUrl 使用 `https://accounts.hilex.me/`，保留末尾斜杠；注解路径不要重复写域名或 /v1。SerializedName 来自 Gson，POST / Body / Response 来自 Retrofit。Moshi 或 kotlinx.serialization 项目使用现有对应注解映射相同 JSON 字段。

这两个请求均为匿名账号接口：**不需要 Authorization、API Key、X-Client-ID、网页 Cookie 或 X-CSRF-Token**。为它们绕过模型鉴权和自动 refresh 拦截器，不伪造浏览器 Origin 或内部头，也不先调用登录。原生安卓不受浏览器 CORS 限制，直接通过 HTTPS 请求账号域名。使用现有安全 HTTP 配置，不关闭证书校验。

Response 非成功时读取 errorBody 并按服务端 error_code 分支，不能只保留 HTTP 状态或异常文案。若客户端统一改写错误体，仍应保留 error_code、request_id（存在时）和 Retry-After。

### 错误与重试

| HTTP / error_code | 安卓处理 |
|---|---|
| 422 invalid_email | 提示邮箱格式不正确 |
| 422 invalid_password | 提示密码需为 6–128 字符 |
| 422 invalid_reset_options | 修正客户端布尔字段，不让用户反复重试 |
| 422 password_reset_code_required | 要求填写六位数字验证码 |
| 400 password_reset_invalid | 通用提示验证码无效、过期或已用；不要推断账号是否存在。按需让用户重新获取 |
| 429 email_rate_limited | 遵守 Retry-After，显示重发倒计时；与模型并发/日额度的 429 分开处理 |
| 503 email_delivery_unavailable | 提示找回服务暂不可用，稍后手动重试；不得绕过验证码 |

请求超时或连接中断不自动重放发送邮件或重置密码：上次操作可能已完成。重置结果不明确时，可提示用户尝试用原登录名和刚设置的新密码正常登录；若失败，再按需获取新验证码。不要在后台自动提交旧验证码。

### 重置成功后的本地状态

- 服务端已撤销被重置账号的全部网页会话和 access/refresh 令牌族；清除本机该账号的 access_token、refresh_token、持久化认证信息与内存会话，取消其进行中的刷新/自动重连任务。
- 防止重置前已启动的 refresh 请求迟到后重新写入旧令牌：沿用账号级互斥或会话版本号，清理时增加版本，只允许当前版本写入。已有多账号客户端仅清理目标账号，不误删其他账号登录。
- 返回登录页，可预填已知的原登录名；不要把绑定邮箱强行覆盖成登录名。不保存新密码用于自动登录。
- API Key 默认保持有效。api_keys_revoked=true 时清除或标记失效该账号本机保存的 Key；不要从普通找回页面申请新 Key，重新创建仍由管理员完成。
- 密码和验证码只在本次表单内存中使用，离页或成功后清空，不写入磁盘、持久化页面状态、日志、埋点或诊断包。不要记录完整请求/响应中的凭据。

### 安卓验收

- 未登录可打开找回页并请求验证码；不携带模型鉴权头，不触发 token refresh。
- "012345" 保留前导零；两次密码不一致、少于六字符均阻止提交；发送/提交按钮能防重复点击。
- 重发倒计时在切后台、回前台和页面重建后正确；429 依据 Retry-After 展示，不循环重发。
- 使用真实测试账号验证重置后旧密码、旧 access/refresh 均失效，新密码可通过原登录名正常登录。
- 默认重置后原 Key 仍能调用；主动选择停用后原 Key 返回认证失败，其他账号 Key 不受影响。
- 过期、重放及注册/绑定用途的验证码均不能重置密码；未知邮箱的发送提示保持通用。
- 重置成功后重启应用仍处于退出状态；迟到的 refresh 不恢复旧登录，表单与日志不残留密码/验证码。

更完整的服务端事务、通知和审计边界见[邮箱找回文档](password-recovery.md)。

## Turnstile 人机验证更新（安卓必须接入）

注册、绑定邮箱、找回密码的发送验证码接口新增必需 captcha_token。原生安卓通过 `https://accounts.hilex.me/auth/captcha?action=password_reset_code` 完成 WebView 验证，经受可信来源限制的 HelixCaptcha WebMessage 桥回传 token，随后使用原生 HTTP 提交；不能直接调用发送接口而省略 proof。注册 action=registration_code，绑定 action=email_binding_code。最终提交邮件验证码的接口不新增 proof 字段。

详细的 WebView 配置、安全桥接示例、一次性 token 生命周期、错误码及验收边界见[人机验证接入](human-verification.md)。旧客户端未接入时发送邮件将返回 captcha_required；不要自动退回无验证发送。

## 本地模型、OpenAI small 嵌入与旧密码改密更新

本地模型已开启目录发现，首次查询即可返回；目录不占推理并发。默认 /v1/models 只列文本输出，嵌入模型需要 ?output_modalities=embeddings 或 all。新增的付费云嵌入仅为 text-embedding-3-small；POST /v1/embeddings、input 字段、默认1536维/可选dimensions，账号token+ClientID或API Key鉴权不变，沿用qwen权限。Luna与small共享云文本月token额度及全站预算，small按自己的价格结算。完整限制和实例见[嵌入与模型发现](openai-embeddings.md)。

记得旧密码时，匿名 `POST https://accounts.hilex.me/auth/password`，提交 email/current_password/new_password 即可修改，无需邮箱验证码、账号token或ClientID。新密码至少6字符，账号 ID 和显示名不变；成功后清除该账号旧access/refresh并返回登录，不自动登录；API Key保留。该接口的401表示邮箱/旧密码校验失败，不能触发刷新令牌。详细流程见[旧密码改密](password-recovery.md#记得旧密码使用邮箱和旧密码改密)。

## 合并用量快照

`GET https://accounts.hilex.me/account/usage-snapshot` 使用账号认证（Bearer access_token，不需要X-Client-ID；站内Cookie同样支持），返回`{usage,luna,audio}`，分别保持原`/account/usage`、`/account/luna-usage`、`/account/audio-usage`的响应结构。API Key不能访问账号快照。新版网页只请求该接口，安卓可在同时显示三类用量时切换到此接口，避免三次认证和HTTP往返；只需一类数据时仍可使用原分项接口。不增加轮询频率，继续按需刷新，不公共缓存账号响应。真实调用的权限/并发和预算不由客户端快照决定。

## 网页个人账号与管理控制台

个人账号页为 https://accounts.hilex.me/ ，管理控制台为 https://accounts.hilex.me/admin 。普通用户没有管理入口，管理员在个人页可进入控制台。管理页面使用同一登录会话并独立校验管理员角色。安卓等客户端继续使用原账号与模型 API，无需修改认证或模型调用路径；客户端的个人通知仍使用 `/account/notices`，不访问管理页面或 `/admin/*`。

## 托管人机验证页自动启动

`/auth/captcha?action=...` 首次进入自动启动一次 Turnstile 挑战，原生客户端需在加载前注册可信来源的 `HelixCaptcha` 消息桥。失败、取消、过期或超时后仅提供“重新验证”，不会自动重试；挑战成功只返回一次性 proof，不自动发送邮件。客户端返回原流程后，由用户手动发送注册、找回密码或绑定邮箱的验证码。

proof 仅保存在内存，过期、取消、改邮箱、切换用途、离页或任何发送尝试后均清除，不能跨请求复用。服务端继续校验用途、域名、有效性和防重放；不会放宽验证要求。窄屏验证弹窗根据实际内容宽度使用 compact/flexible，字体放大时可纵向滚动。本次服务端静态构建和模拟浏览器测试不等同于安卓 Release 构建、真实设备 Turnstile 验证或真实邮件闭环验收。

网页账号中心现已与安卓统一为“完成人机验证 → 手动发送验证码”。验证成功不自动发码；发送按钮只有当前邮箱、用途及账号对应的内存 proof 有效时可用。修改邮箱、切换流程、离开/隐藏页面、过期或任何发送尝试后清除 proof，失败后也必须重新验证；发送冷却结束不代表凭据恢复有效。

安卓托管验证页现采用单张透明宿主卡片：加载、挑战、失败与重试均在同一 dialog 中。成功仍发送 `captcha-completed`；用户点击取消或触发网页 Escape 时发送 `{"type":"captcha-cancelled","action":"本次用途"}`，本次流程结束，客户端关闭验证窗口且丢弃凭据。安卓已对接取消事件；接收端仍须按可信来源、主框架和本次用途校验，忽略已结束流程的迟到消息。网页自行处理可视视口 resize/scroll、键盘遮挡及滚动，不要求原生计算卡片高度；普通账号网页验证弹窗保持原模式。

## 邮箱登录与可重复显示名

账号契约已改为唯一邮箱登录、`display_name` 可重复显示、固定 `id` 关联。登录请求用 `{email,password}`，匿名旧密码修改用 `{email,current_password,new_password}`；不保留 `username` 别名。注册可选填 `display_name`，资料修改用 `PATCH /account/profile`。客户端字段及历史账号处理详见 [邮箱身份迁移文档](client-migration-email-identity.md)，以该文档替代旧的用户名登录示例。

## 更换登录邮箱

已验证邮箱的账号可在资料中更换邮箱；安卓采用相同接口和验证顺序。先填写新邮箱和当前密码，再以 `email_change_code` 用途完成人机验证，手动发送验证码；最终提交新邮箱与邮件验证码。成功后所有设备退出，使用新邮箱与原密码重新登录；Key、额度、显示名和通知已读状态保留。请求字段、错误码和生命周期见 [更换登录邮箱](email-change.md)。不要用历史补绑定接口修改已验证邮箱。
