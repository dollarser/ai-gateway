# 网络与地区限制排障

入口节点、Worker 执行位置、参考出口 IP、OpenAI 实际来源判定是不同的信息。本功能提供关联证据，不固定地区、不改变路由，也不保证消除上游访问限制。

## 后台入口

管理员展开“地区与节点成功率、参考探测”，选择最近 1 小时、24 小时或 7 天，按客户端国家、入口节点、模型筛选。表格按国家/节点/模型/协议分组，列出收到请求、上游尝试、成功、失败、进行中及地区拒绝。

成功率按成功数 / 已结束请求数计算；收到请求包括本地参数或预算拒绝，上游尝试单独统计。样本不足 20 条会提示，不能把几次 JP/HK 测试当成确定因果。历史缺失国家/节点显示 UNKNOWN。数据仅代表仍保留的网关记录，不是 OpenAI 全量账单或服务全球状态。

“按请求 ID 诊断”填写服务端 X-Request-ID 后可下载 JSON 脱敏包，包含 UTC 时间、模型、协议、发布提交、上游状态/错误码、OpenAI request ID、上下游 CF-Ray、入口和客户端粗粒度地区，以及关联参考探测。排除账号、邮箱、客户端 IP、设备、UA、对话、工具参数、音频和凭据；若参考 IP 恰好等于记录的客户端 IP，导出时也隐藏该值。导出写管理员审计，包不自动发送给第三方。

## 参考连接

节省免费额度的默认配置关闭已接受请求的自动探测（PROVIDER_DIAGNOSTICS_ENABLED=false），保留上游 403 的自动采样及管理员手动探测。403 按入口节点每五分钟最多一次，不阻塞模型响应。排障期间可临时将该开关改为 true，恢复 HTTP 2xx / WebSocket 101 的参照采样；已接受只表示握手/HTTP 成功，不等同于生成最终完成。

1. 固定 IP 回显服务：优先 api64.ipify.org，失败后尝试 api.ipify.org；每个连接超时 3 秒，响应上限 256 字节，分别记录耗时、HTTP 状态和错误阶段。
2. 自有接收端：Worker GET https://api.hilex.me/__diagnostics/network，经现有受保护隧道进入本机。新建请求只带临时 HMAC 签名、时间和随机 nonce，不发送 OpenAI Key、账号 token、Client ID、Cookie 或用户内容。接收端校验来源为回环隧道、签名有效且在 60 秒内，拒绝重放；仅返回允许的 CF/IP 元数据，以及敏感请求头是否存在的布尔值。

自有接收端是 same_zone_tunnel 参考，TCP 对端是本地隧道进程，**不直接观察 Worker 的公网 TCP 源 IP**。不同目的地可能使用不同 IPv4/IPv6、路由和 Cloudflare 请求头处理。因此不能把参考 IP、同 zone 接收端的请求头认作 OpenAI 当次收到的内容。

公网直接访问 `/__diagnostics/network` 返回 404；接收端不能用作公开回显或任意代理。HMAC 使用现有内部服务凭据派生签名，不发送密钥原文；其轮换仍需同步 Worker 和源站。

## 探测诊断字段

| 字段/状态 | 含义 |
|---|---|
| egress_probe_stage | connect / headers / read / validate / complete |
| egress_probe_error | timeout、fetch_type_error、http_NNN、invalid_json、invalid_ip、body_too_large 等安全枚举，不记录原始异常内容 |
| egress_probe_http_status / duration_ms | 参考服务响应状态和该次尝试耗时 |
| observed_reference | 固定回显服务返回有效 IPv4/IPv6 |
| observed_metadata | 自有签名接收端返回经过校验的允许元数据 |
| sampled_out | 本节点/结果采样窗口已有探测 |
| network_observations | 关联探测尝试和接收端结果，保留 7 天；导出时隐藏可能含客户端 IP 的头值 |

之前的探测实现使用 `redirect:"error"`，Worker 会在发出请求前抛 TypeError，导致参考 IP 一直缺失。现改为 `manual`，显式拒绝 3xx，不跟随重定向。参见 [Cloudflare Request 文档](https://developers.cloudflare.com/workers/runtime-apis/request/#properties)。这项修复解决探测兼容性问题，不能视为地区限制已修复。

管理员可运行手动探测：每分钟全站最多一次，不调用 OpenAI、不创建推理账单。手动记录描述**当前管理员请求**的上下文，不覆盖或补造历史请求的出口信息。

## 管理 API

- GET /admin/network-stats?hours=24&country=JP&colo=NRT&model=gpt-6-luna：最多 200 组，提供截断标记；筛选值可省略。
- POST /admin/network-probe，空 JSON 对象：当前连接参考探测，返回 observation_id。
- GET /admin/diagnostic-bundle?request_id=<服务端请求 ID>：可下载脱敏 JSON。

均要求管理员登录凭证；Cookie 写操作保留 CSRF 校验，普通账号或模型 Key 无权访问。不要将原始凭据或模型内容写入排障包。

迁移顺序：先备份并应用 0010_network_observability.sql，准备并确认源站就绪，再发布 Worker。标准发布入口已按此顺序执行。

## Worker失败诊断日志

必要失败事件写入Cloudflare Worker日志，不新增D1日志行；D1仍保留请求状态、财务账本、必要审计和原告警状态。自动调用日志保持关闭，不记录每次成功请求、正常匿名401/403、普通额度拒绝或主动取消，也不逐块记录SSE/音频。

Worker事件使用schema=ai-gateway-log-v1：

| event | 内容 |
|---|---|
| inference_failure | 请求ID、路径、模型、阶段、状态、提供方请求ID/错误代码/参数位置及固定诊断分类；包含流中断 |
| account_internal_failure | 账号服务内部异常的生成请求ID、路由族、异常类别；不记录原异常消息/SQL/堆栈 |
| mail_delivery_failure | 注册或绑定用途、随机诊断ID、发信通道类别、固定SMTP错误分类；不含收件邮箱或授权码 |
| network_observation_failure | 网络参考探测写入失败及关联请求ID |
| operational_alert | 新告警或已恢复后再次发生的事件；持续相同事件不重复输出，D1告警状态及通知流程照常更新 |

上游指明 tools[n].parameters 或 tools[n].function.parameters 时，失败日志附带相应工具的序号、技术名称、strict、Schema结构摘要及validation_hint。结构最多20个节点、深度5，每节点字段列表有上限；单事件最大8KiB，截断有标记。保留类型、properties/required字段名、items是否存在、additionalProperties形态等，用于定位Schema错误；不保存聊天、音频、参数实参、描述、默认值、示例、枚举值、正则内容、引用字符串或原始上游错误正文。未识别的上游说明只保留通用分类，不冒险透传自由文本。

在Cloudflare控制台 Workers & Pages → hilex-accounts → Observability → Logs，根据event或request_id筛选；可进一步按upstream_request_id关联供应商支持。即时排查也可用 `wrangler tail hilex-accounts --format=json`，但实时Tail可能附带平台请求元数据，不应把整份Tail输出公开上传。原始请求Schema不回填到历史日志，此功能仅覆盖新事件。

日志写入消耗少量Worker CPU及独立Worker日志额度，不是零消耗，但不增加D1写入。当前免费日志额度/保留期以[官方计费](https://developers.cloudflare.com/workers/platform/pricing/)为准；2026-12-01起官方公告调整日志计量，届时需复核。控制日志总量靠失败限定、去重和大小上限，不通过新增D1日志表或关闭必要财务记录实现。
