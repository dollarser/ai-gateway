# 客户端接入与交接

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
| `POST /auth/login` | `{ "username":"原登录名", "password":"用户密码" }`；保存返回的 token 对、有效期和 `user` |
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

登录返回的 `user.email_binding_required=true` 或 `/account/me` 中同名标记为 true 时展示可稍后处理的提醒。预填 `user.email`；为空且 `user.username` 是邮箱时可预填用户名。

- 用户主动发送：`POST /account/email/code`，提交 `{ "email":"user@example.net" }`。
- 完成绑定：`POST /account/email/bind`，提交 `{ "email":"user@example.net","code":"012345" }`。
- 成功后用返回的 user 更新状态并隐藏提醒。**绑定不修改原登录名和密码，也不新增邮箱登录别名**；不要覆盖客户端保存的原登录名。

不得在登录时自动发绑定邮件；注册和绑定验证码不能互换，绑定码也不能跨账号使用。已验证账号的换绑不是当前补绑定接口的用途。详细错误与限频见 [邮箱验证及绑定](email-verification.md)。发信服务的具体供应商属于服务端配置，客户端不保存 SMTP 凭据。

## 4. 模型发现与缓存

完整目录：`GET https://api.hilex.me/v1/models?output_modalities=all`。默认不带参数仅展示文本输出模型，不包含独立识别/合成用途。按 `architecture.output_modalities`、`endpoints` 和 `audio` 能力分组，不把语音模型混入聊天选择器，也不硬编码只有 Qwen。

| 模型 ID | 用途 | API 域名下的接口 |
|---|---|---|
| `gpt-6-luna` | 文本与自定义工具 | `POST /v1/chat/completions`、`POST /v1/responses` |
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
| email_in_use / email_already_verified / email_binding_changed | 提示占用或刷新账号状态，不覆盖原登录名 |
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
