# 客户端接入入口

当前协议以 [客户端交接](client-handoff.md) 为准；账号和 API 域名分别为 accounts.hilex.me、api.hilex.me。公网 `/docs` 已关闭，接口说明随项目版本维护。

1. `GET https://accounts.hilex.me/auth/registration-info` 检查注册状态；用户主动调用 `POST /auth/registration-code` 发送验证码，再向 `POST /auth/register` 提交 email、password、六位字符串 code。验证码十分钟有效，至少六十秒后重发。
2. `POST /auth/login`，提交 username、password，保存 access_token、refresh_token 及有效期。
3. 模型请求使用 `Authorization: Bearer <access_token>` 和客户端配置的 `X-Client-ID`。管理员 API Key 可以单独调用，不需要 Client ID。
4. access token 过期后串行刷新并原子替换 token 对；不要并发复用旧 refresh token。
5. 登录后若 user.must_change 为真（当前通常为1），先改初始密码并重新登录；user.email_binding_required=true 时展示可稍后处理的绑定提醒，流程见[邮箱验证](email-verification.md)。
6. 模型发现使用 `GET https://api.hilex.me/v1/models?output_modalities=all`，按 endpoints、architecture 和 audio 能力选择调用方式。

| 用途 | 接口 | 模型 / 响应 |
|---|---|---|
| 文本、图片输入、函数调用 | POST /v1/chat/completions 或 /v1/responses | gpt-6-luna；Chat 工具调用使用 none，需要推理加工具使用 Responses |
| 文件识别 | POST /v1/audio/transcriptions | multipart，model=gpt-transcribe、file；支持 json/text 或 JSON SSE |
| 合成 | POST /v1/audio/speech | model=gpt-realtime-2.1-mini、input；仅原始 PCM，24kHz、16-bit little-endian、单声道 |
| 自建模型与语音 WebSocket | 依部署开放 | [自建语音协议](self-hosted-voice.md)，与云模型协议分开 |

云语音 CLI 无需 numpy/soundfile：

```bash
# 凭据通过 AI_ACCESS_TOKEN 或 AI_API_KEY 环境变量提供，不写入命令参数。
.venv-accounts/bin/python -m scripts.clients.client asr recording.wav
.venv-accounts/bin/python -m scripts.clients.client tts text.txt --output .runtime/tests/clients/tts.wav
```

TTS CLI 接收 PCM 流、缓存跨分片的半个样本，在客户端封装 WAV；失败保留错误并删除临时文件，不把半截音频当成完整文件。长文本需由调用方切分到每次 2000 字符以内。

流式响应必须检查完成/错误事件。Luna Chat 需要最终 usage 与 [DONE]，Responses 需要 response.completed；识别 SSE 需要 transcript.text.done。`provider_stream_interrupted` 表示未完整结束，不自动重试，不认为 HTTP 200 就已成功。取消会尽快停止上游，但已提交的未知用量仍可能保留预留。

个人额度与全站预算同时生效。全站 Luna 默认每月 200 美元估算预算，预算耗尽返回 global_budget_exhausted，不应自动重试；管理员可调整。地区限制为 provider_region_restricted，密钥异常为 provider_auth_failed，不应当作用户登录过期。

账号用量接口、完整示例及错误契约见 [客户端交接](client-handoff.md)、[Luna](luna-allowance.md)、[语音](audio-allowances.md)。旧域名迁移说明保留在 [历史单域名迁移](client-migration-single-api.md)，不作为新客户端的默认协议。


云模型目录只读鉴权，不计入个人日请求数或并发名额。通知按账号持久化检查时间，每天最多自动检查一次，手动进入列表可刷新；不因重新登录或恢复前台无条件请求。历史明细可能归档，不用有限的请求数组计算完整累计用量。最新错误表、资源策略和验收清单统一见[客户端交接](client-handoff.md)。

邮箱自助找回密码接口及 API Key 处理策略见[密码找回](password-recovery.md)，账号服务地址不变。
