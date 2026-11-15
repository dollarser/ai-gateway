"""Bounded origin decoding only; no cloud credentials or account dependencies."""

import asyncio
from gateway.errors import Denied


async def transcode(data):
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
    cmd += [
        "-i",
        "pipe:0",
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-t",
        "301",
    ]
    cmd += ["-f", "s16le", "pipe:1"]
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
    if len(out) > 300 * 32000:
        raise Denied(413, "单次识别最多 5 分钟，请分段上传")
    return out
