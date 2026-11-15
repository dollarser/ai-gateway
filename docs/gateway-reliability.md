# 路由、诊断、额度核对与自动运行

## 明确音频模型路由

生产 Worker 模式下，云语音必须使用精确模型 ID，ASR 为 multipart 的 `model=gpt-transcribe` 和 file，TTS 为 JSON 的 `model=gpt-realtime-2.1-mini` 和 input。缺字段、错误模型或错误 Content-Type 返回 422，不会自动转发到停机的自建服务。

旧自建接口可显式添加 `X-Inference-Provider: local` 保持既有参数格式。常见自建标识 funasr/paraformer、cosyvoice/cosyvoice3 也保留本地路由；其他自建标识需使用该请求头。显式本地 SQLite 开发模式沿用原行为，不需要 Worker。旧的 tts-1 / whisper-1 名称不自动映射到新的 OpenAI 模型，以免改变语义和计费。

WebSocket `/ws/asr`、`/ws/tts` 仍属于自建服务。ASGI 支持时，在握手前返回结构化 HTTP 错误：认证 401、权限 403、云模型协议错误 422、上游不可达 503。错误 JSON 和握手头包含 request_id。已建立连接的故障通过关闭码报告。生产 Uvicorn 支持此拒绝扩展；旧 ASGI 服务不支持时只能退回关闭码行为。

## 请求诊断

D1 保存 model、provider、protocol、failure_stage、error_code、upstream_status、duration_ms，关联 request_id、客户端请求 ID、IP 和客户端版本。只保存允许的短标识，不保存原始音频、对话正文、密钥或上游错误全文。

管理员的“按请求 ID 诊断”支持服务端 request_id、内部 lease 或客户端请求 ID。未通过认证而没有创建账号请求占用的请求只能在安全日志中定位。外部失败状态和原上游状态可能不同，例如 OpenAI 401 因提供方凭据问题对客户端返回 502，诊断保留原状态以便区分。

模型目录按用户与 Key 的权限交集返回。ASR/TTS 专用账号不再需要额外开 qwen；没有 qwen 权限时不访问或返回本地对话/Embedding 模型。目录调用仍计入原账号请求配额。

## 额度核对

后台“额度预留与人工核对”可按账号、pending/settled/all 查询最近 100 条账本。Luna 单位是 tokens，ASR 是毫秒，TTS 是 Unicode 字符。预留和已结算分开展示；日/月接口返回带时区的 resets_at，网页显示北京时间。

核对前必须查明实际提供方用量，填写修正值和至少五字符原因。请求结束一分钟后才可操作，以减少与流式结算的竞争；服务端再次比较原值，若已变化则拒绝，不覆盖新结果。修正范围不得超过原预留或原扣量的较大值。每次操作记录 quota_adjustments 和审计，操作 ID 防止重复提交。调整不重置其他请求或账号限额，也不删除历史。

API 为 GET `/admin/quota-review?state=pending&user_id=...`，POST `/admin/quota-adjustments`，字段 id、kind（luna/audio）、lease、expected_units、units、reason。清理测试账号时，应先清理其 quota_adjustments，再清理关联账本与请求；真实核对记录应按审计保留要求处理。

## 流式合成

TTS 新增 `stream:true,response_format:"pcm"`。服务端在收到第一段提供方音频后返回 HTTP 音频流，PCM 为 24kHz、16-bit、单声道。流式、非流式仅支持 PCM，缺省格式为 pcm；其他格式返回 422，由客户端负责封装或压缩。协议和路径见 [边缘接口](edge-api.md)。

客户端按完整 16-bit 样本缓存/播放，HTTP 分块边界不保证对齐样本。先预缓冲少量音频再播放，网络错误应标为未完成，不能仅凭 HTTP 200 判断整段成功。开始流式响应后不能改变 HTTP 状态码；服务端中断流并记录失败诊断。断连或无最终完成事件时仍可能保留额度，不能依靠取消播放绕过扣费。原生 Realtime 会话暂未直接开放，避免绕过字符额度和服务权限。

## systemd 用户服务

```bash
bash scripts/ops/install-user-services.sh
loginctl enable-linger "$USER"
# 先停止旧手工进程，再启动，以免端口冲突或重复连接。
systemctl --user start ai-gateway.service ai-gateway-tunnel.service ai-gateway-auth-check.timer
systemctl --user status ai-gateway.service ai-gateway-tunnel.service
journalctl --user -u ai-gateway.service -u ai-gateway-tunnel.service --since '10 minutes ago'
```

单位使用 `%h/workspace/ai-gateway`，迁移目录时同步调整单位。网关和隧道均自动重启，linger 使用户服务在无人登录时也能随系统启动。网关优雅停止最多 930 秒，避免强杀正在结算的请求。代码更新后运行 `systemctl --user restart ai-gateway.service`，隧道配置变化才重启 tunnel。

日志交给 journald，由系统日志策略自动轮转；不再持续写旧手工进程的 logs/gateway.log。认证 timer 每五分钟运行 `check_deployment --auth-only`，仅验证匿名访问模型目录、账号资料和 Worker 内部接口均返回 401，不探测 /healthz 或调用模型。结果记录在 `ai-gateway-auth-check.service` 的 journal；预期 401 标记为 PASS，其他响应或网络失败使检查失败。它验证拒绝边界，不代表真实账号登录、模型推理或所有服务依赖均正常。手动完整部署检查仍可运行不带 --auth-only 的命令。认证拒绝保留 INFO 日志和原有失败计数，不通过请求头跳过或弱化认证。

## 持续验证

GitHub Actions 的 Gateway checks 对 push/PR 运行 Python 和 Worker 测试，不使用生产凭据。CI 创建随机测试 Client ID，安装锁定依赖，不会部署到生产。生产发布顺序仍为私有 D1 备份验证 → 增量迁移 → Worker 部署 → 网关重启 → 受控验证。

## 本次验证

通过 151 项 Python 测试、21 项 Worker 测试；在不含私有配置的源码副本中创建测试 Client ID 后也通过全套 Python 测试。浏览器验证请求诊断和额度核对操作。线上验证云语音精确模型校验、语音专用 Key 发现、WebSocket 503、PCM 首块返回与最终字符结算、带审计的幂等额度修正，临时账号与核对材料已清理。systemd 服务和定时器均启用，linger 生效，健康检查成功，隧道回环 metrics /ready 返回 200。

## 下一步优化方向

1. 流式取消：当前取消读取会停止向客户端排队，但上游 Realtime 生成仍可能继续到完成。应将取消信号传给上游并关闭会话，同时保留已经提交请求的保守扣额，避免取消免费绕过额度。
2. 生产观测与通知：目前认证 timer 只做拒绝边界检查，结果在本机 journal。应基于实际 Worker 请求统计 5xx、P95 延迟、首音频耗时和未结算额度数量，设置通知渠道及阈值；不需要高频调用付费模型作为健康检查。
3. 客户端 PCM 播放：记录首音频耗时、播放缓冲欠载和中途断流；支持取消播放和长文本分段，避免把 HTTP 200 当成完整成功。新客户端通过模型目录 audio.response_formats / sample_rate / channels / encoding 读取能力。

## 出口参考 IP 与地区拒绝排查

公网 Worker 请求诊断新增以下字段，可在管理员“按请求 ID 诊断”中查看：

| 字段 | 含义 |
|---|---|
| ingress_colo / ingress_ray | Cloudflare 请求入口节点与 Ray ID；不是保证的实际执行位置或出口 |
| client_country | Cloudflare 对访问客户端的地区判定；不是 Worker 出口地区 |
| upstream_cf_ray / upstream_request_id | OpenAI 响应携带的 CF-Ray / x-request-id，缺失时留空 |
| egress_probe_ip | 独立诊断连接被目标服务观察到的参考 IP，不是 OpenAI 当次连接的确定出口 IP |
| egress_probe_target / egress_probe_at | 探测目标 api64.ipify.org、探测开始的 Unix 秒时间 |
| egress_probe_status | observed_reference、timeout、invalid_response、http_error 或 failed |

仅当 OpenAI 返回 HTTP 403 时，Worker 在 waitUntil 后台发起一次独立 IP 探测；正常请求不额外探测，也不等待探测结果。探测超时为 2 秒，限制响应体 256 字节，不重试；失败不覆盖原模型错误或改变额度结算。后台任务可能因运行环境终止而未完成，空字段不代表没有地区错误。

探测请求新建，只显式设置 Accept，不复制模型请求的 API Key、Cookie、客户端请求头、对话或音频。它是独立连接，目的地址、IPv4/IPv6 和网络路由均可能与 OpenAI 不同，不能把测得的 IP 标成 OpenAI 实际看到的来源。跨 Cloudflare 区域的 IP 头还可能使用合成地址。准确来源需 OpenAI/Cloudflare 根据 Ray ID、请求 ID 和时间核查；现有历史错误无法补录当时的出口。

这些信息保存在 D1 requests，仅管理员诊断展示；不放进普通客户端错误响应。先应用 0007_egress_diagnostics.sql，再部署 Worker。此功能不固定出口、不改变路由，也不改变地区访问限制。

参考：[ipify 的 IPv4/IPv6 接口](https://www.ipify.org/)、[Cloudflare 请求元数据](https://developers.cloudflare.com/workers/runtime-apis/request/)、[Cloudflare 请求头](https://developers.cloudflare.com/fundamentals/reference/http-headers/)。

本次通过 37 项 Worker 测试，包含 403、后台探测成功/失败/超时、IPv4/IPv6 校验、探测失败不影响模型错误和额度退款。公网临时账号实际请求返回 200，入口节点及 OpenAI 的 Ray ID / request ID 已正常入库，成功请求没有额外 IP 探测；测试账号及关联数据已清理。公网此次未触发 403，因此真实参考 IP 字段须待后续 403 才会产生，不能将模拟测试 IP 视为线上出口。
