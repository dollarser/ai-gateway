# 模型发现：OpenRouter 风格

当前网关采用 OpenRouter 的 `architecture` 字段和 `output_modalities` 查询约定，参考[官方模型列表文档](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)。本次实现的是模型发现字段和过滤规则；不声明实现 OpenRouter 的计费、供应商调度或完整 API。

## 请求与默认行为

| 请求 | 返回内容 |
|---|---|
| `GET /v1/models` | 默认仅文本输出模型：账号已获授权且当前可用的文本模型（自建 Qwen 和已登记 GPT‑6 系列） |
| `GET /v1/models?output_modalities=text` | 同上 |
| `GET /v1/models?output_modalities=embeddings` | 嵌入模型 |
| `GET /v1/models?output_modalities=all` | 全部对当前账号及凭据可见的模型，含语音和嵌入 |
| `GET /v1/models?output_modalities=transcription` | GPT-Transcribe |
| `GET /v1/models?output_modalities=audio` | GPT-Realtime-2.1 mini 语音合成适配 |
| `GET /v1/models?output_modalities=text,embeddings` | 支持任一所列输出模态的模型 |
| `GET /v1/models?output_modalities=rerank` | 当前返回空列表，尚未部署重排序 |

**与此前行为的变化：完整发现必须显式传 `output_modalities=all`。** 默认列表不再混入 Embedding。参数大小写敏感，不能重复提交；未知值、空项和 `all,text` 返回 400。

公网入口为 `https://api.hilex.me/v1/models`。认证保持账号 Bearer access_token + X-Client-ID，或 API Key 单独使用。本机 `http://127.0.0.1:18901/v1/models` 免认证。LLM/Embedding 仍共用现有 `qwen` 授权与配额；能力发现不赋予额外权限。

## 响应

关键字段示例（上游提供的其他基础字段继续保留）：

```json
{
  "object": "list",
  "data": [
    {
      "id": "Qwen3.8-27B",
      "object": "model",
      "architecture": {
        "input_modalities": ["text"],
        "output_modalities": ["text"],
        "modality": "text->text"
      }
    },
    {
      "id": "Qwen/Qwen3-Embedding-0.6B",
      "object": "model",
      "architecture": {
        "input_modalities": ["text"],
        "output_modalities": ["embeddings"],
        "modality": "text->embeddings"
      }
    }
  ]
}
```

- 自建模型的 `id`、`created`、`owned_by` 等取自后端实际 `/v1/models` 返回，不猜测缺失字段。GPT‑6 系列的条目来自 Worker 的受控模型配置，不公开 OpenAI 账号下的其他模型。
- `architecture.input_modalities` / `output_modalities` 来自当前部署注册信息；`modality` 由两个数组生成。
- 同一 ID 如果由多个实际任务部署提供，合并输入和输出模态，目录中只出现一次。
- 保留 Qwen 已配置的思考强度元数据；嵌入条目不添加思考能力。
- 不额外增加 `capabilities`、`type` 等重复分类，不猜测工具、图片或其他未验证能力。
- 描述的是部署暴露的能力，不代表 Key 权限或后端即时健康状态。

## Helix 接入

1. 完整发现调用 `/v1/models?output_modalities=all`。
2. 用 `architecture.output_modalities` 包含 `text` 的当前文本模型填充对话选择器；包含 `embeddings` 的填充嵌入选择器。按数组成员判断，不按模型名称猜测。
3. 对话请求继续使用 `/v1/chat/completions`，嵌入请求继续使用 `/v1/embeddings`。
4. 服务地址、认证头和推理请求体不变；不要再依赖先前建议但未上线的 `capabilities` 字符串数组。

示例：

```bash
curl 'https://api.hilex.me/v1/models?output_modalities=all' \
  -H "Authorization: Bearer $API_KEY"

curl 'http://127.0.0.1:18901/v1/models?output_modalities=embeddings'
```

## 服务端维护

`gateway/deployments.py` 是模型部署注册表，推理路由与目录读取同一份配置。每个部署声明上游地址、实际开放的推理路径及输入/输出模态；模型 ID 从对应上游发现，不在网关硬编码追加 Embedding。

目录查询并发读取已登记后端的 `/v1/models`，然后合并、过滤。单后端目录读取总超时为 1 秒（连接超时 0.5 秒），控制在 Worker 的 1.5 秒源站目录查询预算内，不改变推理超时；各后端独立发现，单个后端停止、超时或返回无效数据时只省略该后端条目，其他后端仍返回 200，并携带 `X-Model-Catalog-Partial: local_unavailable`。因此关闭 Qwen 不影响本地 Embedding 的发现与调用，反之亦然。本机网关在所有本地后端均失败且没有可返回的云模型时返回 502；公网 Worker 则继续返回该账号可见的云模型，并标记本地目录不完整。公网 Worker 保留健康的本地模型及该提示头，目录缓存最多 30 秒；已缓存的旧模型仍可能短暂可见，直接请求已停止模型仍返回 502，不会自动切换模型。Worker 已配置 OpenAI 密钥、云模型未暂停且账号云文本月额度大于 0 时，目录合并该账号允许的 GPT‑6 系列云模型。账本余额是否足够在实际请求时检查。Luna 的 `responses_tools` 包含 `web_search`；工具使用还受账号搜索额度约束。新账号默认列表只用在创建时，现有账号授权实时生效。云语音条目按账号和 Key 的 asr/tts 权限及其对应日额度过滤。识别模型使用 transcription 输出模态，避免混入默认聊天列表；合成使用 audio/speech，二者的 endpoints 指向实际开放的 HTTP 路径。Worker 配置查询失败则返回 503，不假设模型已启用。公网错误不包含内部地址。

新增模型用途时，先部署真实后端，再在注册表配置路径和模态。Luna 云模型的固定代理和独立额度见 [Luna 额度](luna-allowance.md)，本机免认证目录不追加 Luna。当前目录范围为 LLM、Embedding 及已接入的 OpenAI 语音模型；ASR、TTS、仅本机 VibeVoice 的路径、可见性和上传限制不变。新增登记的推理路径还需接入对应的计量与代理策略，不能只靠增加一个模态值宣称支持完整新服务。

## 公网目录缓存与客户端刷新

公网 Worker 通过 Cloudflare Cache API `caches.default` 缓存本地模型发现结果，缓存键为 `https://api.hilex.me/__local-model-catalog`，有效期 30 秒。这个地址仅作为内部缓存键，不是客户端接口。缓存位于各 Cloudflare 边缘节点，不保存在 D1 或本机，也不是全局共享的一份缓存。其作用是减少跨隧道查询和并发客户端的重复后端查询；当前仍保留此缓存。

缓存过期后，由下一次 `GET /v1/models` 请求触发更新，没有每 30 秒主动刷新的后台任务。查询链路为 Worker → Cloudflare Tunnel → 本机受保护网关 `127.0.0.1:18900` → Qwen `127.0.0.1:30007/v1/models` 与 Embedding `127.0.0.1:18771/v1/models`。网关独立查询两个后端，将健康模型返回给 Worker 缓存；云模型条目另外按当前账号权限合并。

客户端仍须重新请求模型列表并更新界面。服务端缓存失效不会主动修改客户端已保存的列表，模型出现在列表中也不保证之后的推理必定成功。Qwen 停止后，新查询不再列出 Qwen，Embedding 保持可见、可调用；已有旧列表仍可能允许用户选择 Qwen，此时调用返回 HTTP 502，提示“上游服务暂时不可用”，不会自动切换模型。客户端可提示用户刷新列表并手动选择其他模型，避免无限重试。
