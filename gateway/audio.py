"""Normalize uploads before quota accounting; never trust duration from a client."""

import io
import json
import wave
from starlette.requests import Request
from starlette.datastructures import UploadFile
from gateway.errors import Denied
from gateway.worker_openai import connection

ASR_MODEL = "gpt-transcribe"
TTS_MODEL = "gpt-realtime-2.1-mini"


def select_audio(request, model, service):
    trace = getattr(request.state, "inference_trace", {})
    if isinstance(model, str):
        trace["model"] = model[:128]
    expected = ASR_MODEL if service == "asr" else TTS_MODEL
    if model == expected:
        trace["provider"] = "openai"
        return True
    trace["provider"] = "local"
    if not request.app.state.settings.accounts_worker_url:
        return False
    provider = request.headers.get("x-inference-provider", "")
    if provider not in {"", "local", "openai"}:
        raise Denied(422, "X-Inference-Provider 应为 local 或 openai")
    local_models = {"asr": {"funasr", "paraformer"}, "tts": {"cosyvoice", "cosyvoice3"}}
    if provider == "local" or model in local_models[service]:
        return False
    trace["failure_stage"] = "validation"
    trace["error_code"] = "invalid_audio_model"
    raise Denied(
        422,
        f"请明确指定 model={expected} 调用云语音；旧自建接口请设置 X-Inference-Provider: local，不能用旧模型名自动调用 OpenAI",
    )


from gateway.audio_decode import transcode


async def prepare_asr(request, body):
    async def receive():
        return {"type": "http.request", "body": bytes(body), "more_body": False}

    clone = Request(request.scope, receive=receive)
    async with clone.form(max_files=1, max_fields=16) as form:
        request.state.inference_trace = getattr(request.state, "inference_trace", {})
        request.state.inference_trace["protocol"] = (
            "sse" if form.get("stream") == "true" else "http"
        )
        if not select_audio(request, form.get("model"), "asr"):
            return None
        allowed = {
            "file",
            "model",
            "language",
            "languages",
            "languages[]",
            "keywords",
            "keywords[]",
            "prompt",
            "response_format",
            "stream",
        }
        if any(k not in allowed for k in form):
            raise Denied(422, "语音识别包含未开放的字段")
        upload = form.get("file")
        if not isinstance(upload, UploadFile):
            raise Denied(422, "需要上传音频 file")
        if len(form.getlist("file")) != 1 or len(form.getlist("model")) != 1:
            raise Denied(422, "音频或模型字段不能重复")
        raw = await upload.read(21 * 1024 * 1024 + 1)
        if len(raw) > 21 * 1024 * 1024:
            raise Denied(413, "音频文件超过 21 MiB")
        origin, headers = connection(
            request.app, getattr(request.state, "audio_lease", None)
        )
        pcm = await transcode(raw)
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(pcm)
        values = [(k, v) for k, v in form.multi_items() if k != "file"]
        if any(not isinstance(v, str) for _, v in values):
            raise Denied(422, "识别参数必须为文本")
        # httpx multipart preserves repeated language/keyword fields.
        files = [("file", ("audio.wav", output.getvalue(), "audio/wav"))] + [
            (k, (None, v)) for k, v in values
        ]
        headers.pop("Content-Type", None)
        return request.app.state.client.build_request(
            "POST",
            origin + "/internal/openai/transcriptions",
            headers=headers,
            files=files,
            timeout=240,
        )


async def prepare_tts(request, body, lease):
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        if request.app.state.settings.accounts_worker_url:
            raise Denied(422, "语音合成需要 JSON 请求体和正确的 model")
        return None
    if not isinstance(payload, dict):
        raise Denied(422, "语音合成 JSON 必须为对象")
    if not select_audio(request, payload.get("model"), "tts"):
        return None
    origin, headers = connection(request.app, lease)
    streaming = payload.get("stream", False)
    if not isinstance(streaming, bool):
        raise Denied(422, "stream 必须为布尔值")
    getattr(request.state, "inference_trace", {})["protocol"] = (
        "audio-stream" if streaming else "http"
    )
    fmt = payload.get("response_format", "pcm")
    if fmt != "pcm":
        raise Denied(
            422,
            "云语音合成仅支持 response_format=pcm（24kHz、16-bit little-endian、单声道）",
        )
    payload["response_format"] = "pcm"  # Worker output uses trusted 24-kHz mono PCM.
    return request.app.state.client.build_request(
        "POST",
        origin + "/internal/openai/speech",
        headers=headers,
        json=payload,
        timeout=210,
    ), "stream-pcm" if streaming else fmt
