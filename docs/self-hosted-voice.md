> 仅适用于已启动的自建 ASR/TTS，不适用于 gpt-transcribe 或 gpt-realtime-2.1-mini。云语音统一使用 HTTP，见 [客户端交接](client-handoff.md)。

# 自建语音 WebSocket 协议

### 鉴权

Android 和其他非浏览器客户端必须同时发送 `Authorization: Bearer <access_token>` 和 `X-Client-ID: <client_id>` 请求头。
浏览器的 WebSocket API 不能设置自定义请求头，使用子协议：

```javascript
const socket = new WebSocket(
  "wss://api.hilex.me/ws/tts",
  ["speech", "access-token." + accessToken, "client-id." + clientId]
);
socket.binaryType = "arraybuffer";
```

服务器只回选 `speech`，不会回显包含登录凭证的子协议。不要把登录 token 放在 URL 查询参数或日志中，也不要把共享服务端凭证打包进前端代码。

连接后首先等待 `ready`：

```json
{"type":"ready","sample_rate":24000,"format":"s16le","channels":1}
```

ASR 的 `sample_rate` 为 16000；TTS 当前为 24000。二进制音频均为**单声道、16 位有符号、小端 PCM**，不是带头 WAV。

### ASR 输入与输出

- 持续发送 16kHz PCM16 二进制帧，建议每帧 100ms，即 3200 字节。
- 最后发送 `{"type":"end"}`，等待 `final`，然后关闭连接。
- 返回 `partial` / `final` JSON：`delta` 是本块新增文字，`text` 是当前会话累计文字；不要再次把累计 `text` 拼接。
- 一个连接用于一次听写会话；下一段新会话重新连接。单帧最多 10 秒，输入空闲超时 60 秒。

```json
{"type":"partial","delta":"你好","text":"你好"}
{"type":"final","delta":"世界","text":"你好世界"}
```

### TTS 输入与输出

- 可持续发送 `{"type":"text","text":"你好，"}`，将 Agent 新生成的片段逐次输入。
- 文字全部发送完后发送 `{"type":"end"}`。
- 同时接收二进制 PCM 音频，直到 `{"type":"done"}`。
- 输出前会有原生模型缓冲，不保证每个文本片段立刻产生音频。
- 单片段最多 2000 字符、整个会话最多 20000 字符、输入队列最多 128 条；输入空闲超时 60 秒。
- 服务错误通过 `{"type":"error","message":"..."}` 返回；握手失败或非正常关闭也必须按失败处理。

统一网关每个 WebSocket 会话最长 15 分钟、累计输入最多 21MiB。原生 ASR/TTS 服务也执行各自限制。
连接关闭后模型可能仍在收尾，短时间内重新连接仍可能遇到忙状态，客户端应退避重试。

### 忙碌、错误与取消契约

- HTTP ASR/TTS 共用各自的单模型执行位，按 FIFO 排队；默认最多 8 个等待请求，等待期限 45 秒。`SPEECH_QUEUE_SIZE` / `SPEECH_QUEUE_TIMEOUT` 可调整。
- 队满或等待超时：HTTP 503，`Retry-After: 2`，JSON `detail.code` 分别为 `model_queue_full` / `model_queue_timeout`。账号并发限制仍可能先返回 429，不能把账号并发数当作模型并行数。
- HTTP 客户端断开后，尚在排队的请求会取消；已经进入原生推理的请求持有执行位直到推理结束。网关等待语音后端首响应最多 180 秒。
- WebSocket 不排队，连接建立不代表模型就绪，必须等待 `ready`；模型忙时关闭码 1013，建议退避加随机抖动后重新连接。
- 无凭证或凭证无效：握手 HTTP 403。已连接后输入格式错误或输入空闲超时：`error` JSON 后关闭码 1008。网关异常或会话超时关闭码 1011。
- 网关保留后端关闭码和原因；正常关闭码为 1000。ASR 必须收到 `final`、TTS 必须收到 `done` 才算成功，即使连接以 1000 关闭也不能省略终态检查。
- 用户取消时客户端关闭连接，停止发送和播放，清空本地缓冲。下一次请求新建连接；不要向旧会话重复发送此前音频或累计文字。
- ASR 最后一个音频块只刷新一次；`text` 始终覆盖显示，`delta` 才可追加。TTS 收发必须并行，不能等发送 `end` 后才开始读取音频。

### Python：TTS 增量文字输入，保存 WAV

以下示例使用前述 `websockets==12.0`。使用其他版本时，注意其请求头参数可能改为 `additional_headers`。

```python
import asyncio
import json
import os
import wave
import websockets

async def main():
    headers = {"Authorization": "Bearer " + os.environ["AI_ACCESS_TOKEN"],
               "X-Client-ID": os.environ["AI_CLIENT_ID"]}
    async with websockets.connect(
        "wss://api.hilex.me/ws/tts",
        extra_headers=headers,
        user_agent_header="my-ai-client/1.0",
        max_size=16 * 1024 * 1024,
    ) as ws:
        ready = json.loads(await ws.recv())
        if ready.get("type") != "ready":
            raise RuntimeError(ready)

        async def send_text():
            # 实际应用中替换为 Agent 的增量文字流。
            for fragment in ["你好，", "这里是原生双流语音合成测试。"]:
                await ws.send(json.dumps({"type": "text", "text": fragment}))
                await asyncio.sleep(0.2)
            await ws.send('{"type":"end"}')

        sender = asyncio.create_task(send_text())
        complete = False
        try:
            with wave.open("speech-stream.wav", "wb") as wav:
                wav.setnchannels(ready["channels"])
                wav.setsampwidth(2)
                wav.setframerate(ready["sample_rate"])
                async for message in ws:
                    if isinstance(message, bytes):
                        wav.writeframes(message)
                    else:
                        event = json.loads(message)
                        if event["type"] == "error":
                            raise RuntimeError(event["message"])
                        if event["type"] == "done":
                            complete = True
                            break
            if not complete:
                raise RuntimeError("连接在 done 前关闭，音频可能不完整")
            await sender
        finally:
            if not sender.done():
                sender.cancel()
            await asyncio.gather(sender, return_exceptions=True)

asyncio.run(main())
```

本仓库的文件客户端需要安装可选依赖，默认连接公网网关；不需要模型运行环境或模型目录：

```bash
.venv-accounts/bin/python -m pip install -e '.[clients]'
# input.wav 为自行准备的 16kHz 单声道 WAV。
# 登录令牌方式还需设置 SPEECH_CLIENT_ID；API Key 方式无需 Client ID。
AI_ACCESS_TOKEN="$AI_ACCESS_TOKEN" SPEECH_CLIENT_ID="$AI_CLIENT_ID" \
  .venv-accounts/bin/python -m scripts.clients.local_ws asr input.wav

AI_API_KEY="$AI_API_KEY" .venv-accounts/bin/python -m scripts.clients.local_ws \
  tts demo.txt --output speech.wav
```

模型环境和示例模型数据由独立的 model-serving 项目管理。

