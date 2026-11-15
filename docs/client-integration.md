# 统一 AI 服务客户端接入文档

> 2026-10-28：全部模型推理统一使用 api.hilex.me；旧 ASR/TTS 域名已停用。客户端配置和 WebSocket 迁移步骤见 [单域名迁移文档](client-migration-single-api.md)。
当前推荐流程是 **邮箱注册 → 账号登录 → 自动使用登录凭证调用 LLM、ASR、TTS**。Android 用户不需要创建、复制或手动配置 API Key。模型调用必须同时带登录凭证和应用 Client ID；Client ID 由应用配置，沿用现有 Qwen3.8 的白名单值，不需终端用户填写。API Key 暂时保留给管理员管理的服务端或脚本集成。

## 1. 服务地址

| 用途 | 地址 |
|---|---|
| 注册、登录和账号管理 | https://accounts.hilex.me/ |
| LLM API Base URL | `https://api.hilex.me/v1` |
| ASR 文件识别 | `https://api.hilex.me/v1/audio/transcriptions` |
| TTS 文字合成 | `https://api.hilex.me/v1/audio/speech` |
| ASR WebSocket | `wss://api.hilex.me/ws/asr` |
| TTS WebSocket | `wss://api.hilex.me/ws/tts` |
| ASR / TTS 在线接口文档 | https://api.hilex.me/docs · https://api.hilex.me/docs |

全部公网调用使用 HTTPS / WSS。ASR 和 TTS 只支持本文列出的字段，不等同于完整 OpenAI Audio API。

## 2. Android 与普通用户的接入流程

1. 调用 `POST /auth/register`，用邮箱和至少 6 字符的密码注册；无需管理员审批。
2. 调用 `POST /auth/login`。客户端自动保存返回的 `access_token` 和 `refresh_token`。
3. 所有模型请求由客户端自动添加以下两项，缺一不可：

```http
Authorization: Bearer <access_token>
X-Client-ID: <client_id>
```

4. access token 有效期 15 分钟。失效后用 refresh token 调用 `/auth/refresh`，原子替换返回的新 token 对，然后最多重试一次原请求。
5. 退出时调用 `/auth/logout` 并清除本机凭证。可直接提交 refresh token，即使 access token 已过期也能退出。

不要把邮箱和密码附在每一次模型请求中，也不要把 refresh token 当作 access token。登录 token 是不可解析的随机凭证，不是需要客户端解码的 JWT。

**邮箱当前只做格式校验，不发送验证码、不验证邮箱归属、不提供邮件找回密码。** 忘记密码时联系管理员。邮箱大小写不区分；旧用户名账号仍可登录。

## 3. 默认额度

| 项目 | 初始默认值 | 含义 |
|---|---:|---|
| 每分钟请求 | 30 | LLM、ASR、TTS 合计 |
| 每日请求 | 1000 | 北京时间每天零点重置 |
| 总并发 | 2 | 三项服务合计的在途请求 / 会话数 |

- 额度绑定账号；同账号多次登录、多个设备和管理员为其配置的 API Key 共用额度。
- `GET /v1/models` 计一次请求；WebSocket 会话计一次请求并持续占用并发。
- 请求在鉴权和额度检查通过时计数，此后上游返回模型忙或其他错误仍计数；账号层拒绝的请求不计入已接纳请求。
- 登录、刷新、注册和查看账号信息不扣模型请求额度，但登录和注册有独立的来源频率限制。
- 额度单位是请求数，不是 token、音频秒数或金额。
- ASR/TTS 每个原生后端只执行一个活跃模型会话；HTTP 在有界队列等待，队满或等待超时返回 `503`，WebSocket 忙时以 `1013` 关闭。
- 管理员可修改新注册用户的默认额度，也可独立调整现有用户。默认值变化不会覆盖已有账号，额度调整不清零用量。

当前注册默认值可公开查询：

```bash
curl https://accounts.hilex.me/auth/registration-info
```

本人当前额度以登录后的 `GET /account/me` 为准。

## 4. 注册、登录、刷新和退出 API

以下接口位于 `https://accounts.hilex.me`。

| 接口 | 用途 | 认证 |
|---|---|---|
| `POST /auth/register` | 邮箱注册，成功 201 | 无登录要求 |
| `POST /auth/login` | 登录并取得 token 对 | 邮箱 / 用户名和密码 |
| `POST /auth/refresh` | 轮换 token 对 | 请求体中的 refresh token |
| `POST /auth/logout` | 撤销当前登录及其 token | access token，或请求体中的 refresh token |
| `GET /account/me` | 当前用户、权限、额度 | Bearer access token |
| `GET /account/usage` | 当日汇总及最近 100 条请求 | Bearer access token |
| `POST /account/password` | 修改本人密码 | Bearer access token |

注册、登录、刷新和账号管理接口不要求 Client ID；公网 `/v1/*` 模型接口和语音 WebSocket：账号 access_token 必须搭配 Client ID，管理员 API Key 可单独调用。Android 不需要 CookieJar，也不需要 CSRF token。登录仍会返回 Cookie 和 `csrf`，供现有管理网页兼容使用；Android 可以忽略。浏览器 Cookie 模式的写操作仍需 `X-CSRF-Token`，不能取消它。

### 注册

```json
{"email":"you@example.com","password":"至少6字符的自选密码"}
```

注册成功不自动登录。新用户默认是普通用户，拥有三项服务权限，不能自选管理员角色或额度。注册用户自选密码，不要求首次登录再次修改密码。

### 登录

请求字段名为 `username`，值可以是注册邮箱：

```json
{"username":"you@example.com","password":"你的密码"}
```

成功响应包含：

```json
{
  "token_type": "Bearer",
  "access_token": "ai-at-登录访问凭证",
  "expires_in": 900,
  "refresh_token": "ai-rt-刷新凭证",
  "refresh_expires_in": 2592000,
  "user": {
    "id": 123,
    "username": "you@example.com",
    "email": "you@example.com",
    "role": "user",
    "services": ["asr", "qwen", "tts"],
    "rpm": 30,
    "daily_requests": 1000,
    "concurrency": 2,
    "must_change": 0
  },
  "csrf": "仅Cookie网页模式使用的值"
}
```

有效期以每次返回的秒数为准。refresh token 对应本次登录，最长 30 天；刷新不会延长这次登录的绝对 30 天期限。多个登录有独立的 refresh token。

`must_change` 为 1 的管理员创建账号，应先调用改密码接口，再重新登录；此时不允许模型调用。

### 刷新

```http
POST /auth/refresh
Content-Type: application/json

{"refresh_token":"当前refresh_token"}
```

响应包含新 `access_token`、新 `refresh_token`、`token_type` 和两种剩余有效期。

**refresh token 单次使用，轮换后必须保存新值。** 再次使用旧 refresh token 会触发重放保护，撤销该次登录的整个 token 组。不要让多个并发请求各自刷新；Android 应使用全局单例和刷新锁，并在锁内确认其他请求是否已经完成刷新。

刷新本身不要自动重试。若响应丢失，服务端可能已完成轮换，建议重新登录，而非重复提交旧 refresh token。普通模型请求只在收到 401 时进行一次刷新、一次重试；403 / 429 不应触发刷新。

刷新成功后旧 access token 在其原有效期内仍可用于在途并发请求；退出、改密码、账号禁用或重放保护会立即使该登录下所有 access token 无效。

### 退出

推荐 Android 使用：

```http
POST /auth/logout
Content-Type: application/json

{"refresh_token":"当前refresh_token"}
```

也可带 `Authorization: Bearer <access_token>` 并不传请求体。退出只撤销这次登录，不退出其他设备。
改密码、管理员重置密码或禁用账号会撤销该账号所有登录。改密码保留管理员配置的 API Key；管理员重置密码同时撤销这些 Key。
退出失败时本机仍应清除 token，但不能宣称服务端已完成撤销。

### Python：验证与 Android 相同的无 Cookie 流程

```bash
uv venv --python 3.10
uv pip install --python .venv/bin/python httpx==0.28.1 websockets==12.0
```

```python
import getpass
import os
import httpx

base = "https://accounts.hilex.me"
client_id = os.environ["AI_CLIENT_ID"]  # 应用配置，由服务管理者提供
email = input("邮箱：").strip()
password = getpass.getpass("密码：")

with httpx.Client(headers={"User-Agent": "my-ai-client/1.0"}, timeout=30) as client:
    # 新用户先单独调用 /auth/register；已有账号直接登录。
    response = client.post(base + "/auth/login", json={"username": email, "password": password})
    response.raise_for_status()
    login = response.json()
    client.cookies.clear()  # 演示不依赖 Cookie
    if login["user"]["must_change"]:
        raise RuntimeError("先修改初始密码，再重新登录")
    access_token = login["access_token"]
    refresh_token = login["refresh_token"]
    models = client.get("https://api.hilex.me/v1/models", headers={
        "Authorization": "Bearer " + access_token, "X-Client-ID": client_id,
    })
    if models.status_code == 401:
        renewed = client.post(base + "/auth/refresh", json={"refresh_token": refresh_token})
        renewed.raise_for_status()
        tokens = renewed.json()
        access_token, refresh_token = tokens["access_token"], tokens["refresh_token"]
        models = client.get("https://api.hilex.me/v1/models", headers={
            "Authorization": "Bearer " + access_token, "X-Client-ID": client_id,
        })
    models.raise_for_status()
    print(models.json())
    client.post(base + "/auth/logout", json={"refresh_token": refresh_token}).raise_for_status()
```

下面 curl 示例使用 `$AI_ACCESS_TOKEN`，表示客户端登录后自动取得的值，不是要求 Android 用户手动配置。密码不要写进模型请求、公开代码或日志。

## 5. LLM：Qwen

环境变量 `AI_ACCESS_TOKEN` 在命令行示例中表示登录返回的 access token。模型调用还须通过 `AI_CLIENT_ID` 配置应用 Client ID，并发送 `X-Client-ID`。

模型列表（默认仅文本输出；完整发现使用 `?output_modalities=all`，用途读取 `architecture.output_modalities`，详见 [模型发现](model-discovery.md)）：

```bash
curl https://api.hilex.me/v1/models \
  -H "Authorization: Bearer $AI_ACCESS_TOKEN" -H "X-Client-ID: $AI_CLIENT_ID"
```

普通回答：

```bash
curl https://api.hilex.me/v1/chat/completions \
  -H "Authorization: Bearer $AI_ACCESS_TOKEN" -H "X-Client-ID: $AI_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{"model":"Qwen3.8-27B","messages":[{"role":"user","content":"你好"}],"max_tokens":256,"reasoning_effort":"low","stream":false}'
```

SSE 流式输出：

```bash
curl -N https://api.hilex.me/v1/chat/completions \
  -H "Authorization: Bearer $AI_ACCESS_TOKEN" -H "X-Client-ID: $AI_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{"model":"Qwen3.8-27B","messages":[{"role":"user","content":"介绍一下语音识别"}],"max_tokens":512,"reasoning_effort":"low","stream":true}'
```

按 SSE 事件解析 `data:`，不要假定一个 TCP 数据块就是完整 JSON。`data: [DONE]` 表示正常完成；中途断流不能当成完整回答。思考强度和模型名以鉴权后的 `/v1/models` 返回配置为准。

## 6. ASR：音频文件上传

```bash
curl --fail-with-body https://api.hilex.me/v1/audio/transcriptions \
  -H "Authorization: Bearer $AI_ACCESS_TOKEN" -H "X-Client-ID: $AI_CLIENT_ID" \
  -F 'file=@audio.wav'
```

上传字段为 `file`，由客户端自动生成 multipart boundary，不要手工覆盖为 `application/json`。
推荐 16kHz 单声道 WAV；接口也支持 libsndfile 能解码的 WAV / FLAC / OGG，并自动混为单声道、重采样至 16kHz。
文件最多 20MiB、音频时长最多 120 秒，输入采样率 8～192kHz、最多 8 声道。

响应示例：

```json
{"text":"你好这里是本地语音服务","language":"zh","sample_rate":16000,"audio_seconds":3.88}
```

`language` 是当前中文 ASR 路径的标记，不是单独进行语言检测的结果。HTTP 等完整文件上传后返回识别结果；持续听写使用下一节的 WebSocket。

## 7. TTS：文字转 WAV

```bash
curl --fail-with-body https://api.hilex.me/v1/audio/speech \
  -H "Authorization: Bearer $AI_ACCESS_TOKEN" -H "X-Client-ID: $AI_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{"input":"你好，这是语音合成测试。"}' \
  -o speech.wav
```

`input` 是 1～2000 字符的非空白文字。成功返回 `Content-Type: audio/wav`，当前为 24kHz、单声道 PCM16 WAV；应以文件头中的采样率为准。
这是整段文字输入、完整 WAV 返回的接口。Agent 文字尚未生成完时，应改用 TTS WebSocket，不能把 HTTP 分句请求视作同一个原生双流会话。

客户端应先检查 HTTP 状态再把内容当作音频播放；失败响应可能是 JSON。首次模型请求存在冷启动开销，建议客户端为完整合成配置至少 180 秒的请求超时；这不表示保证在该时限内完成。

## 8. WebSocket 协议

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
  .venv-accounts/bin/python -m scripts.clients.client asr input.wav

AI_API_KEY="$AI_API_KEY" .venv-accounts/bin/python -m scripts.clients.client \
  tts demo.txt --output speech.wav
```

模型环境和示例模型数据由独立的 model-serving 项目管理。

## 9. 错误处理和重试

| 情况 | 状态 / 表现 | 客户端处理 |
|---|---|---|
| Client ID 缺失/无效，或账号凭证失效 | HTTP 401 | 先检查 Client ID 配置；若是 token 过期则刷新一次 |
| 账号禁用、服务权限不足、CSRF / Origin 错误 | HTTP 403 | 检查账号、权限或登录流程 |
| 路径错误 | HTTP 404 | 检查域名和接口路径 |
| 邮箱已注册 | 注册 HTTP 409 | 使用现有邮箱登录 |
| 模型队满或等待超时 | HTTP 503 + Retry-After；WS 忙时关闭 1013 | 短暂退避并限制重试次数 |
| 文件或请求体太大 | HTTP 413 | 缩短音频 / 缩小请求 |
| 无效字段、邮箱格式或密码长度 | HTTP 422 | 修正请求内容 |
| 无效音频、空文字等 | HTTP 400 | 修正输入，不重试相同坏数据 |
| 请求频率、每日请求数、并发或注册/登录限额 | HTTP 429 | 读取错误说明与 `Retry-After`，按对应窗口等待 |
| 上游不可用 / 超时 / 后端提前关闭 | HTTP 502；WS 可能关闭 1011 | 有界退避；避免重试风暴 |
| WebSocket 鉴权失败 | 握手 HTTP 403 | 建连前检查 token 到期时间并刷新；仍失败则检查登录/权限，不要循环重连 |

日额度用尽需等北京时间下一天或由管理员提高额度。登录限制为同来源地址 5 分钟最多 10 次；注册限制为同来源地址每小时最多 5 次尝试，另有全站每小时 100 次尝试的保护。
这些“尝试”包含重复邮箱等失败操作。频繁点击注册或登录也可能触发限制。

请求已发送后断网，服务端可能已开始生成并计数。当前没有幂等请求去重；客户端应向用户显示中断状态，避免自动无限重发并产生重复调用。
不要把成功之前接收到的音频片段当作完整音频，或将 SSE 连接关闭误当成正常结束。

## 10. 管理员配置额度

在账号中心以管理员登录：

- 「账号管理 → 新注册用户的默认额度」：设置之后注册用户的 RPM、每日请求和总并发。
- 用户列表的「编辑」：独立调整某个用户的权限、每分钟请求、每日请求和总并发。
- 禁用用户会阻止后续调用；不会强制杀掉正在执行的推理。

管理 API 需要管理员登录 access token，或管理员 Cookie 和 `X-CSRF-Token`；不能用 API Key 管理账号。下面展示 Cookie 模式：

```http
GET /admin/registration-defaults
PATCH /admin/registration-defaults
Content-Type: application/json
X-CSRF-Token: <csrf>

{"rpm":30,"daily_requests":1000,"concurrency":2}
```

修改单个用户：

```http
PATCH /admin/users/123
Content-Type: application/json
X-CSRF-Token: <csrf>

{"rpm":60,"daily_requests":3000,"concurrency":3}
```

允许的配置范围：RPM 1～600、每日请求 1～1000000、总并发 1～8；没有用 0 表示无限额度的配置。

## 11. 强制双重校验与旧调用迁移

公网账号 token 调用要求“access_token AND Client ID”：仅 Client ID、仅 access token、错误的 Client ID 都返回 401；WebSocket 在握手阶段拒绝。API Key 单独调用是独立认证分支。
仅 Client ID 调用不接受。管理员 API Key（`sk-acct-...`）和已迁移的旧 Qwen Key（`sk-qw-...`）可单独调用，不需要 `X-Client-ID`。
Client ID 不是用户身份，也不能代替登录。该标识内置在 Android App 中仍可被提取，因此不是独立的秘密凭证。账号权限、额度和禁用状态仍由服务端校验。
本机统一免鉴权入口为 `http://127.0.0.1:18901`，仅推理免鉴权；原 Qwen 网关已合并并停用。详见 [统一网关](unified-gateway.md)。

## 12. 管理员专属 API Key

API Key 调用暂时保留，所有 Key 的创建、列表和撤销接口只允许管理员访问。普通用户访问返回 403；登录调用不需要偷偷创建一个内部 API Key。

管理员使用自己的登录 access token，或管理网页 Cookie + CSRF：

| 接口 | 用途 |
|---|---|
| `GET /admin/keys/{user_id}` | 列出该用户的 Key 元数据 |
| `POST /admin/keys/{user_id}` | 为该用户配置 Key |
| `DELETE /admin/keys/{key_id}` | 撤销 Key |
| `/account/keys` 的 GET / POST / DELETE | 仅管理员可用的兼容路径 |

创建请求：`{"name":"server-integration","services":["qwen","asr","tts"],"days":90}`。
有效期 1～365 天，服务权限不能超出目标账号。明文只显示一次，管理员需安全交付和保管。
Key 调用只需 `Authorization: Bearer sk-acct-...` 或 `X-API-Key: sk-acct-...`，与该账号登录 token 共用请求额度；不能用 API Key 登录账号管理接口。

## VibeVoice-ASR：仅本机

VibeVoice 不对外提供服务。公网 `/v1/audio/transcriptions/vibevoice` 即使携带有效账号或 API Key 也返回 404。仅本机使用 `http://127.0.0.1:18769/v1/audio/transcriptions`，无需认证；大文件限制和模型策略见独立 model-serving 项目的 README。
