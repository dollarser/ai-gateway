"""File ASR and text-generator TTS clients, no microphone dependencies."""

import argparse
import asyncio
import json
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import websockets
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.clients.client_auth import websocket_auth


async def run(args):
    url = args.url or f"wss://api.hilex.me/ws/{args.mode}"
    started = time.monotonic()
    async with websockets.connect(
        url, max_size=16 * 1024 * 1024, **websocket_auth(websockets.connect)
    ) as ws:
        ready = json.loads(await ws.recv())
        print(ready, flush=True)
        if ready.get("type") != "ready":
            raise RuntimeError(ready)
        if args.mode == "asr":
            audio, rate = sf.read(args.input, dtype="float32")
            if rate != 16000 or audio.ndim != 1:
                raise ValueError("input must be 16kHz mono WAV")
            pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()

            async def upload():
                for offset in range(0, len(pcm), 3200):
                    await ws.send(pcm[offset : offset + 3200])
                    if args.realtime:
                        await asyncio.sleep(0.1)
                await ws.send(json.dumps({"type": "end"}))

            sender = asyncio.create_task(upload())
            try:
                async for msg in ws:
                    event = json.loads(msg)
                    print(json.dumps(event, ensure_ascii=False), flush=True)
                    if event["type"] == "error":
                        raise RuntimeError(event)
            finally:
                await sender
        else:
            # Each line is an incremental fragment, submitted to ONE native call.
            fragments = Path(args.input).read_text().splitlines()

            async def upload():
                for fragment in fragments:
                    await ws.send(json.dumps({"type": "text", "text": fragment}))
                    await asyncio.sleep(args.delay)
                await ws.send(json.dumps({"type": "end"}))

            sender = asyncio.create_task(upload())
            chunks, first = [], None
            try:
                async for msg in ws:
                    if isinstance(msg, bytes):
                        if first is None:
                            first = time.monotonic() - started
                            print(f"first_audio_seconds={first:.3f}", flush=True)
                        chunks.append(msg)
                    else:
                        event = json.loads(msg)
                        print(event, flush=True)
                        if event["type"] == "error":
                            raise RuntimeError(event)
                        if event["type"] == "done":
                            break
            finally:
                await sender
            if not chunks:
                raise RuntimeError("no audio produced")
            pcm = np.frombuffer(b"".join(chunks), dtype="<i2")
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            sf.write(args.output, pcm, ready["sample_rate"], subtype="PCM_16")
            print(
                json.dumps(
                    {
                        "audio_chunks": len(chunks),
                        "audio_seconds": len(pcm) / ready["sample_rate"],
                        "wall_seconds": time.monotonic() - started,
                        "output": args.output,
                    }
                )
            )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["asr", "tts"])
    parser.add_argument("input", help="16kHz mono WAV for ASR; UTF-8 text file for TTS")
    parser.add_argument("--url", help="Override the public gateway WebSocket URL")
    parser.add_argument("--output", default="artifacts/tts.wav")
    parser.add_argument("--delay", type=float, default=0.2)
    parser.add_argument("--realtime", action="store_true")
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
