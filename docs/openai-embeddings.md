# OpenAI small 嵌入与本地模型

公网统一基础地址 `https://api.hilex.me/v1`。OpenAI 嵌入仅开放 **text-embedding-3-small**；large、ada 等未配置模型返回422，不自动转发为其他模型。默认1536维，支持 dimensions 缩减至1–1536，支持 float / base64 返回格式。

```http
POST /v1/embeddings
Authorization: Bearer <账号API Key>
Content-Type: application/json

{"model":"text-embedding-3-small","input":["第一段文本","第二段文本"],"dimensions":1024}
```

账号 access_token 调用额外需要有效 X-Client-ID；API Key 无需 Client ID。继承现有 qwen 服务权限、账号并发、RPM/每日请求数和 Key token 限额。原生客户端不要携带 OpenAI 提供方密钥。

单请求最多32条输入，支持非空字符串、字符串列表、token ID 序列或其批次。每条文本 UTF-8 字节上界 / token 序列长度不得超过8192，整个批次预留不超过32768；这是网关保守边界，中文长文按需拆分。标准字段 model/input/dimensions/encoding_format/user 之外不开放；不支持 stream。不同模型或维度的向量不可直接混用到同一个相似度索引。

调用前按文本字节数或 token 序列长度预留，成功按上游 usage.prompt_tokens 结算；实际价格为每百万输入tokens $0.02。未知上游用量保留预留，明确拒绝则释放预留；不自动重复计费请求。服务端支持 Worker 和受保护本机中继两种既有出口模式。

## 额度与预算

Luna 与 OpenAI small 嵌入共享现有云文本月 token 额度（管理字段仍为 luna_monthly_tokens）和全站云文本美元预算（luna_monthly_usd）。本地 Qwen / 本地 Embedding 不计入此付费云额度，但共享账号请求及并发限制。

luna_usage 新增 model，默认值保留为历史 gpt-6-luna；small 嵌入写入自己的模型 ID 和实际价格，不会按 Luna 单价结算。历史字段与账本名称保留以避免重写用户配额和财务历史。云文本用量响应增加 scope=cloud_text_tokens 和 models 数组，个人页/管理员页使用“云文本”说明，零额度同时停用云对话和云嵌入。旧 Key 的每日 token 上限仍执行。

## 模型发现

- `GET /v1/models`：默认仅文本输出，包含有权限的 Qwen3.8-27B 和 GPT-6 Luna。
- `GET /v1/models?output_modalities=embeddings`：包含 text-embedding-3-small 和已部署的 Qwen/Qwen3-Embedding-0.6B。
- `GET /v1/models?output_modalities=all`：完整模型目录，供客户端按 architecture.output_modalities 分类。

LOCAL_MODELS_ENABLED=true 时，首次目录查询同步获取本地模型元数据，并缓存30秒，避免此前首次仅能看到云模型的问题。目录验证账号权限，但不占推理并发、不计每日调用次数、不创建推理账本。没有qwen权限的账号不发现这些模型。源站临时不可用时仍返回可用云模型，并附 X-Model-Catalog-Partial:local_unavailable，客户端可在稍后手动刷新，不应删除本地保存的模型选择。

仅应从实际模型条目读取上下文窗口，不把历史部署参数当作当前值。VibeVoice 保持本地专用，不通过此开关公开。

官方：[small 模型和价格](https://developers.openai.com/api/docs/models/text-embedding-3-small)、[嵌入接口](https://developers.openai.com/api/reference/resources/embeddings/methods/create)。
