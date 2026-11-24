# GPT-6 系列云文本账号月额度

GPT-6 系列及 OpenAI 嵌入模型共用同一云文本额度。现有账号和后续新账号默认每月 **10,000,000 tokens**，同一账号的 access_token 和所有 API Key 共用额度。每次用量为 OpenAI 返回的输入 token（含缓存输入）加输出 token（含推理 token）；不根据美元价格扣减。月周期按 `Asia/Shanghai` 自然月计算，不累计结转。

| 系列 | 网关模型 ID |
| --- | --- |
| GPT-6 | `gpt-6-luna`、`gpt-6-sol`、`gpt-6-astra` |
| GPT-6.1 | `gpt-6.1-sol`、`gpt-6.1-terra` |
| GPT-6.2 | `gpt-6.2-sol`、`gpt-6.2-astra` |

在管理后台「模型管理」逐个开放。Luna 初始开启，其余初始关闭。各模型按 [OpenAI Standard 费率](https://developers.openai.com/api/docs/pricing)分别预留并估算计费。本机中继继续转发对话请求。对不支持关闭推理的模型，带客户端自定义函数的调用使用 Responses。

## 配置与发布

OpenAI 密钥只配置在 Worker `hilex-accounts` 的运行时密钥 `OPENAI_API_KEY` 中，不写入 D1、网关 `.env`、网页或仓库。可以在 Cloudflare 控制台设置，也可以运行：

```bash
cd cloudflare
npx wrangler secret put OPENAI_API_KEY
npm test
npm run db:remote
npm run deploy
```

随后重启 Python API 网关以加载新路由。原有 `INTERNAL_SECRET` 和网关 `ACCOUNTS_WORKER_SECRET` 保持匹配。模型调用路径为客户端 → api.hilex.me → 网关 → 账号 Worker → OpenAI；自建 Qwen/ASR/TTS 仍走原模型后端。Worker 不可用时拒绝云模型请求。

D1 迁移 `0002_luna_budget.sql` 给现有账号添加默认额度，并建立独立 `luna_usage` 账本和原子限额 trigger。部署前备份 D1，先迁移再部署 Worker；这次是增量迁移，不重新导入历史账号。

## 管理和查看

- 管理员在账号管理页面编辑各账号的 **Luna 每月 tokens**，设置 0 即停用。调整额度不会清空已用 token。
- **GPT-6 Luna 默认额度**只影响后续创建的账号，包括自助注册和管理员创建。已有账号的额度单独编辑。
- 普通用户在使用记录页面查看本月额度、已计入、剩余及预留/待核对数量。
- `GET /account/luna-usage` 返回自己的月用量；管理员可通过 `GET /admin/usage?user_id=...` 的 `luna` 字段查看指定账号用量。
- 管理 API：`PATCH /admin/users/{id}` 接受整数 `luna_monthly_tokens`；`GET/PATCH /admin/luna-defaults` 使用 `monthly_tokens`。范围 0–1,000,000,000。

Luna 继承现有 `qwen` 对话服务权限；没有对话权限、被禁用、需修改初始密码的账号或不含 qwen 权限的 Key 均不能调用。原有账号 RPM、每日请求数、并发数及旧 Key token 限额仍有效。

## 调用

OpenAI SDK 的 base URL 为 `https://api.hilex.me/v1`，模型 ID 从下表选择。支持 Chat Completions、Responses，以及两者的 SSE 流式输出。API Key 使用 `Authorization: Bearer <账号 API Key>`；账号 access_token 还需有效 `X-Client-ID`。客户端不能使用 Worker 的 OpenAI 密钥。

```json
{
  "model": "gpt-6-luna",
  "messages": [{"role": "user", "content": "你好"}],
  "reasoning_effort": "none",
  "max_completion_tokens": 1024,
  "stream": true
}
```

上述 JSON POST 到 `/v1/chat/completions`。Responses POST `/v1/responses`，使用 `input` 和 `max_output_tokens`。`GET /v1/models` 会列出可配置使用的 Luna，自建模型后端停机也不影响 Luna 的发现和调用。

支持文本、图片输入和客户端自定义 function 工具，拒绝文件/音频、OpenAI 托管工具、隐藏历史会话引用、后台执行、多候选和自行指定付费处理档位。单次输出默认上限 4096、最大 16384 tokens；文本输入采用 UTF-8 字节数加协议余量估计上界；图片按每张 100,000 tokens 保守预留（不是精确图片 tokenizer），Base64 图片字节不按文本计费。估计输入总量超过 250,000 时拒绝，完成后统一按提供方实际 usage 结算。这些限制让每次请求可在发出前预留完整预算。模型本身支持的更多能力见 [OpenAI 官方模型说明](https://developers.openai.com/api/docs/models/gpt-6-luna)。

## 计量和故障处理

调用前在 D1 预留“保守输入上界 + 完整输出上限”，原子 trigger 将所有并发请求计入同一账号的月额度；不足返回 429，不请求 OpenAI。预留较保守，余额较少时可以缩短上下文或降低输出上限。

完成后只按 OpenAI 返回的权威 usage 结算，释放多余预留；不会把网关转来的客户端 token 数作为账本依据。流式调用强制收集最终 usage。相同请求 lease 只能提交一次，防止内部重试重复付费。

明确的上游拒绝响应释放预留；网络中断、无有效 usage 或 Worker 被终止的请求保留预留，避免断开连接绕过额度。Cloudflare 对断连后的后台任务有执行时间限制，因此仍可能出现待核对项。管理员应按 lease、response_id 和 OpenAI 用量核对后修正对应账本行，并写审计；不要把所有未结算项批量退款。定时清理过期请求不会自动释放这些额度。

清理账号时，先删除其 `luna_usage` 再删除关联 `requests`，详见 [数据清理方法](production-data-cleanup.md)。本地 SQLite 兼容模式不提供 Luna 云额度，18901 免认证端口不能绕过云模型账号鉴权。

## 验证

最初额度接入验证了普通对话及结算；当前统一回归已通过 158 项 Python 测试和 34 项 Worker/Miniflare 测试。线上使用临时验证账号完成模型发现、API Key 普通对话、账号 access_token 流式对话和 Responses 请求，核对账本与返回 usage 一致；设为 0 后返回 429 且未增加上游调用。验证账号及关联数据已删除。后续常规健康检查仍使用不创建账号的 `scripts.smoke.check_deployment`。

## 工具调用兼容与 400 定位

Luna 的 Chat Completions 工具调用要求 `reasoning_effort:"none"`，省略时的模型默认推理模式也可能导致 400。线上已复现同一函数请求 medium 返回 400、none 返回 200。网关发现当前 tools 或历史 tool_calls/tool 消息时，统一设置 none；仅普通对话保留客户端推理设置。需要推理和工具同时工作时使用 `/v1/responses`，例如 `reasoning:{"effort":"low"}`，不会被降级。

兼容 Chat 嵌套 `tools[].function` 和 Responses 扁平 function 定义，按目标端点规范化；tool_choice 也支持两种写法，但必须引用本次 tools 中的函数。未显式设置 strict 的函数使用 false，避免 Responses 默认严格模式拒绝旧客户端的可选参数 schema；显式 strict:true 原样保留，客户端负责满足严格 schema 规则。不开放托管工具或隐藏历史引用。

发生转换时响应包含 `X-Inference-Compatibility`，例如 `chat-tools-reasoning-none`。管理员 requests 记录保存 compatibility、upstream_status、upstream_error_code、upstream_error_param、upstream_request_id，可按客户端收到的 X-Request-ID 搜索；不保存提示词、工具参数、schema 正文或原始上游报错。确定的上游拒绝释放 token 预留，参数校验失败在调用前返回 422。

客户端交接：工具结果使用匹配的 tool_call_id；Chat SSE 累积 delta.tool_calls 的 index/id/name/arguments 后再执行函数，不能假定 arguments 在一个分片中完整返回。Responses 使用 function_call / function_call_output 并提供完整上下文；需要推理时优先持续使用 Responses 协议，勿将两种事件直接混用。

参考：[OpenAI Luna 工具限制](https://developers.openai.com/api/docs/models/gpt-6-luna.md)、[函数调用协议](https://developers.openai.com/api/docs/guides/function-calling.md)。

## 全站每月 200 美元预算

账号 token 额度之外，增加独立全站成本预算，默认 200 美元/北京时间自然月。2026-11-16 核对的 Standard 价格为每百万输入 $0.10、缓存输入 $0.01、缓存写入 $0.125、输出 $0.50，见 [官方定价](https://developers.openai.com/api/docs/models/gpt-6-luna.md)。200 美元约对应 20 亿纯普通输入 tokens，或 4 亿纯输出 tokens；输入输出各半时约 6.67 亿总 tokens，不能用一个固定 token 数精确代替美元预算。

内部以整数纳美元计量：普通输入 100、缓存 10、缓存写入 125、输出 500 / token。请求前按输入上界×125＋输出上限×500 预留，D1 trigger 原子核对全站预算；请求结束按 usage 分类结算。当前输入上界低于长上下文加价阈值，且不开放付费档位和托管工具。明确拒绝成本为 0；取消或缺少最终 usage 保留预留。

`luna_spend` 独立于账号和请求表，删除账号或请求不释放已计成本。管理员核对用量时可同时填写美元成本，记录审计并检查旧值；旧 API 未传成本时，非零 token 修正不会自动释放美元预留，修正为 0 才同步归零。

这是网关已记录请求的估算成本控制，不是 OpenAI 发票总额：独立使用同一上游 Key、此前已删除的用量、税费或上游价格变更不在自动计量内。历史现存账本按当前已核对标准价格回填，不修改个人额度；模型价格变化时应先更新估算器和测试再发布。

## 图片输入

Chat Completions 使用 user.content 中的 `{"type":"image_url","image_url":{"url":"https://example.com/image.png","detail":"auto"}}`；Responses 使用 `{"type":"input_image","image_url":"https://example.com/image.png","detail":"auto"}`。可以与 text / input_text 混合。

图片接受不含凭据的 HTTPS URL，或 PNG/JPEG/WebP/GIF 的 Base64 data URL。远程图片由 OpenAI 获取，网关不下载用户 URL；file_id、SVG、音频和文件输入仍不开放。每请求最多 2 张图片（包括历史消息），JSON 请求体仍限 4 MiB；detail 支持 auto / low / high / original，上游最终校验模型支持范围和图片内容。图片不写入日志或账本。

`GET /v1/models` 的 Luna 条目现在声明 `architecture.input_modalities=["text","image"]`、`output_modalities=["text"]`。客户端刷新模型列表后可启用图片入口，账号认证和 API 地址不变。图片预留较保守，剩余额度不足时可能被拒绝；未知用量继续保留预留，不能因为客户端取消就退款。

标准图片字段参考 [OpenAI 图片输入](https://developers.openai.com/api/docs/guides/images-vision)。
