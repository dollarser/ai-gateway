"""Cloud HTTP ASR/PCM TTS client. Self-hosted WebSocket demo: local_ws.py."""

import argparse
import os
import wave
from pathlib import Path
import httpx
from scripts.clients.client_auth import client_id
from scripts.clients.errors import require_success


def headers():
    credential = (
        os.environ.get("AI_ACCESS_TOKEN")
        or os.environ.get("SPEECH_ACCESS_TOKEN")
        or os.environ.get("AI_API_KEY")
        or os.environ.get("SPEECH_API_KEY")
    )
    if not credential:
        raise ValueError("Set AI_ACCESS_TOKEN or AI_API_KEY")
    result = {"Authorization": "Bearer " + credential}
    if credential.startswith("ai-at-"):
        result["X-Client-ID"] = client_id()
    return result


def write_pcm(stream, output):
    """HTTP boundaries may split samples; output a WAV only after complete samples."""
    leftover = b""
    with wave.open(str(output), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        for chunk in stream:
            chunk = leftover + chunk
            length = len(chunk) - len(chunk) % 2
            wav.writeframesraw(chunk[:length])
            leftover = chunk[length:]
        if leftover:
            raise ValueError("Incomplete 16-bit PCM sample")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["asr", "tts"])
    parser.add_argument("input", help="audio file for ASR; UTF-8 text file for TTS")
    parser.add_argument("--base-url", default="https://api.hilex.me/v1")
    parser.add_argument("--output", default=".runtime/tests/clients/tts.wav")
    parser.add_argument("--voice", default="marin")
    args = parser.parse_args()
    with httpx.Client(timeout=240, headers=headers()) as client:
        if args.mode == "asr":
            with Path(args.input).open("rb") as audio:
                response = client.post(
                    args.base_url.rstrip("/") + "/audio/transcriptions",
                    data={"model": "gpt-transcribe"},
                    files={
                        "file": (
                            Path(args.input).name,
                            audio,
                            "application/octet-stream",
                        )
                    },
                )
                require_success(response)
                print(response.json()["text"])
        else:
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            temporary = output.with_suffix(output.suffix + ".partial")
            try:
                with client.stream(
                    "POST",
                    args.base_url.rstrip("/") + "/audio/speech",
                    json={
                        "model": "gpt-realtime-2.1-mini",
                        "input": Path(args.input).read_text(),
                        "voice": args.voice,
                        "response_format": "pcm",
                        "stream": True,
                    },
                ) as response:
                    require_success(response)
                    if not response.headers.get("Content-Type", "").startswith(
                        "audio/pcm"
                    ):
                        raise ValueError("Expected PCM audio")
                    write_pcm(response.iter_bytes(), temporary)
                temporary.replace(output)
            finally:
                temporary.unlink(missing_ok=True)
            print(str(output))


if __name__ == "__main__":
    main()
