# 客户端接入与交接

OpenAI 出站支持部署时切换 Worker 直连或本机转发，当前默认本机转发。安卓无需自行选择 OpenAI 出口。

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

## 3. 邮箱验证码与人机验证

| 流程 | Turnstile `action` | 手动发送验证码 | 提交邮件验证码 |
|---|---|---|---|
| 注册 | `registration_code` | `POST /auth/registration-code` | `POST /auth/register` |
| 找回密码 | `password_reset_code` | `POST /auth/password-reset/code` | `POST /auth/password-reset` |
| 历史绑定 | `email_binding_code` | `POST /account/email/code` | `POST /account/email/bind` |
| 更换邮箱 | `email_change_code` | `POST /account/email/change/code` | `POST /account/email/change` |

发码请求携带 `captcha_token`。最终提交邮件验证码时按各接口要求提交字段。桥接配置与错误码见[人机验证接入](human-verification.md)。

### 共用人机验证流程

`/auth/captcha?action=...` 首次进入自动启动一次 Turnstile 挑战，原生客户端需在加载前注册可信来源的 `HelixCaptcha` 消息桥。失败、过期或超时后可主动点击“重新验证”；取消会结束本次流程，用户可回到原表单重新发起；挑战成功只返回一次性 proof，不自动发送邮件。客户端返回原流程后，由用户手动发送注册、找回密码或绑定邮箱的验证码。

proof 仅保存在内存，过期、取消、改邮箱、切换用途、离页或任何发送尝试后均清除，不能跨请求复用。服务端继续校验用途、域名、有效性和防重放；不会放宽验证要求。窄屏验证弹窗根据实际内容宽度使用 compact/flexible，字体放大时可纵向滚动。

网页账号中心现已与安卓统一为“完成人机验证 → 手动发送验证码”。验证成功不自动发码；发送按钮只有当前邮箱、用途及账号对应的内存 proof 有效时可用。修改邮箱、切换流程、离开/隐藏页面、过期或任何发送尝试后清除 proof，失败后也必须重新验证；发送冷却结束不代表凭据恢复有效。

安卓托管验证页现采用单张透明宿主卡片：加载、挑战、失败与重试均在同一 dialog 中。成功仍发送 `captcha-completed`；用户点击取消或触发网页 Escape 时发送 `{"type":"captcha-cancelled","action":"本次用途"}`，本次流程结束，客户端关闭验证窗口且丢弃凭据。接收端须按可信来源、主框架和本次用途校验，忽略已结束流程的迟到消息。网页自行处理可视视口 resize/scroll、键盘遮挡及滚动，不要求原生计算卡片高度；普通账号网页验证弹窗保持原模式。

### 新注册

1. `GET /auth/registration-info`，检查 `registration_enabled`、`email_verification` 和默认额度；`email_verification_available` 仅表示配置完整，不保证实际邮件送达。
2. 使用 `registration_code` 用途完成人机验证，再由用户点击发送，调用 `POST /auth/registration-code` 提交 `{ "email":"user@example.net", "captcha_token":"本次 proof" }`。
3. `POST /auth/register`，提交邮箱、密码和六位字符串验证码：

```json
{"email":"user@example.net","password":"用户选择的密码","code":"012345"}
```

密码要求6–128字符。成功返回201，随后正常登录。验证码十分钟有效、最多五次校验尝试、同邮箱至少六十秒重发间隔；以实际错误和 Retry-After 为准。保留前导零，不将 code 转为数字，不自动循环发信。成功消费后服务端清空验证码校验值，已用或过期码不能复用。

### 历史账号

登录返回的 `user.email_binding_required=true` 或 `/account/me` 中同名标记为 true 时展示可稍后处理的提醒。只预填 `user.email`；显示名不能推导邮箱。无邮箱账号先由管理员按 ID 设置登录邮箱。

- 用户先用 `email_binding_code` 用途完成人机验证，再手动发送：`POST /account/email/code`，提交 `{ "email":"user@example.net","captcha_token":"本次 proof" }`。
- 完成绑定：`POST /account/email/bind`，提交 `{ "email":"user@example.net","code":"012345" }`。
- 成功后用返回的 user 更新状态并隐藏提醒。**验证绑定后的 email 就是登录邮箱**；更新客户端保存的邮箱。账号 ID、密码、权限与既有令牌不变。

不得在登录时自动发绑定邮件；注册和绑定验证码不能互换，绑定码也不能跨账号使用。已验证账号的换绑不是当前补绑定接口的用途。详细错误与限频见 [邮箱验证及绑定](email-verification.md)。发信服务的具体供应商属于服务端配置，客户端不保存 SMTP 凭据。

## 4. 模型发现与缓存

完整目录：`GET https://api.hilex.me/v1/models?output_modalities=all`。默认不带参数仅展示文本输出模型，不包含独立识别/合成用途。按 `architecture.output_modalities`、`endpoints` 和 `audio` 能力分组，不把语音模型混入聊天选择器，也不硬编码只有 Qwen。

以下是目录条目示例。

| 模型 ID | 用途 | API 域名下的接口 |
|---|---|---|
| `gpt-6-luna` | 文本、图片输入与自定义工具 | `POST /v1/chat/completions`、`POST /v1/responses` |
| `gpt-transcribe` | 音频识别 | `POST /v1/audio/transcriptions` |
| `gpt-realtime-2.1-mini` | 文字合成语音 | `POST /v1/audio/speech` |

以响应中的模型 ID 和能力为准。支持的语言模型包括 GPT‑6 Luna、Sol、Astra，GPT‑6.1 Sol、Terra，GPT‑6.2 Sol、Astra，以及已运行且获授权的自建对话模型。客户端不要为新型号维护固定允许列表，也不要以显示名代替模型 ID。仅具备 ASR/TTS 权限的 Key 可以发现其自身可用的模型。

用户页保存的授权立即作用于公网目录和实际调用，同时约束登录令牌和该账号名下的所有 API Key。新账号默认模型只在创建时分配；修改默认列表不改变已有账号。模型还受服务权限、云模型暂停状态和本机部署可达性约束。用户当前目录为空时照常显示空状态，不回退到硬编码的模型。

安卓建议在登录成功、切换账号/Key、进入模型选择器或从后台回来时按需更新。可合并并发目录读取、提示用户手动刷新，并在 `403 model_not_allowed` 时使目录缓存失效及重新查询。用新列表替换该凭据的旧列表，更新已选模型的可用状态；不要自动换模型并重放原请求。目录请求不占推理并发、不扣日请求数。自建后端的短时目录缓存独立于账号授权；若看见 `X-Model-Catalog-Partial: local_unavailable`，仍可使用本次返回的模型。[模型发现](model-discovery.md)

管理员授予 GPT‑6.2 Sol 后，客户端刷新目录即可看到可用的 Sol 条目。撤销授权后，刷新会移除该条目；若仍选中它，应提示用户重新选择。若客户端继续提交原模型 ID，收到 `403 model_not_allowed` 时使目录缓存失效，再查询该账号的目录。

通过 `output_modalities=embeddings` 或 `all` 发现嵌入模型。付费云嵌入模型为 text-embedding-3-small；POST /v1/embeddings、input 字段、默认1536维/可选dimensions，账号token+ClientID或API Key鉴权不变，沿用qwen权限。Luna与small共享云文本月token额度及全站预算，small按自己的价格结算。完整限制和实例见[嵌入与模型发现](openai-embeddings.md)。

## 5. Luna 文本与工具调用

普通文本使用标准 Chat Completions 或 Responses 请求，model 精确为 `gpt-6-luna`。示例：

```json
{"model":"gpt-6-luna","messages":[{"role":"user","content":"你好"}],"max_completion_tokens":256,"stream":true}
```

Chat 带工具时客户端使用 `reasoning_effort:"none"`，网关也会做兼容处理；需要推理加工具时使用 Responses。两种接口的消息、工具及推理字段不同，不直接复用同一请求对象。客户端必须提交完整上下文，不能假设服务端保存对话或支持隐藏状态引用。

保存 `X-Request-ID` 和可选 `X-Inference-Compatibility`。不要因 medium/none 的工具兼容问题反复提交同一调用。完整支持范围和工具回传格式见 [Luna 协议](luna-allowance.md)。

Luna 已开放标准 Chat image_url 和 Responses input_image，模型发现声明 text、image 输入；图片来源、大小及预留额度详见 [Luna 图片输入](luna-allowance.md#图片输入)。云聊天和 Responses 每请求最多 8 张图（含历史），完整 JSON 上限为 12 MiB。输入预估与输出预留合计最多 1,050,000 tokens，启用搜索时还需在同一上限内预留搜索上下文。

### 安卓接入 Luna 网页搜索

仅当模型目录的 Luna 条目包含 `responses_tools: ["web_search"]`（或数组包含该值）时显示内置联网搜索入口。该能力属于 `POST https://api.hilex.me/v1/responses`。账号登录调用使用 `Authorization: Bearer <access_token>` 与 `X-Client-ID`，网关 API Key 调用仅使用 Bearer Key。保留原有自定义 function 工具，用 `type` 区分服务端搜索和客户端函数。

```json
{
  "model": "gpt-6-luna",
  "input": "查找 OpenAI 官方 Luna 模型页并给出来源",
  "tools": [{"type":"web_search","search_context_size":"low"}],
  "include": ["web_search_call.action.sources"],
  "stream": true
}
```

- `search_context_size` 支持 `low`、`medium`、`high`，可省略（默认 `low`）。每次响应最多一个内置工具调用；`max_tool_calls` 可省略，显式发送时只能为 1。`include` 可省略，若发送只能是上例的来源字段。
- 默认工具选择由模型决定，允许未实际执行搜索。用户明确要求必须搜索时可传 `"tool_choice":{"type":"web_search"}`。关闭搜索时从请求移除搜索工具及其专用字段。
- JSON 响应识别 `output[].type=web_search_call`，正文的 `output[].content[].annotations[]` 中解析 `url_citation` 并展示可点击、可复制的来源。请求 `include` 后可额外读取搜索项的 `action.sources`。原生打开来源只允许预期的 HTTP(S) 网页链接。
- SSE 复用 Responses 的文本和完成事件处理，保留最终 `response.completed.response` 中的来源与计量。搜索事件可用来更新「正在搜索」状态；收到搜索中间事件或 URL 不能当作响应已完成。内置搜索在服务端执行，安卓不要为 `web_search_call` 再执行本地搜索或回传 function 结果。
- 实际计费次数可读取最终响应的 `tool_usage.web_search.num_requests`，字段可能为空或缺失。余额以账号快照为准，不根据工具事件个数、引用数或本地计数推导。缺少最终计量、取消或断流可能保留预留，不能自动重放。

默认每账号每天 30 次，登录与名下 API Key 共用；管理员可调整，0 表示关闭。每日北京时间 00:00 重置。搜索仍受云文本月额度和全站预算限制。安卓用 `error.code=web_search_daily_limit` 与 `X-Helix-Resets-At` 显示上限提示；账号搜索上限为 0 时提示联系管理员开启。[搜索参数和计费](luna-allowance.md#luna-内置网页搜索)

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

安卓用量页优先请求 `GET https://accounts.hilex.me/account/usage-snapshot`，账号 Bearer 鉴权，无需 `X-Client-ID`，API Key 无权读取。返回 `usage`、`luna`、`audio`、`web_search`、`history_next`：

| 字段 | 客户端展示 |
|---|---|
| `web_search.day`、`timezone` | 额度统计日，时区为 `Asia/Shanghai` |
| `web_search.limit`、`used`、`reserved`、`remaining` | 每日上限、已结算、待核对预留、可用次数；剩余已扣预留，不再次扣除 |
| `web_search.resets_at` | ISO 8601 时间，解析为 Instant 后按需显示北京时间或本地时间 |
| `usage.requests` | 首屏最多 20 条，每条仅含 `started`、`ended`、`service`、`status`、`response_bytes` |
| `history_next` | 下一页不透明字符串游标；`null` 时结束 |

续页请求 `GET /account/usage-history?before=<history_next>`，沿用账号鉴权，通过 Retrofit `@Query("before")` 正常 URL 编码，不拆解游标，也不二次编码。响应为 `{requests,next}`，把记录追加到同一账号的列表，下一次使用 `next`。手动刷新、退出或切换账号后丢弃旧游标与旧请求结果；续页不重新查询额度。

默认个人额度为Luna每月1000万tokens、ASR每天30分钟、TTS每天50万字符。管理员可调整，以服务端字段为准，不在客户端写死。全站Luna另有每月200美元估算预算；全站预算耗尽不代表个人额度被清零。

服务端按 `Asia/Shanghai` 自然日/月重置，客户端本地时区不改变额度周期；优先使用服务端 `resets_at` 显示重置时间。通知的 starts_at / expires_at / published_at / read_at 及 email_verified_at 是Unix秒，可包含小数；expires_in、refresh_expires_in、retry_after 是相对秒，resets_at 是ISO8601时间字符串。不要与音频毫秒或JavaScript毫秒时间戳混淆。

用量页进入时或用户手动刷新时获取；请求完成优先使用响应usage展示，不在每次推理前后固定查询所有账号接口。本地余额只是展示，不参与服务端放行、并发或扣费判断。

**明细不是完整历史**：旧模型目录记录在当日额度窗口结束后可归档，普通无财务关联的请求结束90天后可归档，财务关联请求保留。归档保留每日汇总，管理员历史日统计已合并汇总；客户端不应从有限requests数组反推累计调用数，也不能把明细为空解释为从未使用。分页只覆盖仍保留的明细。个人快照和续页不返回 IP、UA 或设备标识。

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

OpenAI 兼容推理接口统一使用 OpenAI 的 `{"error":{"message":"…","type":"…","param":null,"code":"…"}}`。客户端在官方 API 和 Helix 上使用同一解析器，并以 HTTP 状态及 `error.message` 兜底。账号接口仍使用顶层 `error_code` 和 `detail`。

`X-Request-ID` 用于关联当前入口；网关收到上游请求 ID 时会在错误响应附上 `X-OpenAI-Request-ID`。网关自身拒绝可通过 `X-Helix-Error-Code` 区分。有 `Retry-After` 时遵循响应头。流式开始后继续检查错误事件和完成事件。上游有标准 JSON 错误时保留 HTTP 状态和标准字段；与网关自身上游凭据有关的拒绝使用服务错误响应。

| 错误类型/代码 | 客户端动作 |
|---|---|
| 本人账号401 | 合并令牌刷新；失败转登录，不递归刷新 |
| `403 model_not_allowed` | 模型权限已变更，刷新模型列表并提示重新选择；不清令牌、不重发原请求 |
| `413 request_body_too_large` | 缩小完整 JSON，优先压缩内联图片，或改用可访问的 HTTPS 图片 URL |
| `413 too_many_images` | 减少随请求携带的历史图片或拆分图片任务 |
| `413 input_estimate_too_large` | 精简历史、减少图片或降低请求的最大输出量 |
| `429 web_search_daily_limit` | 显示搜索额度限制及响应头 `X-Helix-Resets-At`；不触发令牌刷新，也不自动重试 |
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

账号并发在对话、ASR、TTS 间共享。HTTP 429 的 `error.code=account_concurrency_limited` 表示同时进行的请求过多，不代表日额度耗尽；响应包含`X-Request-ID` 和 `Retry-After: 1`。Retry-After 只是最短重试间隔，不保证 1 秒后有空位。客户端应保留错误码，取消不再使用的对话请求，并按需提示重试，避免无上限自动重试。

收到完整 JSON usage，或 SSE 的完成标记与 usage 后，服务端即释放名额；客户端取消也释放名额。未知的提供方费用仍占用额度预留，与并发名额独立。

Anthropic Messages 尚未配置上游。`/v1/messages` 返回 Anthropic 格式的 404，响应头 `X-Helix-Error-Code: anthropic_not_configured` 表明请求由网关结束。

### 客户端解析样例

以下是脱敏样例，省略与该测试无关的字段。

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
X-Helix-Resets-At: 2026-11-24T16:00:00.000Z

{"error":{"message":"网页搜索日额度已用完","type":"rate_limit_error","param":null,"code":"web_search_daily_limit"}}
```

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
X-Error-Code: account_concurrency_limited
X-Request-ID: example-request
Retry-After: 1

{"error":{"message":"账号并发已满","type":"rate_limit_error","param":null,"code":"account_concurrency_limited"}}
```

Responses 已输出部分内容，随后收到错误事件：

```text
data: {"type":"response.output_text.delta","delta":"部分文本"}

data: {"type":"error","sequence_number":1,"code":"provider_stream_interrupted","message":"模型响应未完整结束，已保留待核对额度","param":null}

```

直接断流时可能收不到错误事件，仍要检查 `response.completed`。PCM 回归可模拟 HTTP 200 后先返回一段有效音频，再抛出读取异常。预期停止播放、标记中断并保留请求 ID；正常 EOF 按音频流结束处理。

## 11. 资源策略与兼容边界

应节省重复数据库查询、计费请求、重复刷新和无效重连；不要过度限制必要的手动操作或降低PCM质量。HTML、哈希JS/CSS由免费静态托管提供，按HTTP缓存头使用，不自行改写资源URL或禁用缓存。客户端无需感知索引、数据库触发器或请求写入合并，也不要直连D1。

服务端仍实时校验认证、封禁、权限、并发和预算，本地缓存不替代这些检查。通知采用每天一次自动检查；模型缓存与用量按需刷新，不把所有资源一律降为一天一次。云语音继续HTTP，自建协议独立；特殊识别格式可能需要源站，详见上述语音章节。[服务端资源策略与保留表](resource-efficiency.md)。

## 12. 客户端验收清单

每轮验收记录服务端提交、安卓提交或构建号、环境、日期和结果链接。

| 验收范围 | 证据 |
|---|---|
| Worker 协议 | 仓库 `cloudflare/tests/accounts.test.mjs` 的额度和并发断言、`cloudflare/tests/stream-safety.test.mjs` 的流式检查 |
| 托管验证页 | 仓库 `tests/browser_captcha.py` 检查页面交互与消息桥 |
| 安卓 Release | 对应提交、制品和测试结果。本次文档修订未运行 |
| 真机 Turnstile 和真实邮件闭环 | 设备、系统版本、服务端版本及脱敏结果。本次文档修订未运行 |

- 账号令牌和Key两种方式均能发现获授权模型；无效/撤销凭据不绕过鉴权。
- 注册验证码保留前导零；注册、找回、邮箱绑定和更换邮箱都先完成人机验证，再手动发码。旧账号允许稍后绑定，绑定后的邮箱用于登录。
- 多个请求同时401只刷新一次，并原子替换令牌对；提供方密钥异常不触发用户重新登录。
- 语音模型按HTTP调用；PCM可跨奇数长度块拼接，取消生成/播放能取消读取。
- SSE断流、缺少完成事件或PCM传输失败不显示为完整成功，不自动重复计费或工具调用。
- 通知刷新页面/重新登录/恢复前台不会绕过每天自动检查间隔，手动刷新可用；已读更新角标不重复查询。
- 切换账号/Key隔离模型及通知缓存，退出清理敏感数据，客户端日志无凭据或原始内容。
- 同一安卓版本在两个账号切换后能展示不同的模型授权；后台单独授权 Sol 后刷新即出现，撤销后目录移除且直传 ID 返回 `model_not_allowed`。
- Luna 搜索使用 Responses，JSON 和 SSE 都保留引用；搜索失败/取消不将发起次数当作已结算次数，不自动重试找回结果。
- 搜索额度显示已用、预留、剩余和重置时刻；覆盖停用、用尽 `429`、令牌有效且不应刷新三个条件。
- 用量首屏和续页能顺序追加，`next=null` 停止；切换账号时迟到的分页响应不会混入新账号。
- 模型发现不计为推理用量；余额不重复扣reserved；历史明细为空或诊断字段为空有正确提示。

排查新出现的模型参数错误时，服务端Worker日志可按X-Request-ID查看脱敏的上游错误分类及指定工具的Schema结构摘要；客户端无需为此上传整段聊天、音频或凭据。历史请求不能补录未保存的Schema。服务端日志不改变错误响应契约，客户端仍按上述错误码及流式完成规则处理；内部账号错误也可能返回request_id供关联排查。

## 安卓客户端：邮箱自助找回密码

安卓可以直接使用已上线的 HTTP 接口实现原生“忘记密码”页面，无需打开网页、接收深链或读取短信。**只能使用已验证并绑定的邮箱**；新密码为 6–128 字符，重置后使用该邮箱和新密码登录。

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
  "message": "密码已重置，原登录会话均已退出，请使用登录邮箱和新密码重新登录。API Key 保持有效。"
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

请求超时或连接中断不自动重放发送邮件或重置密码：上次操作可能已完成。重置结果不明确时，可提示用户尝试用登录邮箱和刚设置的新密码正常登录；若失败，再按需获取新验证码。不要在后台自动提交旧验证码。

### 重置成功后的本地状态

- 服务端已撤销被重置账号的全部网页会话和 access/refresh 令牌族；清除本机该账号的 access_token、refresh_token、持久化认证信息与内存会话，取消其进行中的刷新/自动重连任务。
- 防止重置前已启动的 refresh 请求迟到后重新写入旧令牌：沿用账号级互斥或会话版本号，清理时增加版本，只允许当前版本写入。已有多账号客户端仅清理目标账号，不误删其他账号登录。
- 返回登录页，可预填已知的登录邮箱。不保存新密码用于自动登录。
- API Key 默认保持有效。api_keys_revoked=true 时清除或标记失效该账号本机保存的 Key；不要从普通找回页面申请新 Key，重新创建仍由管理员完成。
- 密码和验证码只在本次表单内存中使用，离页或成功后清空，不写入磁盘、持久化页面状态、日志、埋点或诊断包。不要记录完整请求/响应中的凭据。

### 安卓验收

- 未登录可打开找回页并请求验证码；不携带模型鉴权头，不触发 token refresh。
- "012345" 保留前导零；两次密码不一致、少于六字符均阻止提交；发送/提交按钮能防重复点击。
- 重发倒计时在切后台、回前台和页面重建后正确；429 依据 Retry-After 展示，不循环重发。
- 使用真实测试账号验证重置后旧密码、旧 access/refresh 均失效，新密码可通过登录邮箱正常登录。
- 默认重置后原 Key 仍能调用；主动选择停用后原 Key 返回认证失败，其他账号 Key 不受影响。
- 过期、重放及注册/绑定用途的验证码均不能重置密码；未知邮箱的发送提示保持通用。
- 重置成功后重启应用仍处于退出状态；迟到的 refresh 不恢复旧登录，表单与日志不残留密码/验证码。

更完整的服务端事务、通知和审计边界见[邮箱找回文档](password-recovery.md)。

## 记得旧密码时改密

记得旧密码时，匿名 `POST https://accounts.hilex.me/auth/password`，提交 email/current_password/new_password 即可修改，无需邮箱验证码、账号token或ClientID。新密码至少6字符，账号 ID 和显示名不变；成功后清除该账号旧access/refresh并返回登录，不自动登录；API Key保留。该接口的401表示邮箱/旧密码校验失败，不能触发刷新令牌。详细流程见[旧密码改密](password-recovery.md#记得旧密码使用邮箱和旧密码改密)。

## 网页个人账号与管理控制台

个人账号页为 https://accounts.hilex.me/ ，管理控制台为 https://accounts.hilex.me/admin 。普通用户没有管理入口，管理员在个人页可进入控制台。管理页面使用同一登录会话并独立校验管理员角色。安卓等客户端继续使用原账号与模型 API，无需修改认证或模型调用路径；客户端的个人通知仍使用 `/account/notices`，不访问管理页面或 `/admin/*`。

## 邮箱登录与可重复显示名

账号契约已改为唯一邮箱登录、`display_name` 可重复显示、固定 `id` 关联。登录请求用 `{email,password}`，匿名旧密码修改用 `{email,current_password,new_password}`；不保留 `username` 别名。注册可选填 `display_name`，资料修改用 `PATCH /account/profile`。客户端字段及历史账号处理详见 [邮箱身份迁移文档](client-migration-email-identity.md)，以该文档替代旧的用户名登录示例。

## 更换登录邮箱

已验证邮箱的账号可在资料中更换邮箱；安卓采用相同接口和验证顺序。先填写新邮箱和当前密码，再以 `email_change_code` 用途完成人机验证，手动发送验证码；最终提交新邮箱与邮件验证码。成功后所有设备退出，使用新邮箱与原密码重新登录；Key、额度、显示名和通知已读状态保留。请求字段、错误码和生命周期见 [更换登录邮箱](email-change.md)。不要用历史补绑定接口修改已验证邮箱。

显示名修改仅需账号登录态：`PATCH /account/profile {"display_name":"新显示名"}`，不要求当前密码，不发送 `current_password`。Cookie 写操作仍需 CSRF，API Key 不可修改资料，每 24 小时一次限制保留。
