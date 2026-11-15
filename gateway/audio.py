"""Normalize uploads before quota accounting; never trust duration from a client."""

import asyncio
import io
import json
import wave
from starlette.requests import Request
from starlette.datastructures import UploadFile
from accounts.store import Denied
from gateway.worker_openai import connection

ASR_MODEL = "gpt-transcribe"
TTS_MODEL = "gpt-realtime-2.1-mini"


async def transcode(data, *, encode=False, output_format="wav"):
    if encode and output_format == "wav":
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(24000)
            wav.writeframes(data)
        return output.getvalue()
    import imageio_ffmpeg

    cmd = [
        imageio_ffmpeg.get_ffmpeg_exe(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-threads",
        "1",
        "-protocol_whitelist",
        "pipe",
    ]
    if encode:
        cmd += ["-f", "s16le", "-ar", "24000", "-ac", "1"]
    cmd += [
        "-i",
        "pipe:0",
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "24000" if encode else "16000",
        "-t",
        "301",
    ]
    cmd += [
        "-f",
        {"mp3": "mp3", "opus": "ogg", "flac": "flac"}.get(output_format, output_format)
        if encode
        else "s16le",
        "pipe:1",
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(data), timeout=60)
    except BaseException:
        if proc.returncode is None:
            proc.kill()
        await proc.communicate()
        raise
    if proc.returncode or not out:
        raise Denied(400, "无法解码音频，请上传有效的 WAV、MP3、M4A 或 WebM 文件")
    if not encode and len(out) > 300 * 32000:
        raise Denied(413, "单次识别最多 5 分钟，请分段上传")
    return out


async def prepare_asr(request, body):
    async def receive():
        return {"type": "http.request", "body": bytes(body), "more_body": False}

    clone = Request(request.scope, receive=receive)
    async with clone.form(max_files=1, max_fields=16) as form:
        if form.get("model") != ASR_MODEL:
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
        return None
    if not isinstance(payload, dict) or payload.get("model") != TTS_MODEL:
        return None
    origin, headers = connection(request.app, lease)
    fmt = payload.get("response_format", "mp3")
    if fmt not in {"wav", "pcm", "mp3", "opus", "flac"}:
        raise Denied(422, "语音格式支持 wav、pcm、mp3、opus、flac")
    payload["response_format"] = "pcm"  # Worker output uses trusted 24-kHz mono PCM.
    return request.app.state.client.build_request(
        "POST",
        origin + "/internal/openai/speech",
        headers=headers,
        json=payload,
        timeout=210,
    ), fmt
