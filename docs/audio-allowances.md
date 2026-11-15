# OpenAI 语音接入与日额度

现有账号及新账号默认提供两项独立额度，与 Luna 月 token 额度分开：

| 模型 | 用途 | 每账号每日额度 | 网关接口 |
|---|---|---|---|
| `gpt-transcribe` | 音频转文字 | 1800 秒，即 30 分钟 | `/v1/audio/transcriptions` |
| `gpt-realtime-2.1-mini` | 文字转语音 | 500000 个输入字符 | `/v1/audio/speech` |

登录凭证和同账号所有 API Key 共享额度，每天北京时间零点开始新周期，不累计结转。服务权限分别为 `asr` / `tts`。禁用、需首次改密或没有对应服务权限的账号不能调用；原有 RPM、每日请求数和并发限制仍适用。额度为 0 表示停用对应 OpenAI 语音模型，自建语音后端沿用原权限和请求额度。

## 语音识别

使用 multipart 表单，上传 `file`，设置 `model=gpt-transcribe`。支持 WAV、MP3、M4A、WebM 等 FFmpeg 可解码的音频。文件上限 21 MiB，单次最多 5 分钟，较长录音应切片。Worker 对标准 16-bit PCM WAV 校验实际帧数、字节数和采样率；常见 MP3、Ogg/WebM Opus、非分片单音轨 M4A AAC-LC 优先在 Worker 扫描实际音频帧/采样表并直接上传原文件；不支持或无法验证的变体经私有本机 FFmpeg 解码为 16kHz 单声道 PCM WAV，按向上取整的毫秒数计入额度，忽略客户端上报的时长。解码子进程最多 60 秒，禁止网络和文件协议输入。

可用字段：`file`、`model`、`language`、`languages[]`、`keywords[]`、`prompt`、`response_format`（json/text）、`stream`（true/false）。`languages` / `keywords` 也接受 JSON 数组字符串。流式响应必须选择 json，返回 transcript SSE 事件。识别额度以完整上传音频时长计算，不按检测出的讲话时长计算。压缩扫描计入编码帧填充，可能比解码后的实际播放时长略大；不信任 duration 标签或客户端声明。

## 语音合成

OpenAI 的该模型使用 Realtime WebSocket，而非旧 Speech API。网关保持 HTTP `/v1/audio/speech` 兼容入口，Worker 使用服务端密钥连接 Realtime，每个请求创建独立会话，限定为朗读客户端输入文本，不开放任意 Realtime 事件、语音对话或工具执行。

请求示例：

```json
{
  "model": "gpt-realtime-2.1-mini",
  "input": "你好，欢迎使用语音服务。",
  "voice": "marin",
  "response_format": "pcm",
  "stream": true
}
```

单次输入 1–2000 个 Unicode 码点，包含空格和标点，中文、普通英文字母和大多数 emoji 各为一个，组合字符按实际码点计数。不是 UTF-8 字节数，也不是 JavaScript 字符串 length。每日 50 万字符指输入文本字符数，不是音频 token 或输出时长。

默认声音 `marin`，声音白名单见服务端 `speechPayload`。仅支持 pcm（默认），为 24kHz、signed 16-bit little-endian、单声道原始音频。当前仅支持 speed=1。默认等待整段生成后返回，`stream:true` 边生成边返回；显式请求 mp3/wav/opus/flac 等格式返回 422，不产生模型用量。合成不再调用本机编码器。原生 Realtime 会话仍未开放。模型是生成式语音模型，不能保证任意文本逐字朗读。

原有 `/ws/asr`、`/ws/tts` 继续提供自建语音协议，不是这两个 OpenAI 模型的入口。客户端需要按所选模型切换到 HTTP，见 [客户端交接](client-handoff.md)。

## 额度账本与故障

D1 `audio_usage` 按账号、日、模型用途汇总，识别单位为毫秒，合成为字符。调用前原子预留，额度不足返回 429，不请求上游；同一 lease 不重复调用。成功后标记已结算。明确拒绝释放预留；提交后的网络中断、部分输出或无法确认结果保留预留，供管理员核对。不能批量退还所有未结算记录。

管理员通过统一后台默认设置、账号设置或批量应用默认额度管理：`openai_asr_daily_seconds` 和 `openai_tts_daily_characters`。`GET /account/audio-usage` 提供自己的余额；管理员可在账号详情中查看。修改额度不清零历史用量。

## 部署

1. 备份生产 D1 并验证可恢复，不把备份写入 Git。
2. 安装更新的 Python 依赖，`imageio-ffmpeg==0.8.1` 包含 Linux 可用的解码器；依赖及锁文件均跟踪在 Git 中。
3. 按顺序应用全部迁移（当前至 `0009_audio_spend.sql`），再部署 Worker 并重启网关。
4. Worker 继续使用已有 `OPENAI_API_KEY` 和 `INTERNAL_SECRET`，无需把 OpenAI 密钥复制到 GPU 机器或客户端。
5. 验证模型列表、识别、合成、额度扣减和零额度拒绝；测试账号及其关联账本、请求、密钥和登录信息应清理。

官方协议参考：[GPT-Transcribe](https://developers.openai.com/api/docs/models/gpt-transcribe)、[GPT-Realtime-2.1 mini](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini)、[Realtime 语音事件](https://developers.openai.com/api/docs/guides/realtime-conversations)。

## 本次上线验证

初次接入时曾通过公网 API 使用 Realtime 合成 WAV 并交给 GPT-Transcribe 识别；当前输出已收敛为 PCM，客户端可封装 WAV 后用于识别；核对 Worker 日账本与实际解码毫秒数及输入字符数一致，无残留预留。两个额度分别设为 0 后均返回 429，未产生新的上游调用账本。临时验证账号与关联数据已清理。

当前音频直连与压缩格式的边界见 [边缘路径](edge-api.md)。
