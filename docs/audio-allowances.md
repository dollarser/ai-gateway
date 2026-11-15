# OpenAI 语音接入与日额度

现有账号及新账号默认提供两项独立额度，与 Luna 月 token 额度分开：

| 模型 | 用途 | 每账号每日额度 | 网关接口 |
|---|---|---|---|
| `gpt-transcribe` | 音频转文字 | 1800 秒，即 30 分钟 | `/v1/audio/transcriptions` |
| `gpt-realtime-2.1-mini` | 文字转语音 | 500000 个输入字符 | `/v1/audio/speech` |

登录凭证和同账号所有 API Key 共享额度，每天北京时间零点开始新周期，不累计结转。服务权限分别为 `asr` / `tts`。禁用、需首次改密或没有对应服务权限的账号不能调用；原有 RPM、每日请求数和并发限制仍适用。额度为 0 表示停用对应 OpenAI 语音模型，自建语音后端沿用原权限和请求额度。

## 语音识别

使用 multipart 表单，上传 `file`，设置 `model=gpt-transcribe`。支持 WAV、MP3、M4A、WebM 等 FFmpeg 可解码的音频。文件上限 21 MiB，单次最多 5 分钟，较长录音应切片。网关用受限本地 FFmpeg 解码成 16kHz 单声道 PCM WAV，Worker 再验证标准 WAV 的字节数和采样率，按向上取整的毫秒数计入额度，忽略客户端上报的时长。解码子进程最多 60 秒，禁止网络和文件协议输入。

可用字段：`file`、`model`、`language`、`languages[]`、`keywords[]`、`prompt`、`response_format`（json/text）、`stream`（true/false）。`languages` / `keywords` 也接受 JSON 数组字符串。流式响应必须选择 json，返回 transcript SSE 事件。识别额度以完整上传音频时长计算，不按检测出的讲话时长计算。

## 语音合成

OpenAI 的该模型使用 Realtime WebSocket，而非旧 Speech API。网关保持 HTTP `/v1/audio/speech` 兼容入口，Worker 使用服务端密钥连接 Realtime，每个请求创建独立会话，限定为朗读客户端输入文本，不开放任意 Realtime 事件、语音对话或工具执行。

请求示例：

```json
{
  "model": "gpt-realtime-2.1-mini",
  "input": "你好，欢迎使用语音服务。",
  "voice": "marin",
  "response_format": "mp3"
}
```

单次输入 1–2000 个 Unicode 码点，包含空格和标点，中文、普通英文字母和大多数 emoji 各为一个，组合字符按实际码点计数。不是 UTF-8 字节数，也不是 JavaScript 字符串 length。每日 50 万字符指输入文本字符数，不是音频 token 或输出时长。

默认声音 `marin`，声音白名单见服务端 `speechPayload`。格式支持 mp3（默认）、wav、pcm、opus、flac；PCM 为 24kHz、16-bit、单声道。当前仅支持 speed=1。服务端等待本次音频生成完成后返回二进制，暂不提供低延迟 TTS 分块或原生 Realtime 会话。模型是生成式语音模型，需遵循 OpenAI 的安全限制，不能保证任意文本逐字朗读。

原有 `/ws/asr`、`/ws/tts` 继续提供自建语音协议，不是这两个 OpenAI 模型的入口。客户端需要按所选模型切换到 HTTP，见 [客户端交接](client-handoff.md)。

## 额度账本与故障

D1 `audio_usage` 按账号、日、模型用途汇总，识别单位为毫秒，合成为字符。调用前原子预留，额度不足返回 429，不请求上游；同一 lease 不重复调用。成功后标记已结算。明确拒绝释放预留；提交后的网络中断、部分输出或无法确认结果保留预留，供管理员核对。不能批量退还所有未结算记录。

管理员通过统一后台默认设置、账号设置或批量应用默认额度管理：`openai_asr_daily_seconds` 和 `openai_tts_daily_characters`。`GET /account/audio-usage` 提供自己的余额；管理员可在账号详情中查看。修改额度不清零历史用量。

## 部署

1. 备份生产 D1 并验证可恢复，不把备份写入 Git。
2. 安装更新的 Python 依赖，`imageio-ffmpeg==0.8.1` 包含 Linux 可用的解码器；依赖及锁文件均跟踪在 Git 中。
3. 应用 `0003_audio_allowance.sql` 和 `0004_admin_observability.sql`，再部署 Worker 并重启网关。
4. Worker 继续使用已有 `OPENAI_API_KEY` 和 `INTERNAL_SECRET`，无需把 OpenAI 密钥复制到 GPU 机器或客户端。
5. 验证模型列表、识别、合成、额度扣减和零额度拒绝；测试账号及其关联账本、请求、密钥和登录信息应清理。

官方协议参考：[GPT-Transcribe](https://developers.openai.com/api/docs/models/gpt-transcribe)、[GPT-Realtime-2.1 mini](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini)、[Realtime 语音事件](https://developers.openai.com/api/docs/guides/realtime-conversations)。

## 本次上线验证

已通过公网 API 实际使用 Realtime 合成 WAV，再将生成音频交给 GPT-Transcribe 识别；核对 Worker 日账本与实际解码毫秒数及输入字符数一致，无残留预留。两个额度分别设为 0 后均返回 429，未产生新的上游调用账本。临时验证账号与关联数据已清理。
