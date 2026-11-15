"""Backpressured PCM-to-compressed streaming; no whole-audio input buffer."""

import asyncio
from async_timeout import timeout
from fastapi.responses import StreamingResponse
from accounts.store import Denied


async def stream_encode(request, fmt):
    import imageio_ffmpeg

    formats = {
        "mp3": ("mp3", "libmp3lame", "audio/mpeg"),
        "opus": ("ogg", "libopus", "audio/ogg"),
        "flac": ("flac", "flac", "audio/flac"),
    }
    if fmt not in formats:
        raise Denied(422, "不支持流式编码格式")
    container, codec, mime = formats[fmt]
    cmd = [
        imageio_ffmpeg.get_ffmpeg_exe(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-threads",
        "1",
        "-probesize",
        "32",
        "-analyzeduration",
        "0",
        "-f",
        "s16le",
        "-ar",
        "24000",
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-map",
        "0:a:0",
        "-c:a",
        codec,
    ]
    if fmt == "opus":
        cmd += ["-page_duration", "20000"]
    cmd += ["-flush_packets", "1", "-f", container, "pipe:1"]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )

    async def upload():
        size = 0
        try:
            async with timeout(200):
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > 16 * 1024 * 1024:
                        raise Denied(413, "合成音频超过编码上限")
                    proc.stdin.write(chunk)
                    await proc.stdin.drain()
            if not size or size % 2:
                raise Denied(422, "PCM 数据长度无效")
        finally:
            proc.stdin.close()

    sender = asyncio.create_task(upload())

    async def output():
        try:
            async with timeout(205):
                while True:
                    chunk = await proc.stdout.read(16384)
                    if not chunk:
                        break
                    yield chunk
                await sender
                if await proc.wait():
                    raise RuntimeError("Audio encoder failed")
        finally:
            sender.cancel()
            if proc.returncode is None:
                proc.kill()
            await asyncio.gather(sender, return_exceptions=True)
            await proc.wait()

    class DuplexResponse(StreamingResponse):
        async def listen_for_disconnect(self, receive):
            # Upload owns receive until EOF; a second consumer could steal PCM.
            try:
                await asyncio.shield(sender)
            except Exception:
                return
            await super().listen_for_disconnect(receive)

    return DuplexResponse(
        output(),
        media_type=mime,
        headers={
            "Cache-Control": "no-store",
            "X-Audio-Processing": "origin-stream-encode",
        },
    )
