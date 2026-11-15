"""Bounded codec-only origin; provider keys and account decisions stay at edge."""

from fastapi import APIRouter, Request
from fastapi.responses import Response
from accounts.store import Denied
from gateway.edge_origin import trusted_edge
from gateway.audio import transcode
import io
import wave

router = APIRouter()


@router.post("/__codec/{operation}")
async def codec(operation: str, request: Request):
    if not trusted_edge(request.app, request.headers, request.scope):
        raise Denied(401, "编解码源站需要边缘服务认证")
    if operation == "stream-encode":
        from gateway.codec_stream import stream_encode

        return await stream_encode(request, request.headers.get("x-codec-format"))
    if operation not in {"decode", "encode"}:
        raise Denied(404, "未知编解码操作")
    limit = 21 * 1024 * 1024 if operation == "decode" else 16 * 1024 * 1024
    data = bytearray()
    async for part in request.stream():
        data.extend(part)
        if len(data) > limit:
            raise Denied(413, "编解码请求体过大")
    if operation == "decode":
        pcm = await transcode(bytes(data))
        out = io.BytesIO()
        with wave.open(out, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(pcm)
        return Response(out.getvalue(), media_type="audio/wav")
    fmt = request.headers.get("x-codec-format")
    if fmt not in {"mp3", "opus", "flac"} or len(data) % 2:
        raise Denied(422, "编解码格式无效")
    result = await transcode(bytes(data), encode=True, output_format=fmt)
    return Response(
        result,
        media_type={"mp3": "audio/mpeg", "opus": "audio/ogg", "flac": "audio/flac"}[
            fmt
        ],
    )
