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

## 出口参考 IP 与地区拒绝排查

最新字段、成功/失败抽样、同 zone 签名接收端、分组统计与脱敏下载见 [网络诊断](network-diagnostics.md)。记录不等于 OpenAI 当次连接证据；之前 redirect:error 的兼容性问题已修正。

## 全站运行管理

管理员“全站预算、注册保护与告警”提供云模型暂停开关、Luna 每月美元预算（默认 200）、识别每日分钟和合成每日字符全站上限。语音上限空值表示未设置，0 表示停用；不改变个人额度。所有修改写审计，预算原子检查发生在预留 SQL 内。

继续开放注册，默认每 IP 5 次/小时、全站 100 次/小时、15 次/分钟；同邮箱标识最多 3 次/小时。登录增加按规范化账号标识跨 IP 的 10 次/5 分钟限制，仍保留 IP 限频。标识摘要只短期保留；当前公开注册要求邮箱验证码，发送、尝试次数及绑定流程见 [邮箱验证](email-verification.md)。

Cron 每 15 分钟根据真实请求检查地区限制、15 分钟内至少 20 次请求且 5xx 占比达到 10%、Luna 月预算达到 80%；超过 15 分钟未结算额度每小时检查。关闭 P95 请求耗时和音频首字节延迟自动告警，仍可按需查看诊断。同一持续事件只通知一次，不另发恢复通知；后台状态自动解除，恢复后再次发生才开启新事件。持久化通知标记不受历史消息保留期影响。

安全的聚合告警同时写 Worker console，并启用 Workers Logs、关闭自动 invocation 日志，避免收集原始请求头。默认未配置外部通知；可安装通用 HTTPS Webhook，见 [外部告警投递](alert-delivery.md)。未配置时不会向外发送。认证 timer 继续只验证匿名拒绝边界，不消耗模型额度。

每轮清理最多 1000 个过期 token/session；已使用 refresh token 保留到过期后一天，以保留重放检测证据。清理无关联的过期 family，30 天后清除请求 IP/UA/设备标识。结束超过 90 天且无模型账本或核对记录的请求，每轮最多归档 500 条到 request_history 再删除明细，归档与删除同批事务，重复运行不重复计数。财务账本及其请求、审计和全站成本不自动删除，不会批量退还未结算额度。

维护和监测在同一 Cron 中执行；数据库或平台故障时仍可能导致任务失败，需结合 Workers Logs 检查。未开启外部推送时请定期查看后台告警。

Luna 与语音的全站计量分别保存在独立 luna_spend / audio_spend；删除账号不重置已经计入的全站预算或语音日总量。个人额度账本及人工核对仍与账号关联，核对结果同步全站计量。


旧模型目录请求明细在当日额度窗口结束后可提前归档，仍排除财务或额度核对关联；每日统计保留于request_history并纳入管理员历史日统计。新云目录不再产生这些记录。请求创建/结束的重复更新和结算触发器的无变化写入已合并或跳过，旧版本价格结算保持兼容。具体保留表和计量对照见 [资源精简](resource-efficiency.md#请求写入与数据精简)。

## 并发收尾与诊断（2026-11-17）

核查时有两条已完成 Luna 用量结算但 requests.ended 仍为空的对话，账号并发上限为 2，两条均处于 920 秒有效窗口内。可复现的收尾缺陷是：响应包装层等待下一次客户端 pull 才观察到 EOF，客户端背压导致已完成结果继续占名额；取消时等待上游 cancel 也可能拖延释放。不能仅凭这些记录断言某一次客户端 429 的原因，仍需该响应 request_id。

修复后完整 JSON usage 或 SSE 完成标记与 usage 足以结束请求，不再依赖额外 EOF pull；取消时同步发起名额释放和上游取消。未知费用预留不释放。并发错误维持 429/account_concurrency_limited，新增明确说明与 X-Error-Code，Retry-After 从通用 60 秒改为 1 秒建议。没有调整账号的并发配额或为语音绕过配额。


## 推理分段采样

Worker 默认抽样 5% 的公网 HTTP 推理请求，写入 `inference_timing` 结构化日志，可通过 `INFERENCE_TIMING_SAMPLE_RATE`（0–1）调整。按对话、网页搜索、嵌入、ASR、TTS 区分；记录鉴权与租约、费用预留、中继或上游响应头、首字节、结算及总时间。HTTP 本机中继用内部响应头记录上游到响应头时间，Worker 从总连接时间中估算回源开销；内部响应头不会通过公开推理接口返回。Realtime TTS 无独立的上游 HTTP 中继耗时，使用现有路径的合并时间。D1 时间覆盖调用采样包装器的操作，读写行数只汇总返回元数据的调用，`db_meta_ops` 用来判断覆盖范围。

可在本地按请求类型与提供方汇总 P50/P95 和有效样本数：

```sh
cd cloudflare
npx wrangler tail --format json | jq --unbuffered -c '.logs[]?.message[]? | fromjson? | select(.event == "inference_timing")' | python3 ../scripts/ops/summarize_inference_timing.py
```

汇总脚本读取 JSONL 后输出结果，完成采集时应先停止上游采集或将样本写入文件后汇总。分段时间可能重叠，不能直接相加。


公网云模型请求在同一次租约读取中校验模型授权并取得账本所属用户。语音还在该查询中读取重复提交标记。随后写入账本时仍由 D1 原子校验请求、账号、密钥和额度。带 Cloudflare 入口 IP 的正常成功云模型路径为 3 次只读查询和 4 次直接写入，触发器仍会产生额外行读取与行修改。
